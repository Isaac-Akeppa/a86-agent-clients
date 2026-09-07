import { Router } from 'express'
import { processMessage } from '../ai/agent.js'
import { popPdfUrl, popPolicyNumber } from '../ai/session-state.js'

const router = Router()

router.post('/chat', async (req, res) => {
  const { sessionId, customerMessage, timestamp } = req.body

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      message: 'Falta campo requerido: sessionId'
    })
  }

  const safeCustomerMessage = typeof customerMessage === 'string' ? customerMessage : ''

  // El caller debe enviar el timestamp del mensaje original (ISO 8601). Si no llega (o
  // es inválido), usamos la hora del servidor como respaldo.
  const parsedTimestamp = timestamp && !isNaN(Date.parse(timestamp))
    ? new Date(timestamp)
    : new Date();

  console.log(` Cliente [${sessionId}] (${parsedTimestamp.toISOString()}): ${safeCustomerMessage}`)

  try {
    const { text: response, suprimirRespuesta, classification } = await processMessage(safeCustomerMessage, sessionId, parsedTimestamp);

    let cleanMessage = response;
    const fileUrls: string[] = [];
    let policyNumber: string | null = null;

    if (suprimirRespuesta) {
      // La conversación ya tenía etiqueta de un turno anterior y esto no se pudo
      // resolver con datos reales: un humano ya le está dando seguimiento, así que no
      // se le muestra nada al cliente ni se toca la etiqueta este turno. Se decide en
      // agent.ts de forma determinista — lo que haya escrito el modelo se descarta.
      cleanMessage = '';
    } else if (/\[ENVIAR_POLIZA\]/.test(cleanMessage)) {
      // El documento de la póliza (URL de un solo uso entregada por la API) no viaja en el
      // texto del modelo — se recupera del caché de la sesión que "verificarNumeroSerie" llenó.
      const pdfUrl = popPdfUrl(String(sessionId));
      if (pdfUrl) {
        fileUrls.push(pdfUrl);
        // El número de póliza viaja junto al PDF únicamente para que el flujo de envío
        // (n8n) pueda nombrar el archivo como "Poliza <numero>" en vez del nombre por
        // defecto que trae la descarga.
        policyNumber = popPolicyNumber(String(sessionId)) ?? null;
      } else {
        console.warn(` [${sessionId}] '[ENVIAR_POLIZA]' no tiene una URL de documento pendiente para esta sesión.`)
      }
      cleanMessage = cleanMessage.replace(/\[ENVIAR_POLIZA\]/g, '').trim();
    }

    res.json({
      success: true,
      message: cleanMessage,
      attachmentUrls: fileUrls,
      // Número de póliza del documento adjunto (si se está enviando uno), para nombrar
      // el archivo en el flujo de envío. null si no se envió ningún documento.
      policyNumber,
      // Categoría ("administrativo" | "operativo" | "siniestros") para que n8n la use
      // como etiqueta de la conversación en Chatwoot. Solo viaja el turno en el que se
      // fija POR PRIMERA VEZ — null en cualquier otro turno (incluido este, si ya venía
      // clasificada de antes), para no reaplicar/pisar la etiqueta en Chatwoot cada vez.
      classification,
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
