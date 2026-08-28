import { tool } from 'langchain'
import { z } from 'zod'
import { consultarClienteConReintento } from './client-verify-api.js'
import { setClientName, markVerified } from '../session-state.js'

export const verificarCliente = tool(
  async ({ nombre, numeroPoliza, rfc }, config) => {
    const resultado = await consultarClienteConReintento({ nombre, numeroPoliza, rfc })

    if (resultado.status === 'encontrado') {
      const sessionId = config?.configurable?.thread_id
      if (typeof sessionId === 'string') {
        // Se guarda para poder nombrar de forma estandarizada los archivos que el
        // cliente envíe más adelante en la conversación (ver registrar-documento.ts).
        setClientName(sessionId, nombre)
        // Marca la sesión como verificada: ai-routes.ts usa esto como backstop en
        // código para bloquear cualquier respuesta con info de trámite si el modelo
        // llegara a saltarse la verificación en el prompt.
        markVerified(sessionId)
      }
      return 'CLIENTE_ENCONTRADO: el cliente fue verificado exitosamente en el sistema. Continúa el flujo normal del trámite.'
    }

    if (resultado.status === 'no_encontrado') {
      return 'CLIENTE_NO_ENCONTRADO: no se encontraron los datos proporcionados en el sistema. Informa al cliente que no se encontraron sus datos y pídele que verifique nombre, número de póliza y RFC. NO continúes con el trámite hasta que la verificación sea exitosa.'
    }

    return 'ERROR_VERIFICACION: hubo un problema técnico al verificar los datos del cliente, incluso después de reintentar. Informa al cliente que hubo un problema técnico verificando sus datos y que lo intente más tarde, sin exponer detalles técnicos. NO continúes con el trámite.'
  },
  {
    name: 'verificarCliente',
    description:
      'OBLIGATORIO antes de continuar cualquier trámite (nunca para saludos o preguntas generales): verifica la identidad del cliente contra el sistema, usando su nombre completo, número de póliza y RFC. Solo debe llamarse cuando ya tienes los tres datos. Si el cliente ya fue verificado exitosamente antes en esta misma conversación, no vuelvas a llamarla ni a pedir los datos de nuevo. EXCEPCIÓN: si el trámite es específicamente consultar/descargar la póliza, usa "consultarPoliza" en su lugar (hace la misma verificación y además obtiene el documento).',
    schema: z.object({
      nombre: z.string().max(255).describe('Nombre completo del cliente, tal como lo proporcionó'),
      numeroPoliza: z.string().min(1).max(100).describe('Número de póliza del cliente'),
      rfc: z.string().min(1).max(20).describe('RFC del cliente'),
    }),
  }
)
