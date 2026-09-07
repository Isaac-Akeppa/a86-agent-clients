import express from 'express'
import 'dotenv/config'
import aiRoutes from './routes/ai-routes.js'
import './db.js'

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())

app.use('/ai', aiRoutes)

app.listen(PORT, () => {
  console.log(` Servidor de Aseguro corriendo en el puerto ${PORT}`)
})