// Estado de verificación por sesión, compartido entre tools que no pueden importarse
// entre sí directamente (verificar-serie.ts escribe, ai-routes.ts lee). Respaldado en
// SQLite (db.ts), no en RAM, para sobrevivir a un reinicio/crash del proceso.
import { marcarSesionVerificada, esSesionVerificada, guardarPdfUrlSesion, popPdfUrlSesion } from '../db.js'

export function markVerified(sessionId: string): void {
  marcarSesionVerificada(sessionId)
}

export function isVerified(sessionId: string): boolean {
  return esSesionVerificada(sessionId)
}

export function setPdfUrl(sessionId: string, pdfUrl: string): void {
  guardarPdfUrlSesion(sessionId, pdfUrl)
}

export function popPdfUrl(sessionId: string): string | undefined {
  return popPdfUrlSesion(sessionId)
}
