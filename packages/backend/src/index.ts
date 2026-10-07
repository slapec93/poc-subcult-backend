import multipart from '@fastify/multipart'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { createDb, Swarm } from '@subcult/shared'
import Fastify from 'fastify'
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { config } from './config.ts'
import { startOutbox } from './outbox.ts'
import { routes } from './routes.ts'

const db = createDb(config.databaseUrl)
const swarm = new Swarm(config.beeUrl, config.postageBatchId)

const app = Fastify({ logger: true })
app.setValidatorCompiler(validatorCompiler)
app.setSerializerCompiler(serializerCompiler)

await app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } })
await app.register(swagger, {
    openapi: {
        info: {
            title: 'Subcult API',
            version: '0.3.0',
            description: [
                'Every contribution is a record signed by its owner (EIP-191 `personal_sign`).',
                '',
                'Writing takes three steps:',
                '1. Upload media with `POST /media` (optional) and use the returned `ref` in the payload.',
                '2. `POST /records/prepare` with `{type, owner, payload}` returns the exact `record` and the `message` to sign.',
                '3. Sign `message` with the owner key and `POST /records` with `{...record, signature}`.',
                '',
                'The message is the record without `signature`, as JSON with sorted keys and no whitespace.',
            ].join('\n'),
        },
        tags: [
            { name: 'records', description: 'Signed writes' },
            { name: 'nodes', description: 'The graph: nodes with their notes, tags and connections' },
            { name: 'media', description: 'Files on Swarm' },
            { name: 'meta', description: 'Health, status and reference data' },
        ],
    },
    transform: input => {
        const output = jsonSchemaTransform(input)
        if (input.url === '/media' && input.route.method === 'POST') {
            output.schema = {
                ...output.schema,
                consumes: ['multipart/form-data'],
                body: {
                    type: 'object',
                    required: ['file'],
                    properties: { file: { type: 'string', format: 'binary', description: 'audio/* or image/*' } },
                },
            }
        }
        return output
    },
})
await app.register(swaggerUi, { routePrefix: '/docs' })
await app.register(routes, { db, swarm })

startOutbox(db)
await app.listen({ host: '0.0.0.0', port: config.port })
