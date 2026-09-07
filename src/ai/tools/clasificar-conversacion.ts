import { tool } from 'langchain'
import { z } from 'zod'
import { setClassification, markSuppressResponse } from '../session-state.js'

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
    if (typeof sessionId !== 'string') {
      console.error(' [clasificarConversacion] No se recibió thread_id en la config; no se pudo registrar la clasificación.')
      return `CLASIFICACION_REGISTRADA: la conversación quedó clasificada como "${categoria}".`
    }

    // "yaClasificadoAntes" refleja el estado de la sesión ANTES de este turno (fijado una
    // sola vez en agent.ts, no una lectura en vivo) — así, si el modelo llama esta
    // herramienta más de una vez dentro del mismo turno (ej. se corrige a media
    // respuesta), todas esas llamadas se tratan como el mismo evento de clasificación,
    // no como "ya estaba clasificada". Si la sesión YA tenía etiqueta de un turno
    // anterior, un humano ya le está dando seguimiento: no se vuelve a tocar la etiqueta
    // ni se le muestra respuesta al cliente en este turno (lo aplica ai-routes.ts,
    // determinista, sin depender de qué texto termine escribiendo el modelo).
    const yaClasificadoAntes = config?.configurable?.yaClasificadoAntes === true
    if (yaClasificadoAntes) {
      markSuppressResponse(sessionId)
      return 'CONVERSACION_YA_CANALIZADA: esta conversación ya tenía una etiqueta de un turno anterior — un humano ya le está dando seguimiento a lo que está fuera de tu alcance. El sistema ya se encarga de no mostrar ninguna respuesta ni tocar la etiqueta este turno; no hace falta que escribas nada sobre "voy a canalizar" ni similar.'
    }

    setClassification(sessionId, categoria)
    return `CLASIFICACION_REGISTRADA: la conversación quedó clasificada como "${categoria}".`
  },
  {
    name: 'clasificarConversacion',
    description:
      'Registra, para uso interno del sistema (etiquetado en Chatwoot), la categoría que mejor describe lo que el cliente necesita en esta conversación: "administrativo", "operativo" o "siniestros". Esto es independiente de la validación del número de serie — llámala en cuanto tengas claro qué tipo de solicitud es, incluso si el cliente todavía no ha sido validado. Si a mitad de la conversación queda claro que la categoría real es otra, vuelve a llamarla con la categoría correcta (la reemplaza). Si la conversación ya tenía etiqueta de un turno anterior, llamarla igual es correcto — el sistema decide qué hacer con eso, tú no necesitas tratarlo distinto.',
    schema: z.object({
      categoria: z.enum(CATEGORIAS).describe('Categoría que mejor describe la solicitud del cliente'),
    }),
  }
)
