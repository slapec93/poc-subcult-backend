import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import {
    applyEvent,
    buildAddObjectEvent,
    entityId,
    entityRefSchema,
    objectKinds,
    withTransaction,
    type Db,
    type Swarm,
} from '@subcult/shared'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

const createFieldsSchema = z.object({
    author: z.string().min(1),
    kind: z.enum(objectKinds),
    title: z.string().min(1),
    note: z.string().min(1),
    externalUrl: z.url().optional(),
    entities: z.string().transform(s => z.array(entityRefSchema).parse(JSON.parse(s))),
})

const objectColumnNames = [
    'id', 'author', 'kind', 'title', 'note', 'artwork_ref', 'audio_ref', 'external_url', 'created_at',
    'block_number', 'log_index', 'tx_hash',
]
const objectColumns = () => objectColumnNames.join(', ')

const entityColumns = `e.id, e.name,
    ARRAY(SELECT DISTINCT type::text FROM object_entities WHERE entity_id = e.id ORDER BY 1) AS types`

function asArray(value: unknown): string[] {
    if (value === undefined) return []
    return (Array.isArray(value) ? value : [value]).map(String).filter(Boolean)
}

async function attachEntities(db: Db, objects: Array<{ id: string }>) {
    if (objects.length === 0) return []
    const { rows } = await db.query<{ object_id: string; id: string; type: string; name: string }>(
        `SELECT oe.object_id, e.id, oe.type, e.name FROM object_entities oe
         JOIN entities e ON e.id = oe.entity_id WHERE oe.object_id = ANY($1) ORDER BY oe.type, e.name`,
        [objects.map(o => o.id)],
    )
    return objects.map(o => ({
        ...o,
        entities: rows.filter(r => r.object_id === o.id).map(({ object_id, ...e }) => e),
    }))
}

export function registerRoutes(app: FastifyInstance, db: Db, swarm: Swarm) {
    app.get('/health', async () => ({ ok: true }))

    app.post('/objects', async (request, reply) => {
        const fields: Record<string, string> = {}
        const files: Record<string, { data: Buffer; name: string; type: string }> = {}
        for await (const part of request.parts()) {
            if (part.type === 'file') {
                const data = await part.toBuffer()
                if (data.length > 0) files[part.fieldname] = { data, name: part.filename, type: part.mimetype }
            } else {
                fields[part.fieldname] = String(part.value)
            }
        }
        const parsed = createFieldsSchema.safeParse({ ...fields, entities: fields.entities ?? '[]' })
        if (!parsed.success) {
            return reply.code(400).send({ error: z.prettifyError(parsed.error) })
        }
        const { author, entities, ...object } = parsed.data
        if (!files.audio && !object.externalUrl) {
            return reply.code(400).send({ error: 'a music object needs an audio file or a link (externalUrl)' })
        }

        const [audioRef, artworkRef] = await Promise.all(
            ['audio', 'artwork'].map(field => {
                const file = files[field]
                return file ? swarm.uploadFile(file.data, file.name, file.type) : undefined
            }),
        )
        const event = buildAddObjectEvent(author, { ...object, audioRef, artworkRef, entities })
        const ref = await swarm.uploadBytes(new TextEncoder().encode(JSON.stringify(event)))

        await withTransaction(db, async client => {
            await applyEvent(client, ref, event)
            await client.query(`INSERT INTO chain_outbox (swarm_ref) VALUES ($1) ON CONFLICT DO NOTHING`, [ref])
        })
        return reply.code(201).send({ id: ref, event })
    })

    app.get('/objects', async request => {
        const query = request.query as Record<string, unknown>
        const nameIds = asArray(query.name).map(entityId)
        const ids = [...new Set([...nameIds, ...asArray(query.entity)])]
        const limit = Math.min(Number(query.limit) || 50, 200)

        const { rows } = ids.length
            ? await db.query(
                  `SELECT ${objectColumns()} FROM music_objects
                   WHERE id IN (
                     SELECT object_id FROM object_entities WHERE entity_id = ANY($1)
                     GROUP BY object_id HAVING count(DISTINCT entity_id) = $2
                   )
                   ORDER BY created_at DESC LIMIT $3`,
                  [ids, ids.length, limit],
              )
            : await db.query(`SELECT ${objectColumns()} FROM music_objects ORDER BY created_at DESC LIMIT $1`, [limit])
        return attachEntities(db, rows)
    })

    app.get('/objects/:id', async (request, reply) => {
        const { id } = request.params as { id: string }
        const { rows } = await db.query(`SELECT ${objectColumns()} FROM music_objects WHERE id = $1`, [id])
        if (rows.length === 0) return reply.code(404).send({ error: 'not found' })
        const [object] = await attachEntities(db, rows)
        return object
    })

    app.get('/entities', async request => {
        const { q = '', limit } = request.query as { q?: string; limit?: string }
        const { rows } = await db.query(
            `SELECT ${entityColumns} FROM entities e
             WHERE e.normalized_name LIKE '%' || $1 || '%' OR $1 <% e.normalized_name
             ORDER BY word_similarity($1, e.normalized_name) DESC, e.name LIMIT $2`,
            [q.trim().toLowerCase(), Math.min(Number(limit) || 10, 50)],
        )
        return rows
    })

    app.get('/entities/:id', async (request, reply) => {
        const { id } = request.params as { id: string }
        const { rows } = await db.query(`SELECT ${entityColumns} FROM entities e WHERE e.id = $1`, [id])
        if (rows.length === 0) return reply.code(404).send({ error: 'not found' })
        const objects = await db.query(
            `SELECT ${objectColumns()} FROM music_objects
             WHERE id IN (SELECT object_id FROM object_entities WHERE entity_id = $1)
             ORDER BY created_at DESC LIMIT 200`,
            [id],
        )
        return { ...rows[0], objects: await attachEntities(db, objects.rows) }
    })

    app.get('/media/:ref', async (request, reply) => {
        const { ref } = request.params as { ref: string }
        const range = request.headers.range
        const res = await fetch(swarm.fileUrl(ref), { headers: range ? { range } : {} })
        for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
            const value = res.headers.get(header)
            if (value) reply.header(header, value)
        }
        reply.code(res.status)
        return res.body ? reply.send(Readable.fromWeb(res.body as NodeReadableStream)) : reply.send()
    })

    app.get('/status', async () => {
        const [outbox, events, cursor, objects] = await Promise.all([
            db.query(`SELECT status, count(*)::int FROM chain_outbox GROUP BY status`),
            db.query(`SELECT status, count(*)::int FROM chain_events GROUP BY status`),
            db.query(`SELECT next_block FROM indexer_state WHERE id = 1`),
            db.query(
                `SELECT count(*)::int AS total, count(block_number)::int AS confirmed FROM music_objects`,
            ),
        ])
        return {
            outbox: Object.fromEntries(outbox.rows.map(r => [r.status, r.count])),
            chainEvents: Object.fromEntries(events.rows.map(r => [r.status, r.count])),
            indexerNextBlock: cursor.rows[0]?.next_block ?? null,
            objects: objects.rows[0],
        }
    })
}
