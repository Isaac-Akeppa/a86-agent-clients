import { tool } from 'langchain'
import { z } from 'zod'
import { getTramiteNombres } from '../tramites-catalog.js'

export const NINGUNO_TRAMITE = 'NINGUNO' as const

// Se reconstruye en cada mensaje (ver agent.ts) para que el enum siempre refleje
// el catálogo real vigente en conocimiento.md, sin necesitar reiniciar el proceso.
export function createClasificarTramiteTool() {
  const nombresReales = getTramiteNombres()
  const valoresPermitidos = [...nombresReales, NINGUNO_TRAMITE] as [string, ...string[]]

  return tool(
    async ({ tramite }) => {
      if (tramite === NINGUNO_TRAMITE) {
        return 'NO_EXISTE_EN_CATALOGO: Este trámite no está en el catálogo real de Marcial Protege. No uses buscarEnDocumentos ni inventes nada sobre él: responde únicamente con el mensaje fijo de trámite desconocido y la etiqueta [ESCALAR] correspondiente.'
      }
      return `TRAMITE_VALIDO: "${tramite}" existe en el catálogo. Continúa el flujo normal usando buscarEnDocumentos con este nombre exacto para obtener sus detalles.`
    },
    {
      name: 'clasificarTramite',
      description:
        'OBLIGATORIO: llama esta herramienta PRIMERO, antes que cualquier otra herramienta o respuesta, para verificar si la solicitud de trámite del cliente corresponde a un trámite real del catálogo cerrado de Marcial Protege. Debes elegir exactamente uno de los valores permitidos del esquema, copiado literalmente — está ESTRICTAMENTE PROHIBIDO inventar un nombre que no esté en la lista. Si la solicitud del cliente no corresponde con precisión a ninguno de los trámites reales listados, elige "NINGUNO".',
      schema: z.object({
        tramite: z
          .enum(valoresPermitidos)
          .describe('El nombre EXACTO del trámite del catálogo que corresponde a la solicitud del cliente, copiado literalmente, o "NINGUNO" si no corresponde con precisión a ninguno.')
      })
    }
  )
}
