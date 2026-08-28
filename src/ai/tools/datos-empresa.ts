import { tool } from 'langchain'
import { z } from 'zod'
import { getDatosGenerales } from '../datos-empresa.js'

export const obtenerDatosEmpresa = tool(
  async () => {
    const datos = getDatosGenerales()
    const entradas = Object.entries(datos)

    if (entradas.length === 0) {
      return 'Error interno: no se pudo leer la información general de la empresa del catálogo local.'
    }

    const lista = entradas.map(([campo, valor]) => `${campo}: ${valor}`).join('\n')
    return `DATOS_REALES_DE_LA_EMPRESA — usa EXACTAMENTE estos valores, cópialos tal cual; si el dato que necesitas no aparece en esta lista, NUNCA lo inventes, dile al cliente que no cuentas con esa información en este momento:\n${lista}`
  },
  {
    name: 'obtenerDatosEmpresa',
    description:
      'Devuelve, leídos directamente del catálogo (no de memoria ni de "buscarEnDocumentos"), los datos reales de contacto de la empresa: dirección, línea telefónica, correo, horarios de atención humana, contacto de emergencia GNP. Úsala SIEMPRE que necesites darle al cliente el teléfono, la dirección, el horario o el correo — incluso si crees que ya los viste en un resultado de "buscarEnDocumentos" — para nunca arriesgarte a inventar o mezclar un dato de contacto.',
    schema: z.object({}),
  }
)
