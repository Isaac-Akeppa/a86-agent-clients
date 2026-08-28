import fs from 'node:fs'
import path from 'node:path'

const FILE_PATH = path.join(process.cwd(), 'assets', 'docs', 'conocimiento.md')

interface CatalogEntry {
  archivos: string[]
  requisitos: string[]
}

// Único trámite exento de verificación de identidad (ver system-prompt.ts, Sección 2):
// no pide documentos ni datos sensibles, solo canaliza al teléfono/oficina. Centralizado
// aquí para que el prompt y el enforcement en código (ai-routes.ts, requisitos-tramite.ts)
// nunca queden desincronizados sobre cuál es la excepción.
export const TRAMITE_EXENTO_DE_VERIFICACION = 'CANCELACIONES DE PÓLIZA Y DEVOLUCIÓN DE PRIMAS'

let cachedCatalog: Map<string, CatalogEntry> | null = null
let lastModifiedTime = 0

function parseCatalog(rawText: string): Map<string, CatalogEntry> {
  // conocimiento.md trae saltos de línea CRLF; normalizamos a LF porque los regex de
  // línea de abajo usan "$" sin flag /s, que en JS no matchea antes de un "\r" suelto.
  const text = rawText.replace(/\r\n/g, '\n')
  const map = new Map<string, CatalogEntry>()
  const procesoRegex = /^### PROCESO: (.+)$/gm
  const headers = [...text.matchAll(procesoRegex)]

  for (let i = 0; i < headers.length; i++) {
    const nombre = headers[i][1].trim()
    const start = headers[i].index! + headers[i][0].length
    const end = i + 1 < headers.length ? headers[i + 1].index! : text.length
    const block = text.slice(start, end)

    // Requiere el prefijo en negritas ("**[ARCHIVOS_A_ENVIAR]"/"**[REQUISITOS_DEL_CLIENTE]")
    // para no confundir el encabezado real de la sección con referencias cruzadas inline
    // como "...ver [ARCHIVOS_A_ENVIAR])" que aparecen dentro de [REQUISITOS_DEL_CLIENTE].
    const archivosSectionMatch = block.match(/\*\*\[ARCHIVOS_A_ENVIAR\][^]*?(?=\n\*\s*\*\*\[|\n---|\n### |$)/)
    const archivosSection = archivosSectionMatch ? archivosSectionMatch[0] : ''
    const archivos = [...archivosSection.matchAll(/`([^`]+\.\w+)`/g)].map(m => m[1])

    const requisitosSectionMatch = block.match(/\*\*\[REQUISITOS_DEL_CLIENTE\][^]*?(?=\n\*\s*\*\*\[|\n---|\n### |$)/)
    const requisitosSection = requisitosSectionMatch ? requisitosSectionMatch[0] : ''
    // Cada requisito real es una línea con viñeta ("-"/"*") o numerada ("1."); la línea
    // de encabezado nunca matchea porque el recorte empieza en "[REQUISITOS_DEL_CLIENTE]"
    // mismo, no en el "*" de viñeta que lo precede en el markdown original.
    // Algunos requisitos traen una referencia cruzada interna para el redactor del
    // catálogo, ej. "..., ver [ARCHIVOS_A_ENVIAR])" — esa etiqueta es para uso interno
    // y nunca debe llegar al cliente, ya sea que el modelo la copie o que el código arme
    // la lista con "getRequisitosParaTramite" (ver ai-routes.ts, formatearListaPendientes).
    const requisitos = requisitosSection
      .split('\n')
      .map(line => line.match(/^\s*(?:\d+\.|[-*])\s+(.*)$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map(m => m[1].trim())
      .map(texto => texto.replace(/,?\s*ver\s*\[[A-ZÁÉÍÓÚÑ_]+\]/gi, '').trim())
      .filter(Boolean)

    map.set(nombre, { archivos, requisitos })
  }

  return map
}

function getCatalog(): Map<string, CatalogEntry> {
  if (!fs.existsSync(FILE_PATH)) {
    console.warn(` Archivo maestro no encontrado en: ${FILE_PATH}`)
    return new Map()
  }

  const currentModifiedTime = fs.statSync(FILE_PATH).mtimeMs
  if (cachedCatalog && currentModifiedTime === lastModifiedTime) {
    return cachedCatalog
  }

  const text = fs.readFileSync(FILE_PATH, 'utf-8')
  cachedCatalog = parseCatalog(text)
  lastModifiedTime = currentModifiedTime
  return cachedCatalog
}

export function getArchivosParaTramite(nombreTramite: string): string[] {
  return getCatalog().get(resolverNombreTramite(nombreTramite) ?? '')?.archivos ?? []
}

export function getRequisitosParaTramite(nombreTramite: string): string[] {
  return getCatalog().get(resolverNombreTramite(nombreTramite) ?? '')?.requisitos ?? []
}

// El modelo debe pasarle a "registrarDocumentoRecibido" el texto EXACTO de un requisito
// (con backticks, paréntesis, etc.), pero en la práctica lo transcribe con pequeñas
// variaciones (le falta un backtick, cambia un espacio, distinto uso de mayúsculas) — con
// comparación estricta ("==="), eso deja el documento sin registrar para siempre, sin que
// se note (ver registrar-documento.ts). Se compara de forma flexible y se devuelve siempre
// el texto canónico del catálogo, nunca lo que haya escrito el modelo.
function normalizarParaComparar(texto: string): string {
  return texto
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '')
    .toLowerCase()
}

// "clasificarTramite" fuerza al modelo a elegir un nombre EXACTO (enum de Zod), pero las
// etiquetas [TRAMITE_REQUISITOS: ...] / [TRAMITE_FORMULARIOS: ...] son texto libre dentro
// de su propia respuesta — nada obliga a que el modelo escriba el mismo nombre con
// idéntica mayúscula/acentos/espacios en ambas etiquetas del mismo mensaje. Con match
// exacto (antes: `Map.get(nombre.trim())`), una diferencia mínima entre esas dos etiquetas
// hacía que ai-routes.ts creyera que los requisitos nunca se habían resuelto y agregara la
// lista de "respaldo" una segunda vez, justo antes de mandar los formularios adjuntos.
export function resolverNombreTramite(nombreTramite: string): string | null {
  const catalogo = getCatalog()
  if (catalogo.has(nombreTramite)) return nombreTramite

  const objetivo = normalizarParaComparar(nombreTramite)
  for (const nombreReal of catalogo.keys()) {
    if (normalizarParaComparar(nombreReal) === objetivo) return nombreReal
  }
  return null
}

// Muchos requisitos son "<etiqueta corta> (<aclaración>)." (ej. "Identificación Oficial
// (documento propio del cliente, escaneado; no se envía ningún formulario para esto).") y
// el modelo, razonablemente, a veces solo repite la etiqueta corta sin la aclaración entre
// paréntesis — eso NO es un error de transcripción, es visto en producción como uso normal.
// Solo se recorta el paréntesis final (no uno a mitad de frase, ej. "Identificación oficial
// (INE) del asegurado.", donde SÍ es parte del significado) para no confundir dos requisitos
// distintos del mismo trámite que solo se diferencian por esa aclaración final.
function quitarParentesisFinal(texto: string): string {
  let resultado = texto
  let anterior: string
  do {
    anterior = resultado
    resultado = resultado.replace(/\s*\([^()]*\)\.?\s*$/, '')
  } while (resultado !== anterior)
  return resultado
}

// Compara dos textos de requisito de forma tolerante: iguales tal cual, o iguales una vez
// recortada la aclaración final entre paréntesis (ver quitarParentesisFinal). Usado por
// ai-routes.ts para detectar si el modelo reescribió por su cuenta, en prosa y sin
// paréntesis, una lista de requisitos que ya se había insertado vía [TRAMITE_REQUISITOS].
export function sonElMismoRequisito(a: string, b: string): boolean {
  if (normalizarParaComparar(a) === normalizarParaComparar(b)) return true
  return normalizarParaComparar(quitarParentesisFinal(a)) === normalizarParaComparar(quitarParentesisFinal(b))
}

export function encontrarRequisitoCatalogo(nombreTramite: string, requisitoTexto: string): string | null {
  const catalogo = getRequisitosParaTramite(nombreTramite)
  const objetivo = normalizarParaComparar(requisitoTexto)

  const exacto = catalogo.find(r => normalizarParaComparar(r) === objetivo)
  if (exacto) return exacto

  // Segundo intento: comparar solo la etiqueta corta (sin el paréntesis final), y únicamente
  // si un solo requisito del catálogo coincide así — si dos coincidieran, sería ambiguo y es
  // más seguro no adivinar.
  const objetivoCorto = normalizarParaComparar(quitarParentesisFinal(requisitoTexto))
  const coincidencias = catalogo.filter(r => normalizarParaComparar(quitarParentesisFinal(r)) === objetivoCorto)
  return coincidencias.length === 1 ? coincidencias[0] : null
}

export function getTramiteNombres(): string[] {
  return [...getCatalog().keys()]
}

export function buildFileUrl(fileName: string): string {
  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`
  return `${appUrl}/files/docs/${fileName}`
}

export function fileExists(fileName: string): boolean {
  return fs.existsSync(path.join(process.cwd(), 'public', 'docs', fileName))
}
