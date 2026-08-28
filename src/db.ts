import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

// Estado persistente de "qué requisitos ya se recibieron por trámite/sesión" y de los
// archivos que llegan a medio turno (adjuntos_pendientes). Vive en disco (SQLite) a
// propósito: la memoria de conversación de LangGraph (MemorySaver en agent.ts) es
// puramente en RAM y se pierde en cada reinicio/crash de PM2 — este checklist no debe
// depender de que el modelo "recuerde" el historial ni de que el proceso siga vivo.
const DATA_DIR = path.join(process.cwd(), 'data')
const DB_PATH = path.join(DATA_DIR, 'mps-agent.db')

fs.mkdirSync(DATA_DIR, { recursive: true })

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS casos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    tramite TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'abierto',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS documentos_requisito (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    caso_id INTEGER NOT NULL REFERENCES casos(id),
    requisito TEXT NOT NULL,
    estado TEXT NOT NULL DEFAULT 'pendiente',
    motivo_rechazo TEXT,
    archivo_path TEXT,
    archivo_original TEXT,
    recibido_at TEXT,
    UNIQUE(caso_id, requisito)
  );

  CREATE TABLE IF NOT EXISTS adjuntos_pendientes (
    session_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    archivo_path TEXT NOT NULL,
    archivo_original TEXT,
    extension TEXT NOT NULL,
    llenado TEXT NOT NULL DEFAULT 'desconocido',
    firma TEXT NOT NULL DEFAULT 'desconocido',
    creado_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (session_id, attachment_id)
  );

  CREATE TABLE IF NOT EXISTS sesiones (
    session_id TEXT PRIMARY KEY,
    verificado INTEGER NOT NULL DEFAULT 0,
    nombre_cliente TEXT,
    actualizado_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

// "CREATE TABLE IF NOT EXISTS" no agrega columnas nuevas a una tabla que ya existía en
// producción — se agrega a mano, una sola vez, si todavía no está.
const columnasCasos = db.prepare(`PRAGMA table_info(casos)`).all() as { name: string }[]
if (!columnasCasos.some(c => c.name === 'documentos_completos')) {
  db.exec(`ALTER TABLE casos ADD COLUMN documentos_completos INTEGER NOT NULL DEFAULT 0`)
}

// Migración única: las bases ya creadas traían "UNIQUE(session_id, tramite)" en "casos",
// lo que forzaba a reutilizar para siempre el mismo caso (con sus documentos ya marcados
// "recibido") cada vez que el cliente pedía el MISMO tipo de trámite otra vez en la misma
// conversación — un trámite nuevo se daba por completo sin pedir un solo archivo. SQLite
// no permite quitar un constraint con ALTER TABLE: se reconstruye la tabla preservando los
// "id" (de los que depende "documentos_requisito.caso_id") y todos los datos existentes.
const sqlCasos = (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'casos'`).get() as
  | { sql: string }
  | undefined)?.sql ?? ''
if (/UNIQUE\s*\(\s*session_id\s*,\s*tramite\s*\)/i.test(sqlCasos)) {
  // "documentos_requisito.caso_id REFERENCES casos(id)" — este build de SQLite tiene
  // "foreign_keys" activado por default, así que hay que desactivarlo mientras se
  // reconstruye "casos" (si no, el DROP falla). Además: renombrar la tabla vieja a un
  // nombre temporal (en vez de crear la nueva con nombre temporal) hace que SQLite
  // reescriba la referencia de "documentos_requisito" para que "seguía" al nombre viejo
  // — quedaba huérfana al borrarlo. Por eso aquí se crea la tabla nueva primero, se borra
  // la vieja, y RECIÉN ENTONCES se renombra la nueva a "casos" (verificado con
  // PRAGMA foreign_key_check antes de aplicar esto en producción).
  db.pragma('foreign_keys = OFF')
  db.exec(`
    CREATE TABLE casos_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tramite TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'abierto',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      documentos_completos INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO casos_new (id, session_id, tramite, status, created_at, documentos_completos)
      SELECT id, session_id, tramite, status, created_at, documentos_completos FROM casos;
    DROP TABLE casos;
    ALTER TABLE casos_new RENAME TO casos;
  `)
  db.pragma('foreign_keys = ON')
}

export interface AdjuntoPendiente {
  sessionId: string
  attachmentId: string
  archivoPath: string
  archivoOriginal: string | null
  extension: string
  llenado: 'si' | 'no' | 'desconocido'
  firma: 'si' | 'no' | 'desconocido'
}

export function stageAdjunto(input: AdjuntoPendiente): void {
  db.prepare(
    `INSERT INTO adjuntos_pendientes
       (session_id, attachment_id, archivo_path, archivo_original, extension, llenado, firma)
     VALUES (@sessionId, @attachmentId, @archivoPath, @archivoOriginal, @extension, @llenado, @firma)
     ON CONFLICT(session_id, attachment_id) DO UPDATE SET
       archivo_path = excluded.archivo_path,
       archivo_original = excluded.archivo_original,
       extension = excluded.extension,
       llenado = excluded.llenado,
       firma = excluded.firma,
       creado_at = datetime('now')`
  ).run(input)
}

// "Claim" con borrado: una vez que el tool del agente reclama el archivo pendiente,
// desaparece de la cola (igual que popPolizaDownloadUrl en consultar-poliza.ts) para
// que no quede reutilizable por error en un turno posterior.
export function popAdjuntoPendiente(sessionId: string, attachmentId: string): AdjuntoPendiente | undefined {
  const row = db
    .prepare(
      `SELECT session_id as sessionId, attachment_id as attachmentId, archivo_path as archivoPath,
              archivo_original as archivoOriginal, extension, llenado, firma
       FROM adjuntos_pendientes WHERE session_id = ? AND attachment_id = ?`
    )
    .get(sessionId, attachmentId) as AdjuntoPendiente | undefined

  if (row) {
    db.prepare(`DELETE FROM adjuntos_pendientes WHERE session_id = ? AND attachment_id = ?`).run(sessionId, attachmentId)
  }
  return row
}

// Reutiliza el caso ABIERTO más reciente de este trámite para la sesión (para no perder
// progreso a mitad de conversación), pero si el más reciente ya tiene todos sus documentos
// (documentos_completos = 1) abre uno NUEVO — cada vez que el cliente pide el mismo tipo
// de trámite otra vez es un proceso distinto, con sus propios archivos, no una continuación
// del anterior.
export function getOrCreateCaso(sessionId: string, tramite: string): number {
  const existing = db
    .prepare(
      `SELECT id FROM casos WHERE session_id = ? AND tramite = ? AND documentos_completos = 0 ORDER BY id DESC LIMIT 1`
    )
    .get(sessionId, tramite) as { id: number } | undefined
  if (existing) return existing.id

  const result = db
    .prepare(`INSERT INTO casos (session_id, tramite) VALUES (?, ?)`)
    .run(sessionId, tramite)
  return result.lastInsertRowid as number
}

export interface RegistroDocumento {
  estado: 'recibido' | 'rechazado'
  archivoPath?: string
  archivoOriginal?: string | null
  motivoRechazo?: string
}

export function marcarDocumento(casoId: number, requisito: string, registro: RegistroDocumento): void {
  db.prepare(
    `INSERT INTO documentos_requisito (caso_id, requisito, estado, motivo_rechazo, archivo_path, archivo_original, recibido_at)
     VALUES (@casoId, @requisito, @estado, @motivoRechazo, @archivoPath, @archivoOriginal, datetime('now'))
     ON CONFLICT(caso_id, requisito) DO UPDATE SET
       estado = excluded.estado,
       motivo_rechazo = excluded.motivo_rechazo,
       archivo_path = excluded.archivo_path,
       archivo_original = excluded.archivo_original,
       recibido_at = datetime('now')`
  ).run({
    casoId,
    requisito,
    estado: registro.estado,
    motivoRechazo: registro.motivoRechazo ?? null,
    archivoPath: registro.archivoPath ?? null,
    archivoOriginal: registro.archivoOriginal ?? null,
  })
}

// Los archivos ya validados (estado 'recibido') de un caso, con su ruta real en disco —
// para armar la nota privada con los documentos correctamente nombrados que ve el asesor
// humano al retomar el trámite (nunca al cliente, ver registrar-documento.ts).
export function getArchivosValidados(casoId: number): { requisito: string; archivoPath: string }[] {
  return db
    .prepare(
      `SELECT requisito, archivo_path as archivoPath FROM documentos_requisito
       WHERE caso_id = ? AND estado = 'recibido' AND archivo_path IS NOT NULL`
    )
    .all(casoId) as { requisito: string; archivoPath: string }[]
}

// Marca el caso como "documentos completos" — pero SOLO devuelve true la primera vez que
// ocurre esa transición (0 -> 1). Así ai-routes.ts puede avisar a n8n exactamente una vez,
// en el turno real en que el último requisito quedó recibido, sin importar que el cliente
// reenvíe después algo ya aceptado (lo que dejaría "documentos_completos" en 1 sin volver
// a marcar el cambio como nuevo).
export function marcarCasoCompletadoSiEsNuevo(casoId: number): boolean {
  const resultado = db
    .prepare(`UPDATE casos SET documentos_completos = 1 WHERE id = ? AND documentos_completos = 0`)
    .run(casoId)
  return resultado.changes > 0
}

export interface EstadoRequisitos {
  recibidos: { requisito: string; archivoOriginal: string | null }[]
  rechazados: { requisito: string; motivo: string | null }[]
  pendientes: string[]
}

// Fuente de verdad para "qué falta": lee el estado real guardado en SQLite, no el
// historial de la conversación. requisitosCatalogo siempre viene de tramites-catalog.ts
// (conocimiento.md) para no depender de que este registro haya quedado desactualizado
// si el catálogo cambió.
export function getEstadoRequisitos(sessionId: string, tramite: string, requisitosCatalogo: string[]): EstadoRequisitos {
  // El más reciente (nunca uno viejo ya completado de una vez anterior del mismo trámite,
  // ver getOrCreateCaso) — así "obtenerEstadoRequisitos" y "registrarDocumentoRecibido"
  // siempre están de acuerdo sobre cuál es el caso "actual".
  const caso = db
    .prepare(`SELECT id FROM casos WHERE session_id = ? AND tramite = ? ORDER BY id DESC LIMIT 1`)
    .get(sessionId, tramite) as { id: number } | undefined

  if (!caso) {
    return { recibidos: [], rechazados: [], pendientes: [...requisitosCatalogo] }
  }

  const filas = db
    .prepare(`SELECT requisito, estado, motivo_rechazo as motivoRechazo, archivo_original as archivoOriginal FROM documentos_requisito WHERE caso_id = ?`)
    .all(caso.id) as { requisito: string; estado: string; motivoRechazo: string | null; archivoOriginal: string | null }[]

  const porRequisito = new Map(filas.map(f => [f.requisito, f]))

  const recibidos: EstadoRequisitos['recibidos'] = []
  const rechazados: EstadoRequisitos['rechazados'] = []
  const pendientes: string[] = []

  for (const requisito of requisitosCatalogo) {
    const fila = porRequisito.get(requisito)
    if (fila?.estado === 'recibido') {
      recibidos.push({ requisito, archivoOriginal: fila.archivoOriginal })
    } else if (fila?.estado === 'rechazado') {
      rechazados.push({ requisito, motivo: fila.motivoRechazo })
    } else {
      pendientes.push(requisito)
    }
  }

  return { recibidos, rechazados, pendientes }
}

// Estado de verificación de identidad + nombre del cliente por sesión. Antes vivía en
// Maps/Sets en RAM (session-state.ts) — se perdía en cada reinicio/crash de PM2 (mismo
// problema que ya se había resuelto para el checklist de documentos, ver comentario al
// inicio del archivo), forzando al cliente a re-verificarse a mitad de un trámite en curso
// aunque nada de su progreso real se hubiera perdido.
export function guardarNombreClienteSesion(sessionId: string, nombreCliente: string): void {
  db.prepare(
    `INSERT INTO sesiones (session_id, nombre_cliente, actualizado_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(session_id) DO UPDATE SET
       nombre_cliente = excluded.nombre_cliente,
       actualizado_at = datetime('now')`
  ).run(sessionId, nombreCliente)
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

export function getNombreClienteSesion(sessionId: string): string | undefined {
  const fila = db.prepare(`SELECT nombre_cliente as nombreCliente FROM sesiones WHERE session_id = ?`).get(sessionId) as
    | { nombreCliente: string | null }
    | undefined
  return fila?.nombreCliente ?? undefined
}

// Al completarse un trámite, la verificación (y el nombre cacheado) de la sesión se
// invalida — el prompt le prohíbe al modelo volver a pedir identidad "para otros
// trámites" una vez verificado, así que sin este reset el nombre de un cliente viejo
// (de una prueba o trámite anterior ya cerrado) se seguía usando para nombrar los
// archivos de quien sea que continúe la MISMA conversación después, sin importar que
// fuera un trámite distinto o hasta una persona distinta. Ver marcarCasoCompletadoSiEsNuevo.
export function reiniciarVerificacionSesion(sessionId: string): void {
  db.prepare(
    `UPDATE sesiones SET verificado = 0, nombre_cliente = NULL, actualizado_at = datetime('now') WHERE session_id = ?`
  ).run(sessionId)
}

export default db
