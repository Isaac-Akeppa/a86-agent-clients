import { tool } from 'langchain'
import { z } from 'zod'
import path from 'node:path'
import { getTramiteNombres, getRequisitosParaTramite, encontrarRequisitoCatalogo } from '../tramites-catalog.js'
import { getOrCreateCaso, marcarDocumento, getEstadoRequisitos, marcarCasoCompletadoSiEsNuevo, getArchivosValidados, reiniciarVerificacionSesion } from '../../db.js'
import { claimStagedAttachment, finalizeAcceptedDocument, archiveRejectedDocument, buildValidatedFileUrl } from '../attachment-storage.js'
import { getClientName } from '../session-state.js'
import { requiereValidacionDeLlenado } from '../doc-code.js'

function formatearEstado(pendientes: string[]): string {
  return pendientes.length === 0
    ? 'NINGUNO — ya se completaron todos los requisitos de este trámite.'
    : pendientes.map((r, i) => `${i + 1}. ${r}`).join('\n')
}

export interface ArchivoValidado {
  nombre: string
  url: string
}

export interface TramiteCompletado {
  tramite: string
  archivos: ArchivoValidado[]
}

// Igual patrón que pendingPolizaUrlBySession en consultar-poliza.ts: una señal de un solo
// uso, en RAM, que solo vive entre el momento en que la tool corre (dentro de
// "agent.invoke") y el instante justo después en ai-routes.ts donde se arma la respuesta
// para n8n de ESE MISMO request — nunca cruza un reinicio ni necesita persistir.
const tramiteRecienCompletadoPorSesion = new Map<string, TramiteCompletado>()

export function popTramiteRecienCompletado(sessionId: string | number): TramiteCompletado | undefined {
  const key = String(sessionId)
  const dato = tramiteRecienCompletadoPorSesion.get(key)
  tramiteRecienCompletadoPorSesion.delete(key)
  return dato
}

// Se reconstruye en cada mensaje (mismo patrón que clasificarTramite/obtenerRequisitosTramite)
// para que el enum de trámites siempre refleje el catálogo vigente.
export function createRegistrarDocumentoTool() {
  const nombresReales = getTramiteNombres()

  if (nombresReales.length === 0) {
    return tool(
      async () => 'Error interno: no se pudo acceder al catálogo de trámites local.',
      {
        name: 'registrarDocumentoRecibido',
        description: 'Registra un documento recibido del cliente contra los requisitos de su trámite.',
        schema: z.object({ attachmentId: z.string(), tramite: z.string(), requisito: z.string() }),
      }
    )
  }

  return tool(
    async ({ attachmentId, tramite, requisito }, config) => {
      const sessionId = config?.configurable?.thread_id
      if (typeof sessionId !== 'string') {
        console.error(' [registrarDocumentoRecibido] No se recibió thread_id en la config.')
        return 'ERROR_TECNICO: no se pudo identificar la sesión. Informa al cliente que hubo un problema técnico y que lo intente de nuevo. NO lo marques como recibido.'
      }

      const requisitosCatalogo = getRequisitosParaTramite(tramite)
      if (requisitosCatalogo.length === 0) {
        return `TRAMITE_SIN_REQUISITOS: "${tramite}" no tiene una lista de "[REQUISITOS_DEL_CLIENTE]" registrada en el catálogo; no se puede registrar un documento contra él.`
      }

      const requisitoCanonico = encontrarRequisitoCatalogo(tramite, requisito)
      if (!requisitoCanonico) {
        console.warn(` [${sessionId}] REQUISITO_INVALIDO: "${requisito}" no coincide con ningún requisito de "${tramite}".`)
        return `REQUISITO_INVALIDO: "${requisito}" no es un requisito EXACTO de "${tramite}" según el catálogo. Usa "obtenerEstadoRequisitos" u "obtenerRequisitosTramite" y copia el texto tal cual aparece ahí, sin resumir ni parafrasear.`
      }
      requisito = requisitoCanonico

      const claim = await claimStagedAttachment(sessionId, attachmentId)
      if (!claim.ok) {
        console.warn(` [${sessionId}] ADJUNTO_NO_ENCONTRADO: id "${attachmentId}" para el requisito "${requisito}".`)
        return `ADJUNTO_NO_ENCONTRADO: no se encontró (o ya fue registrado) un archivo con id "${attachmentId}" para esta sesión. Si el cliente sí envió un documento válido, discúlpate por un problema técnico al procesarlo y pídele que lo reenvíe — NO lo marques como recibido ni asumas que ya se completó.`
      }

      const casoId = getOrCreateCaso(sessionId, tramite)
      const clienteNombre = getClientName(sessionId) ?? 'Cliente'

      // La señal "llenado/firma" del OCR solo aplica a formatos que la compañía entrega en
      // blanco para que el cliente los llene a mano (FSA, cartas de ratificación, etc.).
      // Documentos propios del cliente (identificación, comprobante de domicilio, actas,
      // etc.) nunca vienen "llenados a mano" — exigirles esa señal los rechazaría siempre.
      if (requiereValidacionDeLlenado(requisito) && (claim.pendiente.llenado === 'no' || claim.pendiente.firma === 'no')) {
        const faltaLlenado = claim.pendiente.llenado === 'no'
        const faltaFirma = claim.pendiente.firma === 'no'
        const motivoRechazo =
          faltaLlenado && faltaFirma
            ? 'El documento aparenta venir en blanco, sin llenar a mano ni firmar.'
            : faltaLlenado
              ? 'El documento aparenta venir sin llenar a mano (en blanco).'
              : 'El documento aparenta no tener firma autógrafa.'

        archiveRejectedDocument({ sessionId, tramite, requisito, clienteNombre, pendiente: claim.pendiente })
        marcarDocumento(casoId, requisito, { estado: 'rechazado', motivoRechazo })
        const estado = getEstadoRequisitos(sessionId, tramite, requisitosCatalogo)
        return `DOCUMENTO_RECHAZADO: el archivo recibido para "${requisito}" fue rechazado por este motivo: "${motivoRechazo}". Explícale al cliente amablemente, indicándole ESE motivo específico, que ese requisito no quedó registrado, y pídele que lo reenvíe debidamente llenado y firmado a mano. NO lo cuentes como recibido.\n\nRequisitos pendientes de "${tramite}":\n${formatearEstado(estado.pendientes)}`
      }

      const archivoFinal = finalizeAcceptedDocument({ sessionId, tramite, requisito, clienteNombre, pendiente: claim.pendiente })
      marcarDocumento(casoId, requisito, {
        estado: 'recibido',
        archivoPath: archivoFinal,
        archivoOriginal: claim.pendiente.archivoOriginal,
      })

      const estado = getEstadoRequisitos(sessionId, tramite, requisitosCatalogo)
      if (estado.pendientes.length === 0 && marcarCasoCompletadoSiEsNuevo(casoId)) {
        const archivos = getArchivosValidados(casoId).map(a => ({
          nombre: path.basename(a.archivoPath),
          url: buildValidatedFileUrl(a.archivoPath),
        }))
        tramiteRecienCompletadoPorSesion.set(sessionId, { tramite, archivos })
        // La identidad verificada es válida para ESTE proceso, no para "el resto de la
        // conversación" — quien sea que continúe después (mismo cliente con otro
        // trámite, o alguien distinto reusando el mismo chat) debe volver a verificarse
        // antes de que sus archivos se nombren con datos de este trámite ya cerrado.
        reiniciarVerificacionSesion(sessionId)
      }
      return `DOCUMENTO_RECIBIDO: "${requisito}" quedó registrado correctamente para "${tramite}".\n\nRequisitos pendientes de "${tramite}":\n${formatearEstado(estado.pendientes)}`
    },
    {
      name: 'registrarDocumentoRecibido',
      description:
        'Registra oficialmente un adjunto del cliente (fuente "pdf_text" o "pdf_ocr") como el documento que cumple un requisito específico de su trámite activo. Valida que el requisito exista EXACTO en el catálogo, valida si el documento venía llenado/firmado (usando la señal calculada por el sistema al recibir el archivo, no lo que tú creas haber leído), guarda el archivo con un nombre estandarizado y te dice qué requisitos siguen pendientes. SIEMPRE úsala para confirmar/rechazar un documento en vez de decidirlo de memoria — nunca asumas que un documento quedó recibido sin llamarla.',
      schema: z.object({
        attachmentId: z
          .string()
          .describe('Valor EXACTO del atributo "id" de la etiqueta <adjunto> del documento en <contexto_adjuntos>.'),
        tramite: z
          .enum(nombresReales as [string, ...string[]])
          .describe('Nombre EXACTO del trámite activo, tal como lo devolvió "clasificarTramite".'),
        requisito: z
          .string()
          .describe('Texto EXACTO (copiado literal) del requisito de "[REQUISITOS_DEL_CLIENTE]" que este documento cumple.'),
      }),
    }
  )
}
