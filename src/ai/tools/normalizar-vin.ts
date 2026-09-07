// Normaliza un número de serie (VIN) que puede venir tal cual (ej. "KNDJP3A49G7340994")
// o dictado por voz y transcrito por el pipeline de audio (ej. "K de Kilo, N de Niño, D
// de Dedo, 47, 1"). La transcripción deletrea letra por letra con palabras de apoyo
// ("<letra> de <palabra>") y agrupa los dígitos de dos en dos en vez de uno por uno.
// Reconstruir eso a mano es frágil para el modelo (se le escapan o duplican caracteres
// en dictados largos), así que se hace aquí de forma determinista.
const PATRON_LETRA_DE_PALABRA = /^([\p{L}])\s+de\s+\S+/iu

export function normalizarNumeroSerie(raw: string): string {
  const partes = raw
    .split(/[,\n]/)
    .map(parte => parte.trim())
    .filter(Boolean)

  // Sin separadores (el caso típico de un VIN ya escrito tal cual) no hay nada que
  // reconstruir: se usa tal cual, solo normalizando espacios y mayúsculas.
  if (partes.length <= 1) {
    return raw.replace(/\s+/g, '').toUpperCase()
  }

  let resultado = ''
  for (const parteOriginal of partes) {
    const parte = parteOriginal
      .replace(/^(letra|número|numero)\s+/i, '')
      .replace(/[.]+$/, '')
      .trim()
    if (!parte) continue

    const matchLetra = parte.match(PATRON_LETRA_DE_PALABRA)
    if (matchLetra) {
      resultado += matchLetra[1].toUpperCase()
      continue
    }

    if (/^\p{L}$/u.test(parte)) {
      resultado += parte.toUpperCase()
      continue
    }

    if (/^\d+$/.test(parte)) {
      // Un grupo de varios dígitos ("30", "47") representa esos dígitos individuales en
      // el VIN, no un número de dos cifras — concatenar el texto del grupo ya los separa
      // correctamente en sus caracteres.
      resultado += parte
      continue
    }

    // Cualquier otro bloque (ya viene como texto alfanumérico limpio) se agrega tal cual.
    resultado += parte.replace(/\s+/g, '').toUpperCase()
  }

  return resultado
}
