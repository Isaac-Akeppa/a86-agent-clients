import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

// Estado persistente de verificación por sesión (número de serie validado) y del pdf_url
// pendiente de entrega. Vive en disco (SQLite) a propósito: la memoria de conversación de
// LangGraph (checkpointer en agent.ts) puede reiniciarse junto con el proceso, y no debe
// forzar al cliente a volver a validar su número de serie después de un reinicio/crash.
const DATA_DIR = path.join(process.cwd(), 'data')
const DB_PATH = path.join(DATA_DIR, 'a86-agent.db')

fs.mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS sesiones (
    session_id TEXT PRIMARY KEY,
    verificado INTEGER NOT NULL DEFAULT 0,
    pdf_url TEXT,
    clasificacion TEXT,
    actualizado_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

// "CREATE TABLE IF NOT EXISTS" no agrega columnas nuevas a una tabla que ya existía en
// una base previa a este cambio — se agrega a mano, una sola vez, si todavía no está.
const columnasSesiones = db.prepare(`PRAGMA table_info(sesiones)`).all() as { name: string }[]
if (!columnasSesiones.some(c => c.name === 'clasificacion')) {
  db.exec(`ALTER TABLE sesiones ADD COLUMN clasificacion TEXT`)
}

export function marcarSesionVerificada(sessionId: string): void {
  db.prepare(
    `INSERT INTO sesiones (session_id, verificado, actualizado_at)
     VALUES (?, 1, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET
       verificado = 1,
       actualizado_at = datetime('now')`
  ).run(sessionId)
}

export function esSesionVerificada(sessionId: string): boolean {
  const fila = db.prepare(`SELECT verificado FROM sesiones WHERE session_id = ?`).get(sessionId) as
    | { verificado: number }
    | undefined
  return fila?.verificado === 1
}

export function guardarPdfUrlSesion(sessionId: string, pdfUrl: string): void {
  db.prepare(
    `INSERT INTO sesiones (session_id, pdf_url, actualizado_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET
       pdf_url = excluded.pdf_url,
       actualizado_at = datetime('now')`
  ).run(sessionId, pdfUrl)
}

// "Claim" con borrado: una vez entregado, el link (de un solo uso) desaparece para que no
// se reutilice por error en un turno posterior.
export function popPdfUrlSesion(sessionId: string): string | undefined {
  const fila = db.prepare(`SELECT pdf_url as pdfUrl FROM sesiones WHERE session_id = ?`).get(sessionId) as
    | { pdfUrl: string | null }
    | undefined
  if (!fila?.pdfUrl) return undefined
  db.prepare(`UPDATE sesiones SET pdf_url = NULL, actualizado_at = datetime('now') WHERE session_id = ?`).run(sessionId)
  return fila.pdfUrl
}

export function guardarClasificacionSesion(sessionId: string, clasificacion: string): void {
  db.prepare(
    `INSERT INTO sesiones (session_id, clasificacion, actualizado_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET
       clasificacion = excluded.clasificacion,
       actualizado_at = datetime('now')`
  ).run(sessionId, clasificacion)
}

export function getClasificacionSesion(sessionId: string): string | undefined {
  const fila = db.prepare(`SELECT clasificacion FROM sesiones WHERE session_id = ?`).get(sessionId) as
    | { clasificacion: string | null }
    | undefined
  return fila?.clasificacion ?? undefined
}

export default db
