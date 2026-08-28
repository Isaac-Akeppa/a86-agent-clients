import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { ChatOpenAI } from '@langchain/openai'
import { trimMessages, type BaseMessage } from '@langchain/core/messages'
import { getSystemPrompt } from './system-prompt.js'
import { verificarNumeroSerie } from './tools/verificar-serie.js'

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

// gpt-4o-mini tiene un límite de 128,000 tokens. Se deja margen amplio bajo el límite real
// para las funciones y la respuesta del modelo. Esto SOLO recorta lo que se le manda al LLM
// en esta llamada (via "llmInputMessages") — el historial completo se sigue guardando tal
// cual en el checkpoint, nunca se borra.
const MAX_TOKENS_HISTORIAL_LLM = 100_000

async function limitarHistorialParaLLM(state: { messages: BaseMessage[] }) {
  const llmInputMessages = await trimMessages(state.messages, {
    maxTokens: MAX_TOKENS_HISTORIAL_LLM,
    tokenCounter: model,
    strategy: 'last',
    includeSystem: true,
    startOn: 'human',
  })
  return { llmInputMessages }
}

function buildAgent() {
  const tools = [verificarNumeroSerie]
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
  const config = { configurable: { thread_id: String(sessionId) } }

  const shouldGreet = resolveShouldGreet(String(sessionId), timestamp)
  const currentDateTime = getDisplayDateTime(timestamp)

  const systemMessage = getSystemPrompt({ currentDateTime, shouldGreet });

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

  return { text: finalMessage.content as string };
}
