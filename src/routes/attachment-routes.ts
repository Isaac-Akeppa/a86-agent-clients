import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import { stageAttachment, UPLOADS_DIR } from '../ai/attachment-storage.js'

const router = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } })

const VALORES_LLENADO = new Set(['si', 'no', 'desconocido'])

function normalizarFlag(valor: unknown): 'si' | 'no' | 'desconocido' {
  const texto = typeof valor === 'string' ? valor.toLowerCase().trim() : ''
  return VALORES_LLENADO.has(texto) ? (texto as 'si' | 'no' | 'desconocido') : 'desconocido'
}

// Llamado por n8n justo después de descargar cada adjunto de Chatwoot (en paralelo al
// flujo de OCR/transcripción existente), para que el binario quede guardado ANTES de que
// el turno de texto llegue a /ai/chat. El agente lo reclama después con
// "registrarDocumentoRecibido" usando el mismo attachmentId (el id de adjunto de Chatwoot).
router.post('/attachments/stage', upload.single('file'), async (req, res) => {
  const { sessionId, attachmentId, llenado, firma } = req.body

  if (!sessionId || !attachmentId) {
    return res.status(400).json({ success: false, message: 'Faltan campos requeridos: sessionId, attachmentId' })
  }

  if (!req.file) {
    return res.status(400).json({ success: false, message: 'Falta el archivo (campo "file")' })
  }

  try {
    stageAttachment({
      sessionId: String(sessionId),
      attachmentId: String(attachmentId),
      buffer: req.file.buffer,
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
      llenado: normalizarFlag(llenado),
      firma: normalizarFlag(firma),
    })

    res.json({ success: true })
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Error desconocido'
    console.error(' Error guardando adjunto en staging:', errorMessage)
    res.status(500).json({ success: false, message: 'Error interno al guardar el adjunto' })
  }
})

// Descarga server-to-server para n8n (ver buildValidatedFileUrl en attachment-storage.ts):
// nunca queda listado en "public/" — solo responde si la ruta pedida resuelve DENTRO de
// UPLOADS_DIR, para bloquear cualquier intento de traversal ("..") hacia otra carpeta.
router.get('/attachments/validados/*splat', (req, res) => {
  const segmentos = req.params.splat as unknown as string[]
  const absoluto = path.join(UPLOADS_DIR, ...segmentos)

  if (!absoluto.startsWith(UPLOADS_DIR + path.sep)) {
    return res.status(400).json({ success: false, message: 'Ruta inválida' })
  }

  res.sendFile(absoluto, (error: unknown) => {
    if (error) res.status(404).json({ success: false, message: 'Archivo no encontrado' })
  })
})

export default router
