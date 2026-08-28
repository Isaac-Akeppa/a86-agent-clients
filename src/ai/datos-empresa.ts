import fs from 'node:fs'
import path from 'node:path'

const FILE_PATH = path.join(process.cwd(), 'assets', 'docs', 'conocimiento.md')

// Campos internos de la sección "INFORMACIÓN GENERAL DE LA EMPRESA" que son
// instrucciones para el modelo, no datos que deba repetirle al cliente.
const CAMPOS_INTERNOS = new Set(['Rol del Agente AI'])

let cachedDatos: Record<string, string> | null = null
let lastModifiedTime = 0

function parseDatosGenerales(rawText: string): Record<string, string> {
  const text = rawText.replace(/\r\n/g, '\n')
  // La sección va desde su encabezado hasta el próximo "---" o "## " (mismo criterio
  // de corte que tramites-catalog.ts usa para las secciones de cada trámite).
  const seccionMatch = text.match(/## 1\. INFORMACIÓN GENERAL DE LA EMPRESA\n([^]*?)(?=\n---|\n## |$)/)
  const seccion = seccionMatch ? seccionMatch[1] : ''

  const datos: Record<string, string> = {}
  const lineaRegex = /^\*\s+\*\*(.+?):\*\*\s*(.+)$/gm
  let match: RegExpExecArray | null
  while ((match = lineaRegex.exec(seccion)) !== null) {
    const campo = match[1].trim()
    if (CAMPOS_INTERNOS.has(campo)) continue
    datos[campo] = match[2].trim()
  }
  return datos
}

// Fuente de verdad determinística para teléfono/dirección/correo/horarios — pensada
// para que el modelo nunca tenga que "completar" estos datos cuando una búsqueda
// semántica (buscarEnDocumentos) no los trae en el mismo resultado que el trámite que
// está resolviendo (ej. un trámite de cancelación que exige dar el teléfono de inmediato,
// pero cuya sección del documento no menciona el teléfono textualmente).
export function getDatosGenerales(): Record<string, string> {
  if (!fs.existsSync(FILE_PATH)) {
    console.warn(` Archivo maestro no encontrado en: ${FILE_PATH}`)
    return {}
  }

  const currentModifiedTime = fs.statSync(FILE_PATH).mtimeMs
  if (cachedDatos && currentModifiedTime === lastModifiedTime) {
    return cachedDatos
  }

  const text = fs.readFileSync(FILE_PATH, 'utf-8')
  cachedDatos = parseDatosGenerales(text)
  lastModifiedTime = currentModifiedTime
  return cachedDatos
}
