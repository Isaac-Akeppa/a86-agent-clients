# Agente 86 — bot "Max"

Asistente virtual de Agente 86 (seguros de auto). Valida al cliente por el número de
serie (VIN) de su vehículo contra una API externa, responde dudas sobre su póliza con
los datos reales que esa API devuelve, puede enviarle el PDF de su póliza, y clasifica
la conversación en Chatwoot cuando algo requiere seguimiento humano.

> Este documento se actualiza junto con el código. Si cambias el flujo, las
> herramientas, el prompt o las rutas, actualiza la sección correspondiente aquí mismo.

## Índice
- [Qué hace el bot](#qué-hace-el-bot)
- [Flujo de una conversación](#flujo-de-una-conversación)
- [Clasificación para Chatwoot](#clasificación-para-chatwoot)
- [Arquitectura](#arquitectura)
- [Endpoints HTTP](#endpoints-http)
- [Variables de entorno](#variables-de-entorno)
- [Estructura del proyecto](#estructura-del-proyecto)
- [Persistencia](#persistencia)
- [Integración con n8n / Chatwoot](#integración-con-n8n--chatwoot)
- [Placeholders pendientes](#placeholders-pendientes)
- [Fuera de alcance (por ahora)](#fuera-de-alcance-por-ahora)

## Qué hace el bot

1. **Valida la identidad del cliente por el número de serie (VIN)** de su vehículo,
   contra una API externa, antes de ayudar con cualquier otra cosa.
2. **Responde preguntas sobre la póliza** (vigencia, coberturas, primas, recibos
   pendientes, datos del vehículo, etc.) usando únicamente los datos reales que esa
   API devuelve — nunca inventa ni completa información.
3. **Envía el PDF de la póliza** cuando el cliente lo pide explícitamente y el
   documento está disponible.
4. **Clasifica la conversación** en una de tres categorías (`administrativo`,
   `operativo`, `siniestros`) para que un humano le dé seguimiento en Chatwoot,
   pero SOLO cuando el bot no puede resolver la solicitud por sí mismo.
5. **Detecta el reporte de un siniestro nuevo** y, en vez de clasificarlo, le da al
   cliente el teléfono para reportarlo (ver [placeholders](#placeholders-pendientes)).
6. Mantiene un tono cercano y cálido: tutea siempre, sin lenguaje corporativo, con
   1 emoji por mensaje.

Todavía **no existe una base de conocimientos** (información general de la empresa,
trámites detallados, requisitos, etc.) — por ahora la única fuente de información real
es la API de validación de pólizas. Eso se agregará en un paso posterior.

## Flujo de una conversación

Toda la lógica de comportamiento vive en el system prompt
([src/ai/system-prompt.ts](src/ai/system-prompt.ts)), no en código. Resumen del flujo:

1. **Sin validar**: ante cualquier mensaje, la única respuesta visible del bot es
   pedir el número de serie (VIN) del vehículo — no da información de ningún tipo
   hasta tenerlo. Única excepción: el reporte de un siniestro nuevo (punto 5 abajo).
2. **Validación**: en cuanto el cliente da un VIN, el bot llama la herramienta
   `verificarNumeroSerie`, que consulta la API externa (ver
   [`car-verify-api.ts`](src/ai/tools/car-verify-api.ts)):
   - **Encontrada** → el cliente queda validado para el resto de la conversación
     (no se le vuelve a pedir el VIN) y el bot recibe todos los datos reales de la
     póliza.
   - **No encontrada** → se le pide verificar el número y reenviarlo.
   - **Error técnico** → se le informa que hubo un problema y que lo intente más
     tarde, sin exponer detalles técnicos.
3. **Respuestas sobre la póliza**: una vez validado, el bot responde únicamente el
   dato puntual que el cliente pregunta (nunca vuelca todo el JSON), y dice
   explícitamente que no tiene un dato si viene vacío en vez de inventarlo.
4. **Envío del documento**: si el cliente pide el PDF de su póliza y la API entregó
   una URL de descarga, el bot lo menciona en prosa (sin escribir el link) y el
   backend adjunta el archivo real en la respuesta HTTP.
5. **Clasificación** (ver sección siguiente): ocurre en paralelo a todo lo anterior,
   de forma silenciosa — nunca es parte de lo que el cliente lee.

## Clasificación para Chatwoot

El bot etiqueta la conversación **solo cuando algo requiere que un humano intervenga**.
Si el bot puede responder la pregunta directamente con los datos de la API (una
consulta puntual: vigencia, coberturas, montos, fechas, recibos, etc.), **no clasifica
nada** — no hay para qué, no hay seguimiento humano que hacer.

| Categoría | Cuándo aplica | Ejemplos |
|---|---|---|
| `operativo` | El cliente quiere cotizar, modificar, renovar, cancelar o emitir una póliza | "quiero cancelar mi póliza", "necesito renovar", "quiero cotizar un seguro para otro auto" |
| `administrativo` | El cliente pide una **acción** relacionada con dinero (no solo una pregunta) | "necesito factura de mi pago", "quiero que me devuelvan mi dinero", "avísenme antes de que venza mi pago" |
| `siniestros` | Seguimiento a un siniestro/caso **ya abierto** | "¿cómo va mi expediente?", "ya mandé mis documentos, qué sigue", "¿cuándo entra mi carro a reparación?" |

**Excepción importante — siniestro nuevo**: si el cliente da señales de estar
reportando un accidente que *acaba de pasar* ("choqué", "me robaron el carro", "tuve
un accidente"), el bot **no** lo clasifica como `siniestros` (esa categoría es solo
para seguimiento a casos ya abiertos). En vez de eso responde de inmediato con el
teléfono para reportarlo, incluso antes de validar el VIN.

Cuando el bot clasifica `operativo` o `administrativo`, su respuesta visible se limita
a reconocer la solicitud y decir que el equipo de Agente 86 le dará seguimiento — no
inventa plazos, pasos ni teléfonos, porque todavía no conoce el procedimiento real
para esos trámites.

La clasificación se registra con la herramienta `clasificarConversacion`
([clasificar-conversacion.ts](src/ai/tools/clasificar-conversacion.ts)), se persiste
por sesión en SQLite, y viaja en el campo `classification` de la respuesta de
`/ai/chat` para que el flujo de n8n la use al etiquetar la conversación en Chatwoot.

**Las 3 categorías y sus disparadores exactos son un punto de partida** — se afinarán
según se vayan definiendo los procedimientos reales de cada área.

## Arquitectura

- **Runtime**: Node + TypeScript (`tsx`), Express.
- **Agente**: LangChain/LangGraph (`createReactAgent`) con `gpt-4o-mini`
  (`temperature: 0`), historial de conversación persistido en SQLite vía
  `SqliteSaver` (sobrevive reinicios del proceso).
- **Herramientas del agente** (`src/ai/tools/`):
  - `verificarNumeroSerie` — valida el VIN contra la API externa, marca la sesión
    como verificada y cachea la URL del PDF si viene.
  - `clasificarConversacion` — registra la categoría (`administrativo` | `operativo`
    | `siniestros`) de la conversación para uso interno.
- **`car-verify-api.ts`** — cliente HTTP de la API de validación (no es una tool en
  sí, la usa `verificar-serie.ts`): `GET` con bearer token, timeout de 10s y 1 reintento
  automático ante error de red/timeout/status no-2xx.

## Endpoints HTTP

### `POST /ai/chat`
Body:
```json
{
  "sessionId": "string o number (requerido — identifica el hilo de conversación)",
  "customerMessage": "string (lo que escribió el cliente)",
  "timestamp": "ISO 8601, opcional (si falta, se usa la hora del servidor)"
}
```
Respuesta:
```json
{
  "success": true,
  "message": "texto de respuesta del bot, listo para mostrarle al cliente",
  "attachmentUrls": ["URLs de archivos a enviar, ej. el PDF de la póliza"],
  "classification": "administrativo | operativo | siniestros | null"
}
```

## Variables de entorno

Ver [.env.example](.env.example):

| Variable | Uso |
|---|---|
| `PORT` | Puerto del servidor Express |
| `APP_URL` | URL pública del servidor (no usada activamente hoy; queda por si se vuelve a necesitar servir archivos propios) |
| `OPENAI_API_KEY` | Requerida por LangChain/`ChatOpenAI` |
| `CAR_VALIDATE_API_URL` | Endpoint de validación de pólizas por número de serie |
| `CAR_VALIDATE_API_TOKEN` | Bearer token para esa API |

## Estructura del proyecto

```
src/
  main.ts                  # Arranque de Express
  db.ts                     # SQLite: estado de sesión (verificado, pdf_url, clasificación)
  routes/
    ai-routes.ts            # POST /ai/chat
  ai/
    agent.ts                # Arma y ejecuta el agente LangGraph
    system-prompt.ts        # TODO el comportamiento/tono del bot vive aquí
    session-state.ts        # Wrapper de db.ts para las tools
    tools/
      verificar-serie.ts        # Tool: valida el VIN
      car-verify-api.ts         # Cliente HTTP de la API de validación
      clasificar-conversacion.ts # Tool: registra la categoría de la conversación
```

## Persistencia

SQLite en `data/` (gitignored):
- `a86-agent.db` — tabla `sesiones`: `verificado`, `pdf_url` (de un solo uso, se borra
  al entregarse), `clasificacion`. Sobrevive a reinicios del proceso.
- `a86-agent-checkpoints.db` — historial de conversación de LangGraph (esquema propio
  de `SqliteSaver`).

## Integración con n8n / Chatwoot

El flujo de n8n (`A86Chatwoot.json` en la raíz del repo) es una adaptación del workflow
heredado de un bot anterior (Marcial Protege) — ya se limpió para que coincida con este
backend, pero el **Chatwoot del usuario todavía no está configurado**, así que faltan
credenciales/URLs reales antes de poder correrlo.

**Qué se mantuvo tal cual**: el pipeline de debounce/dedup de mensajes de WhatsApp
(espera 10s, relee el historial, descarta ejecuciones duplicadas), el procesamiento de
adjuntos (descripción de imágenes, transcripción de audio, extracción/OCR de PDFs), y el
envío de la respuesta al cliente (dividida en párrafos, con pausas para sonar natural,
seguida de cualquier adjunto).

**Qué se quitó** (todo lo que dependía de campos que la API actual ya no devuelve —
`escalate`, `tramiteEnProceso`, `summary`, `archivosValidados`, `tramiteCompletado` — o
de rutas que ya no existen):
- El gate inicial que revisaba la etiqueta `requiere_humano` antes de procesar un mensaje.
- La rama completa de escalamiento (nota privada + etiquetas `requiere_humano`/
  `tramite_en_proceso` en Chatwoot).
- El envío del checklist de "documentos validados" del cliente (el bot ya no recibe ni
  valida archivos del cliente).
- El paso de staging (`POST /ai/attachments/stage`, endpoint que ya no existe) y las
  señales `llenado`/`firma` que solo usaba el tool de validación de documentos eliminado.
- No se agregó ninguna etiqueta nueva para `classification` — el usuario la integrará
  manualmente más adelante cuando tenga su Chatwoot configurado.

**Qué se adaptó**: como el agente actual solo acepta un `customerMessage` de texto plano
(ya no existe el canal separado `attachmentContext`), el texto extraído de imágenes/
audio/PDFs ahora se agrega directamente al `customerMessage`, etiquetado por tipo (ej.
`[Imagen adjunta]: sedán plata con abolladura en puerta...`).

**Pendiente para el usuario, antes de poder usar este flujo**:
- La URL de `EnvioAAgente` sigue apuntando al dominio viejo de MPS
  (`https://mps-agent-clients.akeppatest.com/ai/chat`) — hay que cambiarla por el
  deployment real de Agente 86.
- El nodo `Datos` y todas las llamadas a la API de Chatwoot (`chat.akeppatest.com` +
  token) son credenciales de prueba del bot anterior — hay que reemplazarlas por las del
  Chatwoot real de Agente 86 una vez esté configurado.
- El endpoint `POST /ai/chat` solo necesita `sessionId`, `customerMessage` y `timestamp`
  — `attachmentUrls` en la respuesta trae URLs listas para reenviar como adjunto (ej. el
  PDF de la póliza), de un solo uso, no se deben cachear ni reutilizar.

## Placeholders pendientes

- **Nombre del bot**: "Max" es un placeholder, se puede cambiar en
  [system-prompt.ts](src/ai/system-prompt.ts).
- **Teléfono de reporte de siniestros nuevos**: `55-1234-5678` es un placeholder al
  inicio de [system-prompt.ts](src/ai/system-prompt.ts) (`TELEFONO_REPORTE_SINIESTROS`)
  — reemplazar por el número real.
- **Base de conocimientos**: no existe todavía.
- **Definiciones finas de `operativo`/`administrativo`/`siniestros`**: están basadas en
  las reglas generales que dio el cliente; se van a afinar según se definan los
  procedimientos reales de cada área.

## Fuera de alcance (por ahora)

Este proyecto partió de un bot de otra aseguradora (Marcial Protege / GNP) mucho más
grande, con trámites, checklist de documentos y recepción de archivos del cliente. Se
eliminó todo lo que no aplica a Agente 86:
- Catálogo de trámites, clasificación de trámites, checklist de requisitos por trámite.
- Recepción/almacenamiento de archivos que envía el cliente (el bot actual es
  *send-only*: puede mandar el PDF de la póliza, pero no procesa ni guarda adjuntos
  entrantes).
- Búsqueda RAG sobre una base de conocimientos (no existe todavía).
- Escalamiento genérico a un humano vía etiqueta `[ESCALAR]` (reemplazado por el
  sistema de clasificación de 3 categorías).
