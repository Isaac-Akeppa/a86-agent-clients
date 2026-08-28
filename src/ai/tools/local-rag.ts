import { tool } from 'langchain'
import { MemoryVectorStore } from '@langchain/classic/vectorstores/memory'
import { OpenAIEmbeddings } from '@langchain/openai'
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters'
import { z } from 'zod'
import fs from 'node:fs'
import path from 'node:path'

// Ruta estática al archivo Markdown
const FILE_PATH = path.join(process.cwd(), 'assets', 'docs', 'conocimiento.md');

// Variables para el caché inteligente en RAM
let cachedVectorStore: MemoryVectorStore | null = null;
let lastModifiedTime: number = 0;

async function getLocalVectorStore(): Promise<MemoryVectorStore | null> {
  // 1. Verificamos que el archivo exista
  if (!fs.existsSync(FILE_PATH)) {
    console.warn(` Archivo maestro no encontrado en: ${FILE_PATH}`);
    return null;
  }

  // 2. Revisamos si el archivo fue modificado recientemente
  const stats = fs.statSync(FILE_PATH);
  const currentModifiedTime = stats.mtimeMs;

  // 3. Si no ha cambiado, usamos la memoria RAM (0 costo de tokens y tiempo)
  if (cachedVectorStore && currentModifiedTime === lastModifiedTime) {
    return cachedVectorStore;
  }

  console.log(' Detectado archivo nuevo o modificado. Vectorizando en RAM...');
  
  try {
    // Leemos el archivo en texto plano
    const textContent = fs.readFileSync(FILE_PATH, 'utf-8');
    
    const embeddings = new OpenAIEmbeddings({
      model: 'text-embedding-3-large',
      apiKey: process.env.OPENAI_API_KEY
    });

    // Cada trámite/sección del documento está delimitado por "---". Fragmentamos
    // sección por sección (en vez de todo el archivo como un solo bloque) para que
    // los requisitos y los archivos a enviar de un mismo trámite nunca queden
    // divididos entre dos fragmentos distintos. Solo si una sección es muy larga
    // (ej. PAGO DE SUMA ASEGURADA) el splitter la subdivide como respaldo.
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1500,
      chunkOverlap: 200
    });

    const sections = textContent
      .split(/\n-{3,}\n/)
      .map(section => section.trim())
      .filter(Boolean);

    const docs = (
      await Promise.all(
        sections.map(section =>
          splitter.createDocuments([section], [{ source: 'Base_Conocimientos_MPS_Local' }])
        )
      )
    ).flat();
    
    // Guardamos en memoria y actualizamos la fecha de modificación
    cachedVectorStore = await MemoryVectorStore.fromDocuments(docs, embeddings);
    lastModifiedTime = currentModifiedTime;
    
    console.log(' Archivo local vectorizado y guardado en caché exitosamente.');
    return cachedVectorStore;
  } catch (error: any) {
    console.error(' Error leyendo o vectorizando el archivo local:', error.message);
    return null;
  }
}

// La Herramienta que usará el Agente
export const buscarEnDocumentos = tool(
  async ({ consulta }) => {
    try {
      const vs = await getLocalVectorStore();
      if (!vs) return 'Error interno: No se pudo acceder al documento de conocimientos local.';
      
      const results = await vs.asRetriever(6).invoke(consulta);
      if (results.length === 0) return 'No encontré información relevante en el documento maestro.';
      
      return results.map(d => d.pageContent).join('\n\n---\n\n');
    } catch (error: any) {
      return `Error al consultar el documento: ${error.message}`;
    }
  },
  {
    name: 'buscarEnDocumentos',
    description: 'Base de conocimientos principal de Marcial Protege. Úsala SIEMPRE para buscar CUALQUIER información sobre la empresa (direcciones, horarios, contactos), procesos, trámites, seguros GNP y requisitos antes de responder al cliente.',
    schema: z.object({
      consulta: z.string().describe('Lo que se desea buscar en el documento')
    })
  }
);