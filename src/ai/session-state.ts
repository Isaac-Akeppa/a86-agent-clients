// Estado de verificación por sesión, compartido entre tools que no pueden importarse
// entre sí directamente (verificar-serie.ts escribe, ai-routes.ts lee). Respaldado en
// SQLite (db.ts), no en RAM, para sobrevivir a un reinicio/crash del proceso.
import {
  marcarSesionVerificada,
  esSesionVerificada,
  guardarPdfUrlSesion,
  popPdfUrlSesion,
  guardarNumeroPolizaSesion,
  popNumeroPolizaSesion,
  guardarClasificacionSesion,
  getClasificacionSesion,
  marcarSupresionRespuestaSesion,
  popSupresionRespuestaSesion,
  guardarPolizaJsonSesion,
  getPolizaJsonSesion,
} from '../db.js'

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

export function setPolicyNumber(sessionId: string, numeroPoliza: string): void {
  guardarNumeroPolizaSesion(sessionId, numeroPoliza)
}

export function popPolicyNumber(sessionId: string): string | undefined {
  return popNumeroPolizaSesion(sessionId)
}

export function setClassification(sessionId: string, clasificacion: string): void {
  guardarClasificacionSesion(sessionId, clasificacion)
}

export function getClassification(sessionId: string): string | undefined {
  return getClasificacionSesion(sessionId)
}

export function markSuppressResponse(sessionId: string): void {
  marcarSupresionRespuestaSesion(sessionId)
}

export function popSuppressResponse(sessionId: string): boolean {
  return popSupresionRespuestaSesion(sessionId)
}

export function setPolicyData(sessionId: string, polizaJson: string): void {
  guardarPolizaJsonSesion(sessionId, polizaJson)
}

export function getPolicyData(sessionId: string): string | undefined {
  return getPolizaJsonSesion(sessionId)
}
