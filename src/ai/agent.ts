import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { ChatOpenAI } from '@langchain/openai'
import { trimMessages, type BaseMessage } from '@langchain/core/messages'
import { getSystemPrompt } from './system-prompt.js'
import { buscarEnDocumentos } from './tools/local-rag.js'
import { createClasificarTramiteTool } from './tools/clasificar-tramite.js'
import { createRequisitosTramiteTool } from './tools/requisitos-tramite.js'
import { createRegistrarDocumentoTool } from './tools/registrar-documento.js'
import { createEstadoRequisitosTool } from './tools/estado-requisitos.js'
import { obtenerDatosEmpresa } from './tools/datos-empresa.js'
import { verificarCliente } from './tools/verificar-cliente.js'
import { consultarPoliza } from './tools/consultar-poliza.js'

// El historial de conversación de LangGraph vivía solo en RAM (MemorySaver) — se perdía
// en cada reinicio/crash de PM2, obligando al modelo a "olvidar" un trámite a medio
// terminar aunque su progreso real (verificación, documentos) ya vive en SQLite (ver
// db.ts, session-state.ts). Se respalda en su propio archivo SQLite, separado del de la
// app, porque SqliteSaver administra su propio esquema interno (checkpoints/writes).
const DATA_DIR = path.join(process.cwd(), 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })
const checkpointDb = new Database(path.join(DATA_DIR, 'mps-agent-checkpoints.db'))
checkpointDb.pragma('journal_mode = WAL')
const checkpointer = new SqliteSaver(checkpointDb)

export interface AttachmentContextItem {
  source: 'pdf_text' | 'pdf_ocr' | 'pdf_error' | 'image' | 'unsupported_format'
  content: string
  /** Id del adjunto en Chatwoot; con él "registrarDocumentoRecibido" reclama el binario que n8n guardó en /ai/attachments/stage. */
  attachmentId?: string
}

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

// gpt-4o-mini tiene un límite de 128,000 tokens; en producción una conversación larga
// (varios documentos reenviados, cada uno con su texto de OCR embebido) ya llegó a
// 132,602 y tumbó el turno por completo, de forma permanente para esa sesión ahora que
// el historial persiste en disco (antes un reinicio de PM2 lo "arreglaba" por accidente
// al borrar la memoria). Se deja margen amplio bajo el límite real para las funciones
// (~2-3k tokens observados) y la respuesta del modelo. Esto SOLO recorta lo que se le
// manda al LLM en esta llamada (via "llmInputMessages") — el historial completo se sigue
// guardando tal cual en el checkpoint, nunca se borra.
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

// El enum de "clasificarTramite" debe reflejar el catálogo vigente de conocimiento.md,
// así que reconstruimos la herramienta (y el agente) en cada mensaje en vez de una sola
// vez al arrancar el proceso. El estado de la conversación vive en `checkpointer`, no en
// el agente, así que recrearlo no pierde memoria entre turnos.
function buildAgent() {
  const tools = [
    buscarEnDocumentos,
    createClasificarTramiteTool(),
    createRequisitosTramiteTool(),
    createRegistrarDocumentoTool(),
    createEstadoRequisitosTool(),
    obtenerDatosEmpresa,
    verificarCliente,
    consultarPoliza,
  ];
  return createReactAgent({
    llm: model,
    tools,
    checkpointSaver: checkpointer,
    preModelHook: limitarHistorialParaLLM,
  });
}

// Busca, entre los mensajes agregados en ESTE turno (no en todo el historial — un
// trámite clasificado hace muchos turnos, ya verificado o no, no debe afectar la
// decisión de bloqueo de un turno posterior que no tiene nada que ver con él), la
// última clasificación TRAMITE_VALIDO de "clasificarTramite". Parsea el string de
// retorno de esa tool en vez de leer tool_calls porque ese formato ya es un contrato
// estable (ver clasificar-tramite.ts) y evita depender de la forma interna de los
// mensajes de LangGraph.
function extractClassifiedTramite(messages: { content?: unknown }[]): string | null {
  let found: string | null = null
  for (const m of messages) {
    const content = typeof m?.content === 'string' ? m.content : ''
    const match = content.match(/^TRAMITE_VALIDO: "(.+?)" existe en el catálogo/)
    if (match) found = match[1]
  }
  return found
}

function buildUserMessageContent(customerMessage: string, attachmentContext: AttachmentContextItem[]): string {
  const parts = [`<mensaje_cliente>\n${customerMessage}\n</mensaje_cliente>`]

  if (attachmentContext.length > 0) {
    // "llenado"/"firma" NUNCA se exponen aquí al modelo: son una señal calculada por
    // n8n que en la práctica llega incorrecta para documentos que no son formularios
    // (ej. "no" en vez de "desconocido" para una identificación) y el modelo tiende a
    // tratarla como autoritativa aunque el prompt le diga que la ignore para esos casos.
    // Solo "registrarDocumentoRecibido" las lee (vía /attachments/stage), y solo las
    // aplica a formularios reales de la empresa (ver requiereValidacionDeLlenado en
    // doc-code.ts) — el modelo debe confiar únicamente en el resultado de esa tool.
    const adjuntos = attachmentContext
      .map(a => {
        const atributos = [
          `fuente="${a.source}"`,
          a.attachmentId ? `id="${a.attachmentId}"` : null,
        ].filter(Boolean).join(' ')
        return `<adjunto ${atributos}>\n${a.content}\n</adjunto>`
      })
      .join('\n\n')
    parts.push(`<contexto_adjuntos>\n${adjuntos}\n</contexto_adjuntos>`)
  }

  return parts.join('\n\n')
}

export async function processMessage(
  customerMessage: string,
  attachmentContext: AttachmentContextItem[],
  sessionId: string | number,
  timestamp: Date = new Date()
) {

  // Forzamos la conversión a texto estricto
  const config = { configurable: { thread_id: String(sessionId) } }

  const shouldGreet = resolveShouldGreet(String(sessionId), timestamp)
  const currentDateTime = getDisplayDateTime(timestamp)

  const systemMessage = getSystemPrompt({ currentDateTime, shouldGreet });
  const userMessageContent = buildUserMessageContent(customerMessage, attachmentContext)

  const agent = buildAgent()

  // Mensajes ya checkpointeados ANTES de este turno, para poder aislar después solo lo
  // que este turno agregó (ver extractClassifiedTramite).
  let priorMessageCount = 0
  try {
    const stateAntes = await agent.getState(config)
    priorMessageCount = stateAntes?.values?.messages?.length ?? 0
  } catch (error: unknown) {
    console.error(' No se pudo leer el estado previo del checkpointer:', error instanceof Error ? error.message : error)
  }

  const response = await agent.invoke(
    {
      // "id" fijo en el system message: el reducer de mensajes de LangGraph reemplaza en
      // su lugar cualquier mensaje persistido con el mismo id, en vez de agregar uno
      // nuevo — sin esto, cada turno guardaba una copia completa del prompt del sistema
      // (cientos de líneas) en el historial para siempre, inflando el conteo de tokens
      // mucho más rápido que la conversación real del cliente.
      messages: [
        { role: "system", content: systemMessage, id: "system-prompt" },
        { role: "user", content: userMessageContent }
      ]
    },
    config
  )

  const finalMessage = response.messages[response.messages.length - 1];
  const mensajesDeEsteTurno = response.messages.slice(priorMessageCount)
  const tramiteClasificado = extractClassifiedTramite(mensajesDeEsteTurno)

  return { text: finalMessage.content as string, tramiteClasificado };
}