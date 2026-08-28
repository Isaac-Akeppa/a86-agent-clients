import { Router } from 'express'
import { processMessage } from '../ai/agent.js'
import { getArchivosParaTramite, getRequisitosParaTramite, buildFileUrl, fileExists, resolverNombreTramite, sonElMismoRequisito, TRAMITE_EXENTO_DE_VERIFICACION } from '../ai/tramites-catalog.js'
import { popPolizaDownloadUrl } from '../ai/tools/consultar-poliza.js'
import { popTramiteRecienCompletado } from '../ai/tools/registrar-documento.js'
import { isVerified } from '../ai/session-state.js'
import { getEstadoRequisitos } from '../db.js'

const router = Router()

// El prompt le prohíbe al modelo transcribir la lista de requisitos (para eso existe la
// etiqueta [TRAMITE_REQUISITOS], ver Sección 2) — pero un LLM no garantiza seguirlo el
// 100% de las veces: se observó en producción un caso donde el modelo ni siquiera usó la
// etiqueta, sino que escribió la lista completa dos veces por su cuenta en la misma
// respuesta (la primera con aclaraciones inventadas entre paréntesis, la segunda más
// escueta) — como ninguna de las dos pasó por [TRAMITE_REQUISITOS], no hay tag que
// interceptar ni catálogo "resuelto este turno" contra el cual comparar. Por eso esto NO
// depende de qué trámite se resolvió: compara cualquier bloque de 2+ líneas numeradas
// contra los bloques YA vistos antes en el mismo mensaje (por contenido, no texto exacto —
// ver sonElMismoRequisito) y descarta el bloque completo si cada una de sus líneas ya
// apareció antes, sin importar si esa aparición vino de una etiqueta o de prosa libre.
function eliminarRelistadosDuplicados(mensaje: string): string {
  const lineas = mensaje.split('\n')
  const yaMostrados: string[] = []
  const resultado: string[] = []
  let i = 0

  while (i < lineas.length) {
    const bloque: string[] = []
    let j = i
    while (j < lineas.length) {
      const m = lineas[j].match(/^\s*\d+\.\s+(.+)$/)
      if (!m) break
      bloque.push(m[1].trim())
      j++
    }

    if (bloque.length >= 2) {
      const todasCubiertas = bloque.every(linea => yaMostrados.some(prev => sonElMismoRequisito(linea, prev)))
      if (todasCubiertas) {
        i = j // se salta el bloque completo: repite contenido ya mostrado, no aporta nada nuevo
        continue
      }
      // Se conserva el bloque ENTERO de una sola vez (nunca línea por línea): si solo se
      // avanzara "i" de a una, el resto del mismo bloque se re-escanearía como si fuera un
      // bloque nuevo y, al comparar contra "yaMostrados" (que ya lo incluye a sí mismo),
      // se detectaría como falso duplicado y se borraría su propia lista legítima.
      yaMostrados.push(...bloque)
      for (let k = i; k < j; k++) resultado.push(lineas[k])
      i = j
      continue
    }

    resultado.push(lineas[i])
    i++
  }

  return resultado.join('\n')
}

const MENSAJE_FALTA_VERIFICACION =
  'Antes de continuar con este trámite necesito verificar tu identidad. ¿Me compartes tu nombre completo, tu número de póliza y tu RFC?'

router.post('/chat', async (req, res) => {
  const { sessionId, customerMessage, attachmentContext, timestamp } = req.body

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      message: 'Falta campo requerido: sessionId'
    })
  }

  const safeCustomerMessage = typeof customerMessage === 'string' ? customerMessage : ''
  const safeAttachmentContext = Array.isArray(attachmentContext) ? attachmentContext : []
  const sessionIdStr = String(sessionId)

  // n8n debe enviar el timestamp del mensaje original (ISO 8601, ej. "2026-08-20T14:32:00.000Z").
  // Si no llega (o es inválido), usamos la hora del servidor como respaldo.
  const parsedTimestamp = timestamp && !isNaN(Date.parse(timestamp))
    ? new Date(timestamp)
    : new Date();

  console.log(` Cliente [${sessionId}] (${parsedTimestamp.toISOString()}): ${safeCustomerMessage} [adjuntos: ${safeAttachmentContext.length}]`)
try {
    const { text: response, tramiteClasificado } = await processMessage(safeCustomerMessage, safeAttachmentContext, sessionId, parsedTimestamp);

    let cleanMessage = response;
    const fileUrls: string[] = [];
    let isEscalated = false;
    let escalationSummary = "";
    // Se computa en código, no en un tag que el modelo tenga que recordar escribir (mismo
    // motivo que otras señales de esta ruta): "registrarDocumentoRecibido" ya sabe, con el
    // registro real de SQLite, el instante exacto en que el último requisito pendiente
    // quedó recibido. Se recupera aquí SIEMPRE (incluso si más abajo se bloquea la
    // respuesta por verificación) para no dejarla "olvidada" en el Map y que dispare en un
    // turno posterior sin relación.
    const tramiteRecienCompletado = popTramiteRecienCompletado(sessionIdStr)
    // Backstop en código: el prompt le pide al modelo verificar identidad antes de
    // revelar info de un trámite, pero un LLM no garantiza seguirlo el 100% de las
    // veces (se observó en pruebas). Si el trámite que se clasificó ESTE turno no es
    // el exento y la sesión no está marcada como verificada (verificarCliente/
    // consultarPoliza exitosos), se ignora lo que haya escrito el modelo y se fuerza
    // la petición de verificación — sin importar qué tan convincente sonara su texto.
    const bloqueadoPorVerificacion =
      !!tramiteClasificado && tramiteClasificado !== TRAMITE_EXENTO_DE_VERIFICACION && !isVerified(sessionIdStr)

    if (bloqueadoPorVerificacion) {
      console.warn(` [${sessionId}] Respuesta bloqueada por falta de verificación para el trámite "${tramiteClasificado}".`)
      res.json({
        success: true,
        message: MENSAJE_FALTA_VERIFICACION,
        attachmentUrls: [],
        escalate: false,
        summary: "",
        tramiteEnProceso: !!tramiteRecienCompletado,
        tramiteCompletado: tramiteRecienCompletado?.tramite ?? null,
        archivosValidados: tramiteRecienCompletado?.archivos ?? []
      });
      return;
    }

    // 1. Buscamos la orden de escalar
    const escalarMatch = cleanMessage.match(/\[ESCALAR:\s*(.*?)\]/);
    if (escalarMatch) {
      isEscalated = true;
      escalationSummary = escalarMatch[1].trim(); // Guardamos el resumen de Sofía
      cleanMessage = cleanMessage.replace(escalarMatch[0], '').trim(); // Borramos la etiqueta
    }

    // 2. Requisitos: el modelo NUNCA transcribe la lista él mismo (una lista larga se
    // presta a que omita ítems al parafrasear, ej. PAGO DE SUMA ASEGURADA con 13
    // requisitos). Solo nombra el trámite; el código arma la lista real y completa de
    // lo que aún falta (o completa, si el cliente no ha enviado nada) leyendo el
    // catálogo + el registro persistente de documentos recibidos.
    const requisitosRegex = /\[TRAMITE_REQUISITOS:\s*(.*?)\]/g;
    const tramitesConRequisitosResueltos = new Set<string>();

    function formatearListaPendientes(nombreTramite: string): string | null {
      const requisitosCatalogo = getRequisitosParaTramite(nombreTramite)
      if (requisitosCatalogo.length === 0) return null
      const estado = getEstadoRequisitos(sessionIdStr, nombreTramite, requisitosCatalogo)
      const pendientes = estado.pendientes.length > 0 ? estado.pendientes : requisitosCatalogo
      return pendientes.map((r, i) => `${i + 1}. ${r}`).join('\n')
    }

    cleanMessage = cleanMessage.replace(requisitosRegex, (_match, nombreTramiteRaw: string) => {
      const nombreTramite = nombreTramiteRaw.trim()
      // Se marca por el nombre CANÓNICO del catálogo, no el texto literal que escribió el
      // modelo — si [TRAMITE_FORMULARIOS] más abajo lo nombra con distinta mayúscula/acento,
      // debe seguir resolviendo al mismo trámite (ver resolverNombreTramite).
      const nombreCanonico = resolverNombreTramite(nombreTramite) ?? nombreTramite
      tramitesConRequisitosResueltos.add(nombreCanonico)
      const lista = formatearListaPendientes(nombreTramite)

      if (lista === null) {
        console.warn(` [${sessionId}] '[TRAMITE_REQUISITOS: ${nombreTramite}]' no coincide con ningún trámite del catálogo o no tiene requisitos configurados.`)
        return ''
      }

      return lista
    }).trim();

    // 3. El modelo solo nombra el trámite; el código arma los links reales a partir
    // del catálogo (evita que el modelo tenga que copiar URLs o llamar herramientas).
    const tramiteRegex = /\[TRAMITE_FORMULARIOS:\s*(.*?)\]/g;
    let tramiteMatch;
    // Respaldo: en pruebas, el modelo a veces entrega formularios sin haber usado
    // [TRAMITE_REQUISITOS] (escribe su propia lista, a veces incompleta — ej. omitió
    // 7 de 13 requisitos de PAGO DE SUMA ASEGURADA). Si eso pasa, se agrega la lista
    // real y completa igual, en vez de confiar en que el modelo la haya escrito bien.
    const requisitosDeRespaldo: string[] = [];
    while ((tramiteMatch = tramiteRegex.exec(cleanMessage)) !== null) {
      const nombreTramite = tramiteMatch[1].trim();
      const archivos = getArchivosParaTramite(nombreTramite);

      if (archivos.length === 0) {
        console.warn(` [${sessionId}] '[TRAMITE_FORMULARIOS: ${nombreTramite}]' no coincide con ningún trámite del catálogo o no tiene archivos configurados.`)
      }

      for (const archivo of archivos) {
        if (!fileExists(archivo)) {
          console.warn(` [${sessionId}] Archivo '${archivo}' del trámite '${nombreTramite}' no existe en public/docs/.`)
          continue;
        }
        fileUrls.push(buildFileUrl(archivo));
      }

      const nombreCanonico = resolverNombreTramite(nombreTramite) ?? nombreTramite
      if (!tramitesConRequisitosResueltos.has(nombreCanonico)) {
        const lista = formatearListaPendientes(nombreTramite)
        if (lista !== null) {
          console.warn(` [${sessionId}] '[TRAMITE_FORMULARIOS: ${nombreTramite}]' llegó sin '[TRAMITE_REQUISITOS]' — se agrega la lista real como respaldo.`)
          requisitosDeRespaldo.push(`Documentos que necesito para "${nombreTramite}":\n${lista}`)
        }
        tramitesConRequisitosResueltos.add(nombreCanonico) // evita duplicar si se repite la etiqueta
      }
    }
    cleanMessage = cleanMessage.replace(tramiteRegex, '').trim();
    if (requisitosDeRespaldo.length > 0) {
      cleanMessage = [cleanMessage, ...requisitosDeRespaldo].filter(Boolean).join('\n\n');
    }

    // 3b. Backstop adicional: el modelo a veces reescribe la lista de requisitos dos veces
    // por su cuenta (con o sin haber usado la etiqueta) — se detecta y recorta comparando
    // contra lo que ya se mostró en este mismo mensaje, sin depender de qué trámite se
    // resolvió (ver eliminarRelistadosDuplicados).
    cleanMessage = eliminarRelistadosDuplicados(cleanMessage);

    // 4. Documento de póliza obtenido por "consultarPoliza": la URL no viaja en el
    // texto del modelo (evita que la copie mal); se recupera del caché en memoria
    // que la tool llenó para esta misma sesión.
    if (/\[POLIZA_DESCARGA\]/.test(cleanMessage)) {
      const polizaUrl = popPolizaDownloadUrl(sessionId);
      if (polizaUrl) {
        fileUrls.push(polizaUrl);
      } else {
        console.warn(` [${sessionId}] '[POLIZA_DESCARGA]' no tiene una URL de póliza pendiente para esta sesión.`)
      }
      cleanMessage = cleanMessage.replace(/\[POLIZA_DESCARGA\]/g, '').trim();
    }

    // 5. Enviamos todo a n8n
    res.json({
      success: true,
      message: cleanMessage,
      attachmentUrls: fileUrls,
      escalate: isEscalated,           // true o false
      summary: escalationSummary,      // El resumen para el humano
      tramiteEnProceso: !!tramiteRecienCompletado,  // true solo el turno en que se completó el último requisito
      tramiteCompletado: tramiteRecienCompletado?.tramite ?? null,  // nombre real del trámite, para armar la nota privada en n8n
      archivosValidados: tramiteRecienCompletado?.archivos ?? []    // {nombre, url}[] — para adjuntar como NOTA PRIVADA en n8n, nunca al cliente
    });
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Error desconocido'
    console.error(' Error procesando mensaje:', errorMessage)

    res.status(500).json({
      success: false,
      message: 'Error interno al procesar el mensaje con el agente'
    })
  }
})

export default router
