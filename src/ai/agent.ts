import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { ChatOpenAI } from '@langchain/openai'
import { trimMessages, type BaseMessage } from '@langchain/core/messages'
import { getSystemPrompt } from './system-prompt.js'
import { verificarNumeroSerie } from './tools/verificar-serie.js'
import { clasificarConversacion } from './tools/clasificar-conversacion.js'
import { getClassification, popSuppressResponse, getPolicyData, isVerified } from './session-state.js'
import { puedeResponderseConDatos } from './should-answer-gate.js'

// El historial de conversación de LangGraph vivía solo en RAM (MemorySaver) — se perdía
// en cada reinicio/crash del proceso. Se respalda en su propio archivo SQLite, separado
// del de la app, porque SqliteSaver administra su propio esquema interno.
const DATA_DIR = path.join(process.cwd(), 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })
const checkpointDb = new Database(path.join(DATA_DIR, 'a86-agent-checkpoints.db'))
checkpointDb.pragma('journal_mode = WAL')
const checkpointer = new SqliteSaver(checkpointDb)

// Zona horaria de referencia para "día" del cliente. Ajusta si la operación no es en CDMX.
const TIMEZONE = 'America/Mexico_City'

// Recuerda, por sesión, la última fecha (YYYY-MM-DD en TIMEZONE) en la que hubo interacción.
// Nota: es en memoria, igual que el checkpointer; se reinicia si el proceso se reinicia.
const lastInteractionDateBySession = new Map<string, string>()

function getDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(date) // YYYY-MM-DD
}

function getDisplayDateTime(date: Date): string {
  return new Intl.DateTimeFormat('es-MX', {
    timeZone: TIMEZONE,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(date)
}

// Determina si es la primera interacción del día con este cliente y actualiza el registro.
function resolveShouldGreet(sessionId: string, timestamp: Date): boolean {
  const key = String(sessionId)
  const todayKey = getDateKey(timestamp)
  const lastKey = lastInteractionDateBySession.get(key)
  lastInteractionDateBySession.set(key, todayKey)
  return lastKey !== todayKey
}

const model = new ChatOpenAI({
  model: "gpt-4o-mini",
  temperature: 0,
  apiKey: process.env.OPENAI_API_KEY
});

// Cuántos mensajes RECIENTES (no tokens — ver "tokenCounter" abajo) se le mandan al LLM en
// cada turno. El historial completo se sigue guardando tal cual en el checkpoint, nunca se
// borra — esto SOLO recorta lo que ve el modelo en esta llamada puntual.
//
// Antes esto se acotaba por presupuesto de tokens (hasta 100,000, prácticamente "todo el
// historial" en la práctica). Eso resultó frágil en conversaciones largas y con mucho
// ruido (varios intentos fallidos de VIN, dictados de audio mal transcritos, etc.): aunque
// el system prompt de este mismo turno diga explícitamente "ya validado: SÍ" con los datos
// reales (ver system-prompt.ts / getSystemPrompt), el modelo le daba más peso al patrón
// repetido en su propio historial ("pedir el VIN", "SERIE_NO_ENCONTRADA"...) que a esa
// instrucción fresca, y volvía a pedir el número de serie de todos modos.
//
// La solución no es "instruir mejor" — es no depender de que el modelo recuerde nada viejo:
// el estado de validación y los datos de póliza ya viajan determinísticamente en el system
// prompt CADA turno (calculados desde la DB, no desde el historial), así que el historial
// que sí ve el modelo puede acotarse de forma agresiva a solo lo reciente, sin perder esa
// información. Esto es automático para toda sesión, no un parche manual por conversación.
const MAX_MENSAJES_HISTORIAL_LLM = 20

async function limitarHistorialParaLLM(state: { messages: BaseMessage[] }) {
  const llmInputMessages = await trimMessages(state.messages, {
    maxTokens: MAX_MENSAJES_HISTORIAL_LLM,
    tokenCounter: (messages: BaseMessage[]) => messages.length,
    strategy: 'last',
    includeSystem: true,
    startOn: 'human',
  })
  return { llmInputMessages }
}

function buildAgent() {
  const tools = [verificarNumeroSerie, clasificarConversacion]
  return createReactAgent({
    llm: model,
    tools,
    checkpointSaver: checkpointer,
    preModelHook: limitarHistorialParaLLM,
  });
}

export async function processMessage(
  customerMessage: string,
  sessionId: string | number,
  timestamp: Date = new Date()
) {
  const sessionIdStr = String(sessionId)

  // Se fija UNA sola vez, antes de invocar al agente, y se le pasa a las tools vía
  // config.configurable — no una lectura en vivo de la DB dentro de la tool. Así, si el
  // modelo llama "clasificarConversacion" más de una vez en este mismo turno (ej. se
  // corrige a media respuesta), todas esas llamadas ven el mismo estado "de antes del
  // turno" en vez de que la segunda llamada se confunda con la primera y crea que la
  // conversación "ya estaba" clasificada por un turno anterior.
  const yaClasificadoAntes = Boolean(getClassification(sessionIdStr))

  // Se calculan UNA vez aquí, deterministas desde la DB — no algo que el modelo tenga que
  // inferir buscando en el historial de mensajes. En conversaciones largas/ruidosas (muchos
  // intentos de VIN, adjuntos, etc.) confiarle "¿ya estoy validado?" solo a la memoria del
  // modelo sobre su propio historial resultó frágil: volvía a pedir el número de serie
  // aunque la validación siguiera vigente. Esto se inyecta directamente en el system
  // prompt (ver system-prompt.ts) como la fuente de verdad de este turno.
  const yaValidado = isVerified(sessionIdStr)
  const datosPoliza = getPolicyData(sessionIdStr)

  // Compuerta determinista (should-answer-gate.ts): si la conversación YA está
  // canalizada a un humano, no se invoca al agente conversacional grande a menos que este
  // mensaje se pueda responder con datos reales ya conocidos — así es imposible que el
  // agente improvise una respuesta tipo "el equipo ya está en eso" en vez de quedarse
  // callado (ver historial de este archivo: confiarle esa decisión solo al system prompt
  // del agente grande resultó frágil).
  if (yaClasificadoAntes) {
    if (!yaValidado) {
      // Nunca se validó en esta conversación: no hay forma de que esto sea respondible
      // con datos reales de póliza.
      return { text: '', suprimirRespuesta: true, classification: null }
    }

    if (datosPoliza) {
      const respondible = await puedeResponderseConDatos(customerMessage, datosPoliza)
      if (!respondible) {
        return { text: '', suprimirRespuesta: true, classification: null }
      }
    }
    // Si el cliente SÍ está validado pero no hay "poliza_json" cacheado (ej. se validó
    // antes de que este caché existiera, o cualquier otro caso límite), no se bloquea de
    // más: se deja pasar al agente grande, que ahora también recibe "yaValidado" directo
    // en el system prompt (ver abajo), no solo del historial de la conversación.
  }

  const config = { configurable: { thread_id: sessionIdStr, yaClasificadoAntes } }

  const shouldGreet = resolveShouldGreet(sessionIdStr, timestamp)
  const currentDateTime = getDisplayDateTime(timestamp)

  const systemMessage = getSystemPrompt({ currentDateTime, shouldGreet, yaValidado, datosPolizaJson: datosPoliza });

  const agent = buildAgent()

  const response = await agent.invoke(
    {
      // "id" fijo en el system message: el reducer de mensajes de LangGraph reemplaza en
      // su lugar cualquier mensaje persistido con el mismo id, en vez de agregar uno
      // nuevo — sin esto, cada turno guardaba una copia completa del prompt del sistema
      // en el historial para siempre, inflando el conteo de tokens innecesariamente.
      messages: [
        { role: "system", content: systemMessage, id: "system-prompt" },
        { role: "user", content: customerMessage }
      ]
    },
    config
  )

  const finalMessage = response.messages[response.messages.length - 1];

  // "suprimirRespuesta": la conversación ya tenía etiqueta antes de este turno y el
  // modelo intentó clasificar de nuevo (es decir, esto no lo puede resolver con datos
  // reales) — un humano ya le está dando seguimiento, así que este turno no debe
  // mostrarle nada al cliente ni tocar la etiqueta. Se decide aquí, de forma
  // determinista, sin importar qué haya escrito el modelo en su respuesta final.
  const suprimirRespuesta = popSuppressResponse(sessionIdStr)

  // "classification" solo viaja al backend/n8n cuando se fijó POR PRIMERA VEZ en este
  // turno (transición null -> valor) — si ya venía clasificada de antes, no se vuelve a
  // notificar, para no reaplicar la etiqueta en Chatwoot en cada turno subsecuente.
  const classification = yaClasificadoAntes ? null : (getClassification(sessionIdStr) ?? null)

  return { text: finalMessage.content as string, suprimirRespuesta, classification };
}
