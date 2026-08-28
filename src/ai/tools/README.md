# Tools del agente

Herramientas disponibles para el agente (`src/ai/agent.ts`), registradas en `buildAgent()`.

## clasificarTramite (`clasificar-tramite.ts`)
Verifica que el trámite mencionado por el cliente exista en el catálogo real (`assets/docs/conocimiento.md`). Se reconstruye en cada mensaje para que su enum de valores permitidos siempre refleje el catálogo vigente. Debe llamarse primero, antes de cualquier otra tool, cuando el cliente pide/menciona un trámite.

## obtenerRequisitosTramite (`requisitos-tramite.ts`)
Devuelve la lista exacta y completa de `[REQUISITOS_DEL_CLIENTE]` de un trámite, parseada directamente de `conocimiento.md` (misma función `tramites-catalog.ts` que ya parseaba `[ARCHIVOS_A_ENVIAR]`, extendida con `getRequisitosParaTramite`), en vez de depender de que el modelo la reconstruya de memoria a partir de los fragmentos que le devuelve `buscarEnDocumentos` (RAG). Igual que `clasificarTramite`, se reconstruye en cada mensaje para que su enum de trámites refleje el catálogo vigente. Pensada para trámites con listas largas (ej. PAGO DE SUMA ASEGURADA, 13 ítems) donde un chunk de RAG podría cortar la lista o el modelo podría omitir un ítem al transcribirla.

## registrarDocumentoRecibido (`registrar-documento.ts`) / obtenerEstadoRequisitos (`estado-requisitos.ts`)
Reemplazan la dependencia de "revisar el historial de la conversación" para saber qué documentos ya se recibieron: ese checklist ahora vive en SQLite (`src/db.ts`, `data/mps-agent.db`), no en la memoria del modelo ni en el checkpointer de LangGraph (que es puramente en RAM — se pierde en cada reinicio de PM2).

- **Flujo completo**: n8n descarga cada adjunto de Chatwoot y, además de mandarlo a OCR/transcripción como ya hacía, lo sube a `POST /ai/attachments/stage` (`src/routes/attachment-routes.ts`) junto con `sessionId`, el `attachmentId` de Chatwoot y (para PDFs escaneados) las señales `llenado`/`firma` calculadas por el prompt de OCR. Eso lo deja en un área temporal (`storage/staging/`) hasta que el agente lo reclame en el mismo turno.
- El texto extraído sigue llegando a `/ai/chat` dentro de `attachmentContext`, ahora con `attachmentId`/`llenado`/`firma` como atributos extra de la etiqueta `<adjunto>` (ver `agent.ts`, `buildUserMessageContent`).
- El modelo llama `obtenerEstadoRequisitos(tramite)` para saber, desde SQLite, qué requisitos ya están recibidos/rechazados/pendientes — nunca lo infiere del chat.
- Cuando decide que un adjunto satisface un requisito pendiente, llama `registrarDocumentoRecibido(attachmentId, tramite, requisito)`. La tool (no el modelo) decide el resultado:
  - Valida que `requisito` sea texto EXACTO del catálogo (si no, `REQUISITO_INVALIDO`).
  - Reclama el archivo en staging por `attachmentId` (si no existe, `ADJUNTO_NO_ENCONTRADO` — nunca se inventa un archivo).
  - Si la señal `llenado` guardada en staging es `"no"`: archiva el PDF en `storage/uploads/<session>/<trámite>/_rechazados/` (se conserva para revisión humana, pero nunca pisa una entrega válida) y responde `DOCUMENTO_RECHAZADO` con el motivo.
  - Si no, lo guarda en `storage/uploads/<session>/<trámite>/<CÓDIGO>_<NombreCliente>.<ext>` (ej. `INE_SoniaMirandaCeballos.pdf`) — nombre estandarizado pensado para reenvío por correo/WhatsApp más adelante — y responde `DOCUMENTO_RECIBIDO` con la lista de pendientes actualizada.
- El código corto (`INE`, `FSA`, `COMPROBANTE_DOMICILIO`, etc.) sale de una tabla curada en `doc-code.ts` a partir del texto del requisito, con un slug automático de respaldo si no hay match. El nombre del cliente sale de `session-state.ts`, poblado por `verificarCliente`/`consultarPoliza` al verificar exitosamente.
- `storage/` y `data/` están fuera de `public/` a propósito (documentos de clientes, nunca deben quedar servidos por `express.static`) y excluidos de git (`.gitignore`).

## obtenerDatosEmpresa (`datos-empresa.ts`)
Lee directamente (no por búsqueda semántica) la sección "## 1. INFORMACIÓN GENERAL DE LA EMPRESA" de `conocimiento.md` (teléfono, dirección, horario, correo, contacto de emergencia GNP), parseada por `src/ai/datos-empresa.ts`. Se agregó porque `buscarEnDocumentos` (RAG) no siempre trae ese chunk en el mismo resultado que la sección del trámite que el cliente está pidiendo — ej. el trámite de cancelación exige dar el teléfono/dirección de inmediato, pero su propia sección del documento no los menciona textualmente, y el modelo llegó a inventarse un teléfono y dirección plausibles pero falsos para cumplir la instrucción. Mismo patrón que `obtenerRequisitosTramite`: datos exactos y estáticos que no deben depender de la suerte del retrieval.

## buscarEnDocumentos (`local-rag.ts`)
Búsqueda semántica (RAG local, embeddings de OpenAI) sobre `assets/docs/conocimiento.md`. Es la única fuente de verdad para información de la empresa, trámites, requisitos y formularios.

## client-verify-api.ts (no es una tool)
Módulo compartido con la llamada HTTP (fetch + timeout + reintento) a la API real de validación de pólizas que expone MPS-WA (ver `api-validador-polizas.md` para el contrato completo; controlador `PolizaController@consultaExterna`). La usan tanto `verificarCliente` como `consultarPoliza` — es la misma API y el mismo request en ambos casos.

- **Request**: `POST` a la URL de la variable de entorno `CLIENT_VERIFY_API_URL` (`https://mps.akeppatest.com/api/v1/polizas/validar`). Sin autenticación (la ruta no valida ningún token, ver el documento de la API) — los headers se arman en `buildAuthHeaders()`, pensado para agregar un bearer token fácilmente si el endpoint se protege más adelante.
- **Body** (nombres de campo centralizados en `REQUEST_FIELDS`):
  ```json
  { "nombre": "string", "numero_poliza": "string", "rfc": "string" }
  ```
  `numero_poliza` y `rfc` son obligatorios (la API responde 422 si faltan); `nombre` es opcional para la API pero nuestro flujo siempre lo recolecta.
- **Respuesta** (HTTP 200 tanto si encuentra como si no; nombres de campo en `RESPONSE_FIELDS`):
  ```json
  { "status": true, "poliza": { "...": "..." }, "pdf_url": "string | null" }
  ```
  o `{ "status": false, "message": "Cliente no encontrado" }`. `pdf_url` es una URL **de un solo uso, válida 10 minutos** (el servidor la invalida en el primer `GET`); solo le importa a `consultarPoliza` — `verificarCliente` la ignora. Un status HTTP fuera de 2xx (422, 5xx) se trata como falla y dispara el reintento.
- **Timeout y reintentos**: timeout de 10s por intento; si falla (red, timeout, status no-2xx) se reintenta automáticamente una vez.
- Los nombres de campo están centralizados en `REQUEST_FIELDS`/`RESPONSE_FIELDS` en `client-verify-api.ts` por si el contrato cambia.

## verificarCliente (`verificar-cliente.ts`)
Verifica la identidad del cliente contra la API (ver `client-verify-api.ts`) antes de continuar cualquier trámite (no aplica a saludos ni preguntas generales), ignorando los datos de la póliza y el `pdf_url` de la respuesta. Ver la lógica completa de cuándo se dispara y qué hacer con cada resultado en `src/ai/system-prompt.ts` (Sección 2, "Verificación de identidad del cliente").

- **Parámetros**: `nombre` (máx 255), `numeroPoliza` (máx 100, requerido), `rfc` (máx 20, requerido). El agente debe recolectar los tres antes de llamar la tool; no se llama con datos incompletos.
- **Resultados que devuelve al modelo**: `CLIENTE_ENCONTRADO`, `CLIENTE_NO_ENCONTRADO` o `ERROR_VERIFICACION`, cada uno con la instrucción de qué hacer a continuación. Si el segundo intento también falla, se reporta `ERROR_VERIFICACION` sin exponer detalles técnicos.

## consultarPoliza (`consultar-poliza.ts`)
Se usa en vez de `verificarCliente`, únicamente para el trámite "CONSULTA DE PÓLIZA" (ver `assets/docs/conocimiento.md`): permite tanto responder preguntas sobre los datos reales de la póliza (vigencia, producto, coberturas, prima, estatus, etc.) como entregar su documento.

- **Parámetros**: mismos tres que `verificarCliente`.
- Si encuentra al cliente, devuelve al modelo el objeto `poliza` completo (sin el campo `pdf_url`, ver abajo) dentro de una etiqueta `<datos_poliza>`, con instrucciones explícitas de responder solo el dato puntual que el cliente pidió (nunca volcar todos los datos ni mostrarlos en JSON crudo).
- El `pdf_url` (de un solo uso) nunca llega al texto que ve el modelo — se quita del JSON con `sanitizarPolizaParaModelo` y se guarda en memoria en `pendingPolizaUrlBySession`, un mapa en RAM por `sessionId` (mismo patrón que `lastInteractionDateBySession` en `agent.ts`), tomando el `thread_id` de la config de LangGraph. `popPolizaDownloadUrl(sessionId)` la lee y la borra; la llama `src/routes/ai-routes.ts` al procesar la respuesta.
- La tool le indica al modelo si el documento está disponible para descarga o no (según haya o no `pdf_url`, y si se pudo cachear); solo si el cliente pidió el documento y está disponible corresponde agregar `[POLIZA_DESCARGA]`.
- **Resultados que devuelve al modelo**: `POLIZA_ENCONTRADA` (datos + disponibilidad del documento), `CLIENTE_NO_ENCONTRADO` o `ERROR_VERIFICACION`.
- **Entrega al cliente**: cuando el modelo agrega `[POLIZA_DESCARGA]` en su respuesta, `ai-routes.ts` la detecta, recupera la URL cacheada para esa sesión con `popPolizaDownloadUrl` y la agrega tal cual a `attachmentUrls` (igual que hace con los archivos locales de `[TRAMITE_FORMULARIOS: ...]`), quitando la etiqueta del texto final. Como el link expira a los 10 minutos y es de un solo uso, nunca se reutiliza entre turnos.
