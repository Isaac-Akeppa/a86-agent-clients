// Estado de verificación/nombre por sesión, compartido entre tools que no pueden importarse
// entre sí directamente (verificar-cliente.ts / consultar-poliza.ts escriben, registrar-
// documento.ts y ai-routes.ts leen). Respaldado en SQLite (db.ts) — no en RAM — porque en
// producción un trámite puede tardar varios turnos en completarse y un reinicio/crash de PM2
// a mitad de camino no debe forzar al cliente a re-verificarse desde cero (se observó
// exactamente esto: el checklist de documentos sobrevivía al reinicio pero la verificación
// no, porque solo el checklist ya vivía en SQLite).
import { guardarNombreClienteSesion, marcarSesionVerificada, esSesionVerificada, getNombreClienteSesion } from '../db.js'

export function setClientName(sessionId: string, nombre: string): void {
  guardarNombreClienteSesion(sessionId, nombre)
}

export function getClientName(sessionId: string): string | undefined {
  return getNombreClienteSesion(sessionId)
}

export function markVerified(sessionId: string): void {
  marcarSesionVerificada(sessionId)
}

export function isVerified(sessionId: string): boolean {
  return esSesionVerificada(sessionId)
}
