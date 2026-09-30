import multipart from '@fastify/multipart'
import { createDb, Swarm } from '@subcult/shared'
import Fastify from 'fastify'
import { config } from './config.ts'
import { startOutbox } from './outbox.ts'
import { registerRoutes } from './routes.ts'

const db = createDb(config.databaseUrl)
const swarm = new Swarm(config.beeUrl, config.postageBatchId)

const app = Fastify({ logger: true })
await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } })
registerRoutes(app, db, swarm)

startOutbox(db)
await app.listen({ host: '0.0.0.0', port: config.port })
