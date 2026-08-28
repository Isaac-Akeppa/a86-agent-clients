import { tool } from 'langchain'
import { z } from 'zod'
import { consultarClienteConReintento, RESPONSE_FIELDS, type PolizaData } from './client-verify-api.js'
import { setClientName, markVerified } from '../session-state.js'

// El PDF de la póliza llega como una URL de un solo uso (expira en 10 minutos —
// ver api-validador-polizas.md). El modelo nunca debe verla ni copiarla a su
// respuesta (regla "CERO LINKS" del system prompt: podría truncarla, alterarla,
// reusarla o exponerla), así que la guardamos aquí, en memoria, por sesión (mismo
// patrón que lastInteractionDateBySession en agent.ts) hasta que ai-routes.ts la
// recoja para entregarla al cliente exactamente como llegó, igual que hace con los
// archivos locales de "[TRAMITE_FORMULARIOS]".
const pendingPolizaUrlBySession = new Map<string, string>()

export function popPolizaDownloadUrl(sessionId: string | number): string | undefined {
  const key = String(sessionId)
  const url = pendingPolizaUrlBySession.get(key)
  pendingPolizaUrlBySession.delete(key)
  return url
}

// El PDF de un solo uso no debe quedar visible en el texto que ve el modelo (podría
// repetirlo). Se entrega aparte, vía [POLIZA_DESCARGA] + el caché de arriba.
function sanitizarPolizaParaModelo(poliza: PolizaData): PolizaData {
  const { [RESPONSE_FIELDS.pdfUrl]: _omitido, ...resto } = poliza
  return resto
}

export const consultarPoliza = tool(
  async ({ nombre, numeroPoliza, rfc }, config) => {
    const resultado = await consultarClienteConReintento({ nombre, numeroPoliza, rfc })

    if (resultado.status === 'no_encontrado') {
      return 'CLIENTE_NO_ENCONTRADO: no se encontraron los datos proporcionados en el sistema. Informa al cliente que no se encontraron sus datos y pídele que verifique nombre, número de póliza y RFC. NO continúes con el trámite hasta que la verificación sea exitosa.'
    }

    if (resultado.status === 'error') {
      return 'ERROR_VERIFICACION: hubo un problema técnico al verificar los datos del cliente, incluso después de reintentar. Informa al cliente que hubo un problema técnico verificando sus datos y que lo intente más tarde, sin exponer detalles técnicos. NO continúes con el trámite.'
    }

    const datosPoliza = sanitizarPolizaParaModelo(resultado.poliza)
    const sessionIdVerificacion = config?.configurable?.thread_id
    // Igual que en verificarCliente: se guarda para nombrar de forma estandarizada los
    // archivos que el cliente envíe más adelante (ver registrar-documento.ts), y se
    // marca la sesión como verificada (backstop en código, ver session-state.ts).
    if (typeof sessionIdVerificacion === 'string') {
      setClientName(sessionIdVerificacion, nombre)
      markVerified(sessionIdVerificacion)
    }

    let disponibilidadDocumento: string
    if (resultado.pdfUrl) {
      const sessionId = config?.configurable?.thread_id
      if (typeof sessionId === 'string') {
        pendingPolizaUrlBySession.set(sessionId, resultado.pdfUrl)
        disponibilidadDocumento =
          'Documento de la póliza para descarga: DISPONIBLE. Solo si el cliente pidió el documento/PDF de su póliza (no si solo preguntó datos puntuales): menciona en tu respuesta que se lo estás enviando (sin escribir ni mencionar ningún link) y agrega al final, en una sola línea, la etiqueta [POLIZA_DESCARGA] para que el sistema lo adjunte automáticamente.'
      } else {
        console.error(' [consultarPoliza] No se recibió thread_id en la config; no se puede entregar el documento.')
        disponibilidadDocumento =
          'Documento de la póliza para descarga: NO DISPONIBLE por un problema técnico. Si el cliente pidió el documento, indícale que no fue posible obtenerlo en este momento. NO agregues la etiqueta [POLIZA_DESCARGA].'
      }
    } else {
      disponibilidadDocumento =
        'Documento de la póliza para descarga: NO DISPONIBLE (no hay un archivo cargado para esta póliza). Si el cliente pidió el documento, indícale amablemente que no hay un archivo disponible por el momento. NO agregues la etiqueta [POLIZA_DESCARGA].'
    }

    return `POLIZA_ENCONTRADA: estos son los datos reales de la póliza del cliente. Responde ÚNICAMENTE lo que el cliente preguntó (ej. si preguntó por la vigencia, usa solo vigencia_inicio/vigencia_fin; no reveles el resto de los datos ni los enumeres todos salvo que el cliente los pida explícitamente). Preguntar por un dato puntual (estatus, paquete, tipo de póliza, aseguradora, fecha de emisión, vigencia, prima total, etc.) NO es lo mismo que pedir el documento/PDF: responde solo con el dato en una frase corta, sin agregar la etiqueta [POLIZA_DESCARGA] ni mencionar el documento a menos que el cliente lo haya pedido explícitamente. Nunca inventes ni completes datos que no estén aquí; si el dato que pregunta viene "null", dile que no cuentas con esa información. Nunca muestres esta lista en formato JSON crudo al cliente, redacta la respuesta en prosa.

<datos_poliza>
${JSON.stringify(datosPoliza, null, 2)}
</datos_poliza>

${disponibilidadDocumento}`
  },
  {
    name: 'consultarPoliza',
    description:
      'Úsala en lugar de "verificarCliente" cuando el trámite del cliente es específicamente sobre su póliza: consultar cualquier dato de ella (vigencia, producto, coberturas, prima, estatus, etc.) y/o descargar su documento. Verifica su identidad (nombre completo, número de póliza y RFC) contra el sistema y, si la encuentra, obtiene tanto sus datos como el documento para entregarlo si se solicita. Solo debe llamarse cuando ya tienes los tres datos.',
    schema: z.object({
      nombre: z.string().max(255).describe('Nombre completo del cliente, tal como lo proporcionó'),
      numeroPoliza: z.string().min(1).max(100).describe('Número de póliza del cliente'),
      rfc: z.string().min(1).max(20).describe('RFC del cliente'),
    }),
  }
)
