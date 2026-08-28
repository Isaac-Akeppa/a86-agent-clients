import fs from 'node:fs'
import path from 'node:path'
import { stageAdjunto, popAdjuntoPendiente, type AdjuntoPendiente } from '../db.js'
import { buildDocCode, slugifyNombre, slugifyTramite } from './doc-code.js'

// Todo lo que llega de clientes (identificaciones, comprobantes de domicilio, formularios
// firmados) es información sensible: se guarda fuera de "public/", que main.ts expone tal
// cual por HTTP para servir los formularios en blanco. Nada bajo storage/ debe ser servido
// directo por Express.
const STORAGE_ROOT = path.join(process.cwd(), 'storage')
const STAGING_DIR = path.join(STORAGE_ROOT, 'staging')
export const UPLOADS_DIR = path.join(STORAGE_ROOT, 'uploads')
const RECHAZADOS_SUBDIR = '_rechazados'

function extensionDesdeNombre(nombreOriginal: string | undefined, mimetype: string | undefined): string {
  if (nombreOriginal) {
    const ext = path.extname(nombreOriginal).replace('.', '').toLowerCase()
    if (ext) return ext
  }
  const porMime: Record<string, string> = {
    'application/pdf': 'pdf',
    'image/jpeg': 'jpg',
    'image/png': 'png',
  }
  return (mimetype && porMime[mimetype]) || 'pdf'
}

export interface StageAttachmentInput {
  sessionId: string
  attachmentId: string
  buffer: Buffer
  originalName?: string
  mimetype?: string
  llenado?: 'si' | 'no' | 'desconocido'
  firma?: 'si' | 'no' | 'desconocido'
}

// Guarda el binario tal como llega de n8n (antes de que el modelo haya decidido a qué
// requisito corresponde) en un área temporal, junto con la señal de "llenado/firma" que
// ya vino calculada por el OCR estructurado — esa señal NUNCA depende de que el modelo la
// lea y la repita correctamente, viaja pegada al archivo desde que se guarda.
export function stageAttachment(input: StageAttachmentInput): void {
  const ext = extensionDesdeNombre(input.originalName, input.mimetype)
  const dir = path.join(STAGING_DIR, input.sessionId)
  fs.mkdirSync(dir, { recursive: true })

  const archivoPath = path.join(dir, `${input.attachmentId}.${ext}`)
  fs.writeFileSync(archivoPath, input.buffer)

  stageAdjunto({
    sessionId: input.sessionId,
    attachmentId: input.attachmentId,
    archivoPath,
    archivoOriginal: input.originalName ?? null,
    extension: ext,
    llenado: input.llenado ?? 'desconocido',
    firma: input.firma ?? 'desconocido',
  })
}

export type ClaimResult =
  | { ok: true; pendiente: AdjuntoPendiente }
  | { ok: false; motivo: 'no_encontrado' }

function esperar(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// n8n dispara la subida del binario a "/attachments/stage" y la llamada a "/ai/chat" que
// hace que el modelo intente reclamarlo casi en paralelo, sin garantía de orden. En
// producción esto NO es un simple jitter de milisegundos: se midió una demora consistente
// de ~10-11 segundos entre que el intento de reclamo falla y la fila de staging finalmente
// aparece (probablemente el paso de OCR/staging en n8n es más lento que armar el mensaje de
// chat). Un primer intento con solo 4s de ventana total seguía fallando siempre en
// producción — se amplía con margen holgado sobre esa medición real.
const REINTENTOS_CLAIM = 25
const ESPERA_ENTRE_REINTENTOS_MS = 1000

export async function claimStagedAttachment(sessionId: string, attachmentId: string): Promise<ClaimResult> {
  for (let intento = 1; intento <= REINTENTOS_CLAIM; intento++) {
    const pendiente = popAdjuntoPendiente(sessionId, attachmentId)
    if (pendiente) return { ok: true, pendiente }
    if (intento < REINTENTOS_CLAIM) await esperar(ESPERA_ENTRE_REINTENTOS_MS)
  }
  return { ok: false, motivo: 'no_encontrado' }
}

export interface FinalizeInput {
  sessionId: string
  tramite: string
  requisito: string
  clienteNombre: string
  pendiente: AdjuntoPendiente
}

// Mueve el archivo reclamado de staging/ a su nombre final estandarizado y lo saca de la
// carpeta temporal. Reenviar el mismo requisito más tarde sobreescribe la versión anterior
// a propósito: el checklist en SQLite (documentos_requisito) es quien lleva el historial de
// estado, el nombre de archivo siempre representa "la última versión válida entregada".
export function finalizeAcceptedDocument(input: FinalizeInput): string {
  const { sessionId, tramite, requisito, clienteNombre, pendiente } = input
  const dir = path.join(UPLOADS_DIR, sessionId, slugifyTramite(tramite))
  fs.mkdirSync(dir, { recursive: true })

  const codigo = buildDocCode(requisito)
  const nombreCliente = slugifyNombre(clienteNombre)
  const destino = path.join(dir, `${codigo}_${nombreCliente}.${pendiente.extension}`)

  fs.renameSync(pendiente.archivoPath, destino)
  return destino
}

// URL server-to-server (n8n la descarga y la reenvía a Chatwoot como nota privada — nunca
// llega al cliente) para un documento YA validado del cliente. A propósito NO vive en
// "public/": son identificaciones, comprobantes, etc. — la ruta que la sirve (ver
// attachment-routes.ts) valida que quede dentro de UPLOADS_DIR antes de responder.
export function buildValidatedFileUrl(archivoPath: string): string {
  const relativo = path.relative(UPLOADS_DIR, archivoPath)
  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`
  const segmentos = relativo.split(path.sep).map(encodeURIComponent).join('/')
  return `${appUrl}/ai/attachments/validados/${segmentos}`
}

// Los documentos rechazados (ej. formato sin llenar) se conservan para que un asesor
// pueda revisarlos, pero separados y marcados, para que nunca se confundan con una
// entrega válida ni pisen el archivo bueno si el cliente reenvía correctamente después.
export function archiveRejectedDocument(input: FinalizeInput): string {
  const { sessionId, tramite, requisito, clienteNombre, pendiente } = input
  const dir = path.join(UPLOADS_DIR, sessionId, slugifyTramite(tramite), RECHAZADOS_SUBDIR)
  fs.mkdirSync(dir, { recursive: true })

  const codigo = buildDocCode(requisito)
  const nombreCliente = slugifyNombre(clienteNombre)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const destino = path.join(dir, `${codigo}_${nombreCliente}_${timestamp}.${pendiente.extension}`)

  fs.renameSync(pendiente.archivoPath, destino)
  return destino
}
