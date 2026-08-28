import { tool } from 'langchain'
import { z } from 'zod'
import { getTramiteNombres, getRequisitosParaTramite } from '../tramites-catalog.js'

// Se reconstruye en cada mensaje (ver agent.ts), igual que createClasificarTramiteTool,
// para que el enum de trámites siempre refleje el catálogo vigente de conocimiento.md.
export function createRequisitosTramiteTool() {
  const nombresReales = getTramiteNombres()

  if (nombresReales.length === 0) {
    return tool(
      async () => 'Error interno: no se pudo acceder al catálogo de trámites local.',
      {
        name: 'obtenerRequisitosTramite',
        description: 'Devuelve la lista exacta y completa de "[REQUISITOS_DEL_CLIENTE]" de un trámite del catálogo.',
        schema: z.object({ tramite: z.string() }),
      }
    )
  }

  return tool(
    async ({ tramite }) => {
      const requisitos = getRequisitosParaTramite(tramite)

      if (requisitos.length === 0) {
        return `El trámite "${tramite}" no tiene una lista de "[REQUISITOS_DEL_CLIENTE]" registrada en el catálogo (puede no requerir documentos del cliente, o manejarse con otras reglas). Sigue las instrucciones específicas que te dé "buscarEnDocumentos" para este trámite.`
      }

      const lista = requisitos.map((r, i) => `${i + 1}. ${r}`).join('\n')
      return `[REQUISITOS_DEL_CLIENTE] EXACTOS Y COMPLETOS para "${tramite}" — pide TODOS y cada uno, tal cual están escritos aquí, sin resumir, combinar ni omitir ninguno:\n${lista}`
    },
    {
      name: 'obtenerRequisitosTramite',
      description:
        'Devuelve, de forma exacta y completa (leída directamente del catálogo, no de memoria ni de búsqueda semántica), la lista de "[REQUISITOS_DEL_CLIENTE]" de un trámite ya confirmado como TRAMITE_VALIDO por "clasificarTramite". Úsala siempre que necesites pedirle documentos al cliente para un trámite, en vez de reconstruir la lista de lo que recuerdes de "buscarEnDocumentos" — especialmente importante en trámites con listas largas, donde omitir un documento es fácil.',
      schema: z.object({
        tramite: z
          .enum(nombresReales as [string, ...string[]])
          .describe('Nombre EXACTO del trámite, tal como lo devolvió "clasificarTramite".'),
      }),
    }
  )
}
