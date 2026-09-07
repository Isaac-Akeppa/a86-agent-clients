// Cliente para la API de validación de pólizas por número de serie del vehículo.
// Requiere un bearer token (ver CAR_VALIDATE_API_TOKEN en .env).
const REQUEST_TIMEOUT_MS = 10_000

export type PolizaData = Record<string, unknown>
export type RecibosPendientes = Record<string, unknown>

export type CarVerifyResultado =
  | { status: 'encontrada'; poliza: PolizaData; recibosPendientes: RecibosPendientes | null; pdfUrl: string | null }
  | { status: 'no_encontrada' }
  | { status: 'error' }

async function callVerifyApi(numeroSerie: string): Promise<Response> {
  const baseUrl = process.env.CAR_VALIDATE_API_URL
  const token = process.env.CAR_VALIDATE_API_TOKEN
  if (!baseUrl) throw new Error('CAR_VALIDATE_API_URL no está configurada')
  if (!token) throw new Error('CAR_VALIDATE_API_TOKEN no está configurada')

  const url = `${baseUrl}?numero_serie=${encodeURIComponent(numeroSerie)}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    return await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

async function consultarSerieIntento(numeroSerie: string): Promise<CarVerifyResultado> {
  const response = await callVerifyApi(numeroSerie)

  if (!response.ok) {
    throw new Error(`API de validación respondió con status ${response.status}`)
  }

  const data = (await response.json()) as Record<string, unknown>

  if (data.encontrada !== true) {
    return { status: 'no_encontrada' }
  }

  const poliza = data.poliza
  const recibosPendientes = data.recibos_pendientes
  const pdfUrl = data.pdf_url

  return {
    status: 'encontrada',
    poliza: (poliza && typeof poliza === 'object' ? poliza : {}) as PolizaData,
    recibosPendientes: (recibosPendientes && typeof recibosPendientes === 'object' ? recibosPendientes : null) as RecibosPendientes | null,
    pdfUrl: typeof pdfUrl === 'string' ? pdfUrl : null,
  }
}

const REINTENTO_DELAY_MS = 1_000

function esperar(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Reintenta una sola vez ante error de red, timeout o falla del servidor. Espera un poco
// antes del segundo intento porque el fallo típico es un DNS lookup que falla de forma
// transitoria (ENOTFOUND intermitente) — reintentar de inmediato suele pegarle al mismo
// bache en vez de darle tiempo a recuperarse.
export async function consultarSerieConReintento(numeroSerie: string): Promise<CarVerifyResultado> {
  const maxIntentos = 2

  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      return await consultarSerieIntento(numeroSerie)
    } catch (error: any) {
      console.error(` [car-verify-api] Intento ${intento}/${maxIntentos} falló:`, error.message)
      if (intento === maxIntentos) {
        return { status: 'error' }
      }
      await esperar(REINTENTO_DELAY_MS)
    }
  }

  return { status: 'error' }
}
