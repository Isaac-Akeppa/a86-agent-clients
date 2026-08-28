// Cliente para la API de validación de pólizas (contrato real, ver
// api-validador-polizas.md). La expone MPS-WA; este proyecto es el consumidor.
// La usan tanto "verificarCliente" (verificar-cliente.ts, verificación genérica
// antes de cualquier trámite) como "consultarPoliza" (consultar-poliza.ts, consulta
// de datos / descarga de póliza): es la misma API y el mismo request; lo único que
// cambia es qué campos de la respuesta le interesan a cada tool.
const REQUEST_TIMEOUT_MS = 10_000

export const REQUEST_FIELDS = {
  nombre: 'nombre',
  numeroPoliza: 'numero_poliza',
  rfc: 'rfc',
} as const

export const RESPONSE_FIELDS = {
  status: 'status',
  poliza: 'poliza',
  message: 'message',
  // Single-use, expira en 10 minutos (Cache::pull en el servidor consume el token en
  // el primer GET). También viene duplicado dentro de "poliza.pdf_url".
  pdfUrl: 'pdf_url',
} as const

// La API no tiene autenticación por ahora (ver api-validador-polizas.md, sección
// "Autenticación"). Aislado en su propia función para agregar un bearer token
// fácilmente si se protege más adelante.
function buildAuthHeaders(): Record<string, string> {
  return {}
}

export interface ClientVerifyInput {
  nombre: string
  numeroPoliza: string
  rfc: string
}

export type PolizaData = Record<string, unknown>

export type ClientVerifyResultado =
  | { status: 'encontrado'; poliza: PolizaData; pdfUrl: string | null }
  | { status: 'no_encontrado' }
  | { status: 'error' }

async function callVerifyApi(input: ClientVerifyInput): Promise<Response> {
  const url = process.env.CLIENT_VERIFY_API_URL
  if (!url) {
    throw new Error('CLIENT_VERIFY_API_URL no está configurada')
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    return await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...buildAuthHeaders(),
      },
      body: JSON.stringify({
        [REQUEST_FIELDS.nombre]: input.nombre,
        [REQUEST_FIELDS.numeroPoliza]: input.numeroPoliza,
        [REQUEST_FIELDS.rfc]: input.rfc,
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

async function consultarClienteIntento(input: ClientVerifyInput): Promise<ClientVerifyResultado> {
  const response = await callVerifyApi(input)

  // La API responde 200 tanto para encontrado como para no encontrado (usa el
  // campo "status" del body); un status HTTP != 2xx (422 de validación, 5xx, etc.)
  // sí cuenta como falla real y dispara el reintento.
  if (!response.ok) {
    throw new Error(`API de validación de pólizas respondió con status ${response.status}`)
  }

  const data = (await response.json()) as Record<string, unknown>

  if (data[RESPONSE_FIELDS.status] === false) {
    return { status: 'no_encontrado' }
  }

  const poliza = data[RESPONSE_FIELDS.poliza]
  const pdfUrl = data[RESPONSE_FIELDS.pdfUrl]

  return {
    status: 'encontrado',
    poliza: (poliza && typeof poliza === 'object' ? poliza : {}) as PolizaData,
    pdfUrl: typeof pdfUrl === 'string' ? pdfUrl : null,
  }
}

// Reintenta una sola vez ante error de red, timeout o falla del servidor (ver regla
// de negocio: 1 intento + 1 reintento antes de reportar problema técnico).
export async function consultarClienteConReintento(input: ClientVerifyInput): Promise<ClientVerifyResultado> {
  const maxIntentos = 2

  for (let intento = 1; intento <= maxIntentos; intento++) {
    try {
      return await consultarClienteIntento(input)
    } catch (error: any) {
      console.error(` [client-verify-api] Intento ${intento}/${maxIntentos} falló:`, error.message)
      if (intento === maxIntentos) {
        return { status: 'error' }
      }
    }
  }

  return { status: 'error' }
}
