// Traduce el texto de un "[REQUISITOS_DEL_CLIENTE]" del catálogo (conocimiento.md) a un
// código corto y estable para nombrar archivos (ej. "Identificación Oficial" -> "INE").
// Lista curada a mano porque la redacción del requisito varía por trámite ("Identificación
// oficial (INE) del asegurado" vs "Identificación Oficial" a secas) y una sigla no se puede
// derivar de forma confiable solo con un slug automático del texto completo.
const CODIGOS_CONOCIDOS: [RegExp, string][] = [
  [/identificaci[oó]n\s+oficial/i, 'INE'],
  [/comprobante\s+de\s+domicilio/i, 'COMPROBANTE_DOMICILIO'],
  [/formato\s+de\s+servicios\s+asistidos/i, 'FSA'],
  [/formato\s+h107/i, 'H107'],
  [/carta\s+de\s+ratificaci[oó]n\s+de\s+firmas/i, 'CARTA_RATIFICACION_FIRMAS'],
  [/estado\s+de\s+cuenta/i, 'ESTADO_CUENTA'],
  [/tal[oó]n\s+de\s+descuento/i, 'TALON_DESCUENTO'],
  [/acta\s+de\s+defunci[oó]n/i, 'ACTA_DEFUNCION'],
  [/certificado\s+de\s+defunci[oó]n/i, 'CERTIFICADO_DEFUNCION'],
  [/formato\s+de\s+declaraci[oó]n\s+de\s+fallecimiento\s+para\s+beneficiario/i, 'DECLARACION_FALLECIMIENTO_BENEFICIARIO'],
  [/formato\s+de\s+declaraci[oó]n\s+de\s+fallecimiento\s+para\s+medico/i, 'DECLARACION_FALLECIMIENTO_MEDICO'],
  [/formato\s+(gnp\s+)?de\s+identificaci[oó]n\s+del?\s+cliente/i, 'FORMATO_IDENTIFICACION_CLIENTE'],
  [/carta\s+de\s+no\s+siniestralidad/i, 'CARTA_NO_SINIESTRALIDAD'],
  [/vobo\s+subdirecci[oó]n\s+comercial/i, 'VOBO_SUBDIRECCION_COMERCIAL'],
  [/solicitud\s+de\s+seguro/i, 'SOLICITUD_SEGURO'],
  [/carta\s+de\s+asegurado/i, 'CARTA_ASEGURADO'],
  [/acta\s+de\s+nacimiento/i, 'ACTA_NACIMIENTO'],
  [/factura\s+(original\s+)?de\s+la\s+funeraria/i, 'FACTURA_FUNERARIA'],
  [/formato\s+para\s+reembolso\s+de\s+asistencia\s+funeraria/i, 'FORMATO_REEMBOLSO_FUNERARIA'],
  [/^\d*\.?\s*p[oó]liza\.?$/i, 'POLIZA'],
]

function quitarAcentos(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

// Fallback genérico cuando el requisito no matchea ningún código curado: toma las
// primeras palabras significativas y arma un código legible en vez de fallar.
function codigoAutomatico(requisito: string): string {
  const limpio = quitarAcentos(requisito)
    .replace(/\([^)]*\)/g, ' ') // quita paréntesis, ej. "(NO mayor a tres meses)"
    .replace(/[^a-zA-Z\s]/g, ' ')
    .trim()
    .toUpperCase()

  const palabrasVacias = new Set(['DE', 'DEL', 'LA', 'EL', 'LOS', 'LAS', 'Y', 'O', 'A', 'EN', 'PARA', 'CON', 'SU', 'SUS'])
  const palabras = limpio.split(/\s+/).filter(p => p && !palabrasVacias.has(p))

  const codigo = palabras.slice(0, 4).join('_')
  return codigo.slice(0, 40) || 'DOCUMENTO'
}

export function buildDocCode(requisito: string): string {
  for (const [patron, codigo] of CODIGOS_CONOCIDOS) {
    if (patron.test(requisito)) return codigo
  }
  return codigoAutomatico(requisito)
}

// Solo los formatos que la compañía entrega en blanco para que el cliente los llene a mano
// y firme (ver "[ARCHIVOS_A_ENVIAR]" en conocimiento.md) deben pasar por la validación de
// "llenado/firma" calculada por el OCR. Documentos propios del cliente (identificación,
// comprobante de domicilio, estado de cuenta, actas oficiales, etc.) nunca vienen "llenados
// a mano" por él — exigirles esa señal los rechaza siempre, aunque sean válidos.
const REQUISITOS_QUE_REQUIEREN_LLENADO = new Set([
  'FSA',
  'H107',
  'CARTA_RATIFICACION_FIRMAS',
  'DECLARACION_FALLECIMIENTO_BENEFICIARIO',
  'DECLARACION_FALLECIMIENTO_MEDICO',
  'FORMATO_IDENTIFICACION_CLIENTE',
  'CARTA_NO_SINIESTRALIDAD',
  'VOBO_SUBDIRECCION_COMERCIAL',
  'SOLICITUD_SEGURO',
  'CARTA_ASEGURADO',
  'FORMATO_REEMBOLSO_FUNERARIA',
])

export function requiereValidacionDeLlenado(requisito: string): boolean {
  return REQUISITOS_QUE_REQUIEREN_LLENADO.has(buildDocCode(requisito))
}

// "Sonia Miranda Ceballos" -> "SoniaMirandaCeballos". Sin espacios ni acentos para que
// el nombre de archivo sea portable entre sistemas de correo/WhatsApp más adelante.
export function slugifyNombre(nombre: string): string {
  const limpio = quitarAcentos(nombre)
    .replace(/[^a-zA-Z\s]/g, '')
    .trim()

  if (!limpio) return 'Cliente'

  return limpio
    .split(/\s+/)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join('')
}

export function slugifyTramite(tramite: string): string {
  const limpio = quitarAcentos(tramite)
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .toUpperCase()

  return limpio.split(/\s+/).join('_').slice(0, 60)
}
