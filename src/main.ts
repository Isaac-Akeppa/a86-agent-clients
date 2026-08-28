import express from 'express'
import 'dotenv/config'
import aiRoutes from './routes/ai-routes.js'
import attachmentRoutes from './routes/attachment-routes.js'
import path from 'node:path'
import './db.js'

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())

// Exponemos la carpeta 'public' para que n8n pueda descargar los archivos[cite: 1]
app.use('/files', express.static(path.join(process.cwd(), 'public')))

app.use('/ai', aiRoutes)
app.use('/ai', attachmentRoutes)

app.listen(PORT, () => {
  console.log(` Servidor de Marcial Protege corriendo en el puerto ${PORT}`)
})