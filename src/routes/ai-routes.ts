import { Router } from 'express'
import { processMessage } from '../ai/agent.js'
import { popPdfUrl, getClassification } from '../ai/session-state.js'

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
    const { text: response } = await processMessage(safeCustomerMessage, sessionId, parsedTimestamp);

    let cleanMessage = response;
    const fileUrls: string[] = [];

    // El documento de la póliza (URL de un solo uso entregada por la API) no viaja en el
    // texto del modelo — se recupera del caché de la sesión que "verificarNumeroSerie" llenó.
    if (/\[ENVIAR_POLIZA\]/.test(cleanMessage)) {
      const pdfUrl = popPdfUrl(String(sessionId));
      if (pdfUrl) {
        fileUrls.push(pdfUrl);
      } else {
        console.warn(` [${sessionId}] '[ENVIAR_POLIZA]' no tiene una URL de documento pendiente para esta sesión.`)
      }
      cleanMessage = cleanMessage.replace(/\[ENVIAR_POLIZA\]/g, '').trim();
    }

    res.json({
      success: true,
      message: cleanMessage,
      attachmentUrls: fileUrls,
      // Categoría ("administrativo" | "operativo" | "siniestros") para que n8n la use
      // como etiqueta de la conversación en Chatwoot. null hasta que el modelo la
      // determine (ver "clasificarConversacion"); se mantiene entre turnos.
      classification: getClassification(String(sessionId)) ?? null,
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
