import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import {
    connectionAllowed,
    connectionTypeIds,
    connectionTypes,
    identityKey,
    nodePayloadSchema,
    normalizeTag,
    normalizeText,
    RecordError,
    resolveNode,
    tagSchema,
    type Db,
    type Swarm,
} from '@subcult/shared'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { createPublisher } from './publish.ts'

const nodeColumns = `n.id, n.kind, n.title, n.role, n.locality AS "where", n.years, n.external_url AS "externalUrl",
    n.format, n.audio_ref AS "audioRef", n.artwork_ref AS "artworkRef", n.added_by AS "addedBy", n.created_at AS "createdAt",
    r.block_number IS NOT NULL AS confirmed,
    ARRAY(SELECT tag FROM node_tags t WHERE t.node_id = n.id ORDER BY tag) AS tags`

const summaryColumns = `${nodeColumns},
    (SELECT text FROM notes WHERE node_id = n.id ORDER BY created_at LIMIT 1) AS "firstNote",
    (SELECT count(*)::int FROM notes WHERE node_id = n.id) AS "noteCount",
    (SELECT count(*)::int FROM connections WHERE from_id = n.id OR to_id = n.id) AS "connectionCount"`

const author = z.string().trim().min(1).max(100)
const nodeRef = z.object({ kind: z.enum(['sound', 'person', 'place']), title: z.string(), where: z.string().optional() })

const noteBody = z.object({ author, text: z.string() })
const tagsBody = z.object({ author, tags: z.array(z.string()).min(1) })
const connectionBody = z
    .object({
        author,
        from: z.string(),
        type: z.enum(connectionTypeIds),
        to: z.string().optional(),
        toNode: nodeRef.optional(),
        note: z.string(),
        source: z.url().optional(),
    })
    .refine(b => b.to || b.toNode, { message: 'give `to` (a node id) or `toNode` (a node to find or create)' })

function asArray(value: unknown): string[] {
    if (value === undefined) return []
    return (Array.isArray(value) ? value : [value]).map(String).filter(Boolean)
}

function blank(value: string | undefined) {
    return value?.trim() ? value.trim() : undefined
}

export function registerRoutes(app: FastifyInstance, db: Db, swarm: Swarm) {
    const publish = createPublisher(db, swarm)

    app.setErrorHandler((err, _request, reply) => {
        if (err instanceof z.ZodError) return reply.code(400).send({ error: z.prettifyError(err) })
        if (err instanceof RecordError) return reply.code(err.retryable ? 404 : 400).send({ error: err.message })
        reply.log.error(err)
        return reply.code(500).send({ error: String(err) })
    })

    async function findNode(id: string, reply: FastifyReply) {
        const node = await resolveNode(db, id)
        if (!node) reply.code(404).send({ error: `node ${id} not found` })
        return node
    }

    async function existingByIdentity(node: Parameters<typeof identityKey>[0]) {
        const key = identityKey(node)
        if (!key) return null
        const { rows } = await db.query<{ id: string; kind: string }>(
            `SELECT id, kind FROM nodes WHERE identity_key = $1`,
            [key],
        )
        return rows[0] ?? null
    }

    async function addNewTags(nodeId: string, by: string, tags: string[]) {
        const normalized = [...new Set(tags.map(normalizeTag).filter(Boolean))]
        const { rows } = await db.query<{ tag: string }>(
            `SELECT tag FROM node_tags WHERE node_id = $1 AND tag = ANY($2)`,
            [nodeId, normalized],
        )
        const fresh = normalized.filter(tag => !rows.some(r => r.tag === tag))
        const refs = []
        for (const tag of fresh) refs.push(await publish('add_tag', by, { node: nodeId, tag: tagSchema.parse(tag) }))
        return refs
    }

    app.get('/health', async () => ({ ok: true }))

    app.get('/connection-types', async () =>
        Object.entries(connectionTypes).map(([id, spec]) => ({ id, ...spec })),
    )

    // Creates a node, or adds the note and tags to the existing node with the same identity.
    app.post('/nodes', async (request, reply) => {
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
        const by = author.parse(fields.author)
        const draft = {
            kind: fields.kind,
            title: fields.title,
            role: blank(fields.role),
            where: blank(fields.where),
            years: blank(fields.years),
            externalUrl: blank(fields.externalUrl),
            format: blank(fields.format),
            note: blank(fields.note),
            tags: (fields.tags ?? '').split(',').map(t => t.trim()).filter(Boolean),
        }
        const placeholder = '0'.repeat(64)
        const checked = nodePayloadSchema.parse({ ...draft, audioRef: files.audio ? placeholder : undefined })

        const existing = await existingByIdentity(checked)
        if (existing) {
            const records = []
            if (checked.note) records.push(await publish('add_note', by, { node: existing.id, text: checked.note }))
            records.push(...(await addNewTags(existing.id, by, checked.tags)))
            return reply.code(200).send({ id: existing.id, existing: true, records })
        }

        const [audioRef, artworkRef] = await Promise.all(
            ['audio', 'artwork'].map(field => {
                const file = files[field]
                return file ? swarm.uploadFile(file.data, file.name, file.type) : undefined
            }),
        )
        const id = await publish('add_node', by, { ...draft, audioRef, artworkRef })
        return reply.code(201).send({ id, existing: false, records: [id] })
    })

    app.get('/nodes', async request => {
        const query = request.query as Record<string, unknown>
        const where: string[] = []
        const params: unknown[] = []
        const param = (value: unknown) => `$${params.push(value)}`

        const kind = asArray(query.kind)[0]
        if (kind) where.push(`n.kind = ${param(kind)}`)
        const tags = [...new Set(asArray(query.tag).map(normalizeTag))]
        if (tags.length) {
            where.push(`n.id IN (SELECT node_id FROM node_tags WHERE tag = ANY(${param(tags)})
                        GROUP BY node_id HAVING count(*) = ${param(tags.length)})`)
        }
        const q = normalizeText(asArray(query.q)[0] ?? '')
        if (q) where.push(`(lower(n.title) LIKE '%' || ${param(q)} || '%' OR $${params.length} <% lower(n.title))`)
        const limit = param(Math.min(Number(query.limit) || 50, 200))

        const { rows } = await db.query(
            `SELECT ${summaryColumns} FROM nodes n JOIN records r ON r.id = n.id
             ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
             ORDER BY n.created_at DESC LIMIT ${limit}`,
            params,
        )
        return rows
    })

    app.get('/nodes/:id', async (request, reply) => {
        const node = await findNode((request.params as { id: string }).id, reply)
        if (!node) return
        const [detail, notes, connections] = await Promise.all([
            db.query(`SELECT ${nodeColumns} FROM nodes n JOIN records r ON r.id = n.id WHERE n.id = $1`, [node.id]),
            db.query(
                `SELECT nt.id, nt.author, nt.text, nt.created_at AS "createdAt", r.block_number IS NOT NULL AS confirmed
                 FROM notes nt JOIN records r ON r.id = nt.id WHERE nt.node_id = $1 ORDER BY nt.created_at DESC`,
                [node.id],
            ),
            db.query<{ type: keyof typeof connectionTypes; direction: 'out' | 'in' }>(
                `SELECT c.id, c.type, c.note, c.source, c.author, c.created_at AS "createdAt", d.direction,
                        o.id AS "nodeId", o.kind AS "nodeKind", o.title AS "nodeTitle"
                 FROM connections c
                 CROSS JOIN LATERAL (VALUES (CASE WHEN c.from_id = $1 THEN 'out' ELSE 'in' END)) d(direction)
                 JOIN nodes o ON o.id = CASE WHEN c.from_id = $1 THEN c.to_id ELSE c.from_id END
                 WHERE c.from_id = $1 OR c.to_id = $1 ORDER BY c.created_at DESC`,
                [node.id],
            ),
        ])
        return {
            ...detail.rows[0],
            notes: notes.rows,
            connections: connections.rows.map(c => ({
                ...c,
                label: c.direction === 'out' ? connectionTypes[c.type].label : connectionTypes[c.type].inverse,
            })),
        }
    })

    app.post('/nodes/:id/notes', async (request, reply) => {
        const node = await findNode((request.params as { id: string }).id, reply)
        if (!node) return
        const body = noteBody.parse(request.body)
        const id = await publish('add_note', body.author, { node: node.id, text: body.text })
        return reply.code(201).send({ id })
    })

    app.post('/nodes/:id/tags', async (request, reply) => {
        const node = await findNode((request.params as { id: string }).id, reply)
        if (!node) return
        const body = tagsBody.parse(request.body)
        return reply.code(201).send({ records: await addNewTags(node.id, body.author, body.tags) })
    })

    app.post('/connections', async (request, reply) => {
        const body = connectionBody.parse(request.body)
        const from = await findNode(body.from, reply)
        if (!from) return
        let to = body.to ? await findNode(body.to, reply) : null
        if (body.to && !to) return
        if (!to && body.toNode) {
            const target = nodePayloadSchema.parse({ ...body.toNode, where: blank(body.toNode.where) })
            to = (await existingByIdentity(target)) ?? {
                id: await publish('add_node', body.author, { ...body.toNode, where: blank(body.toNode.where) }),
                kind: target.kind,
            }
        }
        if (!to) return
        if (!connectionAllowed(body.type, from.kind, to.kind)) {
            return reply.code(400).send({ error: `${connectionTypes[body.type].label} cannot connect ${from.kind} to ${to.kind}` })
        }
        const duplicate = await db.query(`SELECT id FROM connections WHERE from_id = $1 AND type = $2 AND to_id = $3`, [
            from.id,
            body.type,
            to.id,
        ])
        if (duplicate.rows[0]) {
            return reply.code(409).send({ error: 'this connection already exists; add a note to the node instead', id: duplicate.rows[0].id })
        }
        const id = await publish('add_connection', body.author, {
            from: from.id,
            type: body.type,
            to: to.id,
            note: body.note,
            source: body.source,
        })
        return reply.code(201).send({ id, to: to.id })
    })

    app.get('/tags', async request => {
        const q = normalizeTag((request.query as { q?: string }).q ?? '')
        const { rows } = await db.query(
            `SELECT tag, count(*)::int AS count FROM node_tags WHERE tag LIKE $1 || '%'
             GROUP BY tag ORDER BY count DESC, tag LIMIT 20`,
            [q],
        )
        return rows
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
        const [outbox, events, cursor, records] = await Promise.all([
            db.query(`SELECT status, count(*)::int FROM chain_outbox GROUP BY status`),
            db.query(`SELECT status, count(*)::int FROM chain_events GROUP BY status`),
            db.query(`SELECT next_block FROM indexer_state WHERE id = 1`),
            db.query(`SELECT type, count(*)::int AS total, count(block_number)::int AS confirmed FROM records GROUP BY type`),
        ])
        return {
            outbox: Object.fromEntries(outbox.rows.map(r => [r.status, r.count])),
            chainEvents: Object.fromEntries(events.rows.map(r => [r.status, r.count])),
            indexerNextBlock: cursor.rows[0]?.next_block ?? null,
            records: Object.fromEntries(records.rows.map(r => [r.type, { total: r.total, confirmed: r.confirmed }])),
        }
    })
}
