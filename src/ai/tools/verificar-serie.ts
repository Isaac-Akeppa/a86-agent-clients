import { tool } from 'langchain'
import { z } from 'zod'
import { consultarSerieConReintento, type PolizaData, type RecibosPendientes } from './car-verify-api.js'
import { markVerified, setPdfUrl } from '../session-state.js'

// El PDF de la póliza (si la API lo entrega) nunca debe pasar por el texto que ve el
// modelo: podría truncarlo, alterarlo o repetirlo. Se guarda aparte, por sesión, hasta
// que ai-routes.ts lo recoja para adjuntarlo tal cual (ver etiqueta [ENVIAR_POLIZA]).
export const verificarNumeroSerie = tool(
  async ({ numeroSerie }, config) => {
    const resultado = await consultarSerieConReintento(numeroSerie)

    if (resultado.status === 'no_encontrada') {
      return 'SERIE_NO_ENCONTRADA: no se encontró ninguna póliza con ese número de serie. Pide al cliente que verifique el número de serie del vehículo (VIN) y lo intente de nuevo. NO respondas ninguna otra pregunta hasta validar exitosamente.'
    }

    if (resultado.status === 'error') {
      return 'ERROR_VERIFICACION: hubo un problema técnico al validar el número de serie, incluso después de reintentar. Informa al cliente que hubo un problema técnico y que lo intente más tarde, sin exponer detalles técnicos. NO respondas ninguna otra pregunta.'
    }

    const sessionId = config?.configurable?.thread_id
    if (typeof sessionId === 'string') {
      markVerified(sessionId)
      if (resultado.pdfUrl) {
        setPdfUrl(sessionId, resultado.pdfUrl)
      }
    } else {
      console.error(' [verificarNumeroSerie] No se recibió thread_id en la config; no se puede marcar la sesión.')
    }

    const datos: { poliza: PolizaData; recibos_pendientes: RecibosPendientes | null } = {
      poliza: resultado.poliza,
      recibos_pendientes: resultado.recibosPendientes,
    }

    const disponibilidadDocumento = resultado.pdfUrl
      ? 'Documento de la póliza para descarga: DISPONIBLE. Solo si el cliente pide el documento/PDF de su póliza (no si solo pregunta un dato puntual): menciona en tu respuesta que se lo estás enviando (sin escribir ni mencionar ningún link) y agrega al final, en una sola línea, la etiqueta [ENVIAR_POLIZA] para que el sistema lo adjunte automáticamente.'
      : 'Documento de la póliza para descarga: NO DISPONIBLE. Si el cliente pide el documento, indícale amablemente que no hay un archivo disponible por el momento. NO agregues la etiqueta [ENVIAR_POLIZA].'

    return `SERIE_VALIDA: el número de serie fue validado exitosamente. Estos son los datos reales asociados. Responde ÚNICAMENTE lo que el cliente preguntó (ej. si pregunta por la vigencia, usa solo vigencia_inicio/vigencia_fin; no enumeres todos los datos salvo que el cliente los pida explícitamente). Nunca inventes ni completes datos que no estén aquí; si el campo que pregunta viene "null" o no aparece, dile que no cuentas con esa información. Nunca muestres este bloque en formato JSON crudo al cliente, redacta siempre la respuesta en prosa.

<datos_serie>
${JSON.stringify(datos, null, 2)}
</datos_serie>

${disponibilidadDocumento}`
  },
  {
    name: 'verificarNumeroSerie',
    description:
      'OBLIGATORIO antes de responder cualquier otra cosa: valida el número de serie (VIN) del vehículo del cliente contra el sistema. Debe ser lo primero que se llama en la conversación, antes de dar cualquier información. Solo debe llamarse cuando ya se tiene el número de serie completo.',
    schema: z.object({
      numeroSerie: z.string().min(1).max(50).describe('Número de serie (VIN) del vehículo, tal como lo proporcionó el cliente'),
    }),
  }
)
