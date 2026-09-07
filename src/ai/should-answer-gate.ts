import { ChatOpenAI } from '@langchain/openai'
import { z } from 'zod'

// Compuerta determinista, separada del agente conversacional principal: SOLO se usa
// cuando una conversación ya tiene una etiqueta de un turno anterior (un humano ya le
// está dando seguimiento a algo fuera del alcance del bot). En ese caso, el bot debe
// quedarse en silencio para cualquier mensaje nuevo que no se pueda resolver con los
// datos reales de la póliza — nunca debe improvisar un "el equipo ya está en eso".
//
// Confiarle esa decisión de "silencio sí/no" al mismo agente grande (con su prompt de
// varias secciones, tono, clasificación, etc.) resultó frágil: en pruebas, el modelo a
// veces ignoraba la instrucción de llamar a "clasificarConversacion" de nuevo y en su
// lugar escribía una respuesta de memoria. Esta compuerta es un modelo aparte, con un
// único trabajo simple y una salida estructurada (no texto libre) — mucho más confiable
// para esta decisión binaria. Si dice que NO es respondible, el agente grande ni
// siquiera se invoca para ese turno: es imposible que "se le escape" una respuesta.
const gateModel = new ChatOpenAI({
  model: 'gpt-4o-mini',
  temperature: 0,
  apiKey: process.env.OPENAI_API_KEY,
})

const outputSchema = z.object({
  respondible: z
    .boolean()
    .describe(
      'true si el mensaje del cliente se puede responder por completo usando ÚNICAMENTE los datos de póliza dados abajo (sin inventar ni suponer nada), O si el cliente está pidiendo el documento/PDF de su póliza (eso el bot lo envía directamente, no necesita a un humano). false para cualquier trámite/acción que SÍ requiera a un humano (cotizar, cancelar, renovar, modificar cobertura, facturación, devoluciones, seguimiento de un siniestro/reparación, quejas) o cualquier otra cosa que esos datos no cubran.'
    ),
})

const structuredGate = gateModel.withStructuredOutput(outputSchema)

export async function puedeResponderseConDatos(customerMessage: string, datosPolizaJson: string): Promise<boolean> {
  try {
    const { respondible } = await structuredGate.invoke([
      {
        role: 'system',
        content:
          'Eres un clasificador. Se te da un mensaje de un cliente de una aseguradora de autos y los datos reales de su póliza. ' +
          'Responde true si ese mensaje se puede contestar COMPLETAMENTE usando SOLO esos datos (vigencia, coberturas, primas, ' +
          'recibos pendientes, datos del vehículo, estatus, etc.), sin inventar, sin suponer, sin buscar en otra fuente. ' +
          'También responde true si el cliente está pidiendo que le envíen el documento/PDF de su póliza (ej. "mándame mi ' +
          'póliza", "quiero el documento", "envíamela en PDF") — eso el bot lo hace directamente por su cuenta, es una ' +
          'función propia, NO requiere a un humano, así que SIEMPRE es true sin importar si el documento resulta estar ' +
          'disponible o no. Cualquier otro trámite o acción que sí requiera a un humano (cotizar, cancelar, renovar, ' +
          'modificar cobertura, facturación, devoluciones, seguimiento de un siniestro/reparación, quejas) o cualquier ' +
          'pregunta que no sea un dato puntual de esta póliza es false, aunque suene relacionado al seguro.\n\n<datos_poliza>\n' +
          datosPolizaJson +
          '\n</datos_poliza>',
      },
      { role: 'user', content: customerMessage },
    ])
    return respondible
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Error desconocido'
    console.error(' [should-answer-gate] Falló la compuerta, se asume NO respondible por seguridad:', errorMessage)
    // Ante una falla técnica de la compuerta, el default seguro es "no respondible": es
    // preferible quedarse en silencio (el humano ya está atendiendo) que arriesgarse a
    // que el bot conteste algo fuera de lugar por un error de esta llamada.
    return false
  }
}
