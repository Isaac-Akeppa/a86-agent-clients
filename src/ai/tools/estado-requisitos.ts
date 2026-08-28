import { tool } from 'langchain'
import { z } from 'zod'
import { getTramiteNombres, getRequisitosParaTramite } from '../tramites-catalog.js'
import { getEstadoRequisitos } from '../../db.js'

// Se reconstruye en cada mensaje (mismo patrón que las demás tools de catálogo) para que
// el enum de trámites siempre refleje conocimiento.md vigente.
export function createEstadoRequisitosTool() {
  const nombresReales = getTramiteNombres()

  if (nombresReales.length === 0) {
    return tool(
      async () => 'Error interno: no se pudo acceder al catálogo de trámites local.',
      {
        name: 'obtenerEstadoRequisitos',
        description: 'Devuelve qué requisitos del trámite activo ya se recibieron y cuáles faltan.',
        schema: z.object({ tramite: z.string() }),
      }
    )
  }

  return tool(
    async ({ tramite }, config) => {
      const sessionId = config?.configurable?.thread_id
      if (typeof sessionId !== 'string') {
        console.error(' [obtenerEstadoRequisitos] No se recibió thread_id en la config.')
        return 'ERROR_TECNICO: no se pudo identificar la sesión.'
      }

      const requisitosCatalogo = getRequisitosParaTramite(tramite)
      if (requisitosCatalogo.length === 0) {
        return `El trámite "${tramite}" no tiene una lista de "[REQUISITOS_DEL_CLIENTE]" registrada en el catálogo.`
      }

      const estado = getEstadoRequisitos(sessionId, tramite, requisitosCatalogo)

      const recibidosTexto = estado.recibidos.length
        ? estado.recibidos.map((r, i) => `${i + 1}. ${r.requisito}`).join('\n')
        : 'Ninguno todavía.'

      const rechazadosTexto = estado.rechazados.length
        ? estado.rechazados.map((r, i) => `${i + 1}. ${r.requisito} — motivo: ${r.motivo ?? 'no especificado'}`).join('\n')
        : 'Ninguno.'

      const pendientesTexto = estado.pendientes.length
        ? estado.pendientes.map((r, i) => `${i + 1}. ${r}`).join('\n')
        : 'NINGUNO — ya se completaron todos los requisitos de este trámite.'

      return `ESTADO_REQUISITOS de "${tramite}" (fuente de verdad — no calcules esto del historial de la conversación):\n\nYA RECIBIDOS Y VÁLIDOS:\n${recibidosTexto}\n\nRECHAZADOS (pedir de nuevo):\n${rechazadosTexto}\n\nPENDIENTES:\n${pendientesTexto}`
    },
    {
      name: 'obtenerEstadoRequisitos',
      description:
        'Devuelve, leído directamente del registro persistente del sistema (no de tu memoria ni del historial de la conversación), qué requisitos del trámite activo ya se recibieron y validaron, cuáles fueron rechazados (y por qué) y cuáles siguen pendientes. Úsala SIEMPRE antes de decirle al cliente qué le falta, y SIEMPRE antes de escalar a un humano por documentos completos — solo escalas por documentos si esta tool devuelve cero pendientes.',
      schema: z.object({
        tramite: z
          .enum(nombresReales as [string, ...string[]])
          .describe('Nombre EXACTO del trámite activo, tal como lo devolvió "clasificarTramite".'),
      }),
    }
  )
}
