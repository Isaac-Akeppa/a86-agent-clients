import { tool } from 'langchain'
import { z } from 'zod'
import { setClassification } from '../session-state.js'

// Las 3 categorías que usa Chatwoot para etiquetar la conversación (ver n8n:
// AgregarEtiquetaHumano-style node). Los criterios exactos para elegir entre ellas
// todavía no están definidos a detalle — este enum y el tool call son la parte
// "mecánica" (registrar + exponer la clasificación); las reglas de negocio de cuándo
// usar cada una se afinan en el system prompt más adelante.
const CATEGORIAS = ['administrativo', 'operativo', 'siniestros'] as const
export type CategoriaConversacion = (typeof CATEGORIAS)[number]

export const clasificarConversacion = tool(
  async ({ categoria }, config) => {
    const sessionId = config?.configurable?.thread_id
    if (typeof sessionId === 'string') {
      setClassification(sessionId, categoria)
    } else {
      console.error(' [clasificarConversacion] No se recibió thread_id en la config; no se pudo registrar la clasificación.')
    }
    return `CLASIFICACION_REGISTRADA: la conversación quedó clasificada como "${categoria}".`
  },
  {
    name: 'clasificarConversacion',
    description:
      'Registra, para uso interno del sistema (etiquetado en Chatwoot), la categoría que mejor describe lo que el cliente necesita en esta conversación: "administrativo", "operativo" o "siniestros". Esto es independiente de la validación del número de serie — llámala en cuanto tengas claro qué tipo de solicitud es, incluso si el cliente todavía no ha sido validado. Si a mitad de la conversación queda claro que la categoría real es otra, vuelve a llamarla con la categoría correcta (la reemplaza).',
    schema: z.object({
      categoria: z.enum(CATEGORIAS).describe('Categoría que mejor describe la solicitud del cliente'),
    }),
  }
)
