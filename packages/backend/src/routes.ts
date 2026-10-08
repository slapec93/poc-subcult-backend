import { Readable } from 'node:stream'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import {
    connectionTypes,
    createUnsignedRecord,
    nodeKinds,
    normalizeDraft,
    normalizeTag,
    normalizeText,
    recordSchema,
    recordTypes,
    resolveNode,
    signingMessage,
    type Db,
    type Swarm,
} from '@subcult/shared'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z } from 'zod'
import { config } from './config.ts'
import { paymentChain } from './payment-chain.ts'
import { HttpError, submitRecord } from './publish.ts'

const id = z.string().regex(/^[0-9a-f]{64}$/).describe('Swarm reference of a record (64 hex characters)')
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe('Ethereum address of the signer')
const errorSchema = z.object({ error: z.string() })
const errors = { 400: errorSchema, 401: errorSchema, 404: errorSchema, 409: errorSchema }

const nodeSchema = z.object({
    id,
    kind: z.enum(nodeKinds),
    title: z.string(),
    role: z.string().nullable(),
    where: z.string().nullable(),
    years: z.string().nullable(),
    externalUrl: z.string().nullable(),
    format: z.string().nullable(),
    audioRef: z.string().nullable(),
    artworkRef: z.string().nullable(),
    owner: z.string(),
    createdAt: z.string(),
    confirmed: z.boolean().describe('whether the creating record is on-chain'),
    tags: z.array(z.string()),
})

const nodeSummarySchema = nodeSchema.extend({
    firstNote: z.string().nullable(),
    noteCount: z.number(),
    connectionCount: z.number(),
})

const nodeDetailSchema = nodeSchema.extend({
    privateParts: z.array(
        z.object({
            id,
            owner: z.string().describe('the seller, who is paid directly'),
            description: z.string().nullable(),
            contentType: z.string(),
            price: z.object({ amount: z.string(), currency: z.string() }),
            acceptedCurrencies: z.array(z.string()).nullable().describe('null: every payment currency the key holder supports'),
            keyHolder: z.string(),
            createdAt: z.string(),
            sellable: z.boolean().describe('whether this operator holds the key'),
            purchased: z.boolean().describe('whether `buyer` already bought it'),
        }),
    ),
    notes: z.array(z.object({ id, owner: z.string(), text: z.string(), createdAt: z.string(), confirmed: z.boolean() })),
    connections: z.array(
        z.object({
            id,
            type: z.string(),
            label: z.string().describe('the relation read from this node, e.g. "Played at" or "Played here"'),
            direction: z.enum(['out', 'in']),
            note: z.string(),
            source: z.string().nullable(),
            owner: z.string(),
            createdAt: z.string(),
            nodeId: id,
            nodeKind: z.string(),
            nodeTitle: z.string(),
        }),
    ),
})

const nodeColumns = `n.id, n.kind, n.title, n.role, n.locality AS "where", n.years, n.external_url AS "externalUrl",
    n.format, n.audio_ref AS "audioRef", n.artwork_ref AS "artworkRef", n.owner, n.created_at AS "createdAt",
    r.block_number IS NOT NULL AS confirmed,
    ARRAY(SELECT tag FROM node_tags t WHERE t.node_id = n.id ORDER BY tag) AS tags`

const summaryColumns = `${nodeColumns},
    (SELECT text FROM notes WHERE node_id = n.id ORDER BY created_at LIMIT 1) AS "firstNote",
    (SELECT count(*)::int FROM notes WHERE node_id = n.id) AS "noteCount",
    (SELECT count(*)::int FROM connections WHERE from_id = n.id OR to_id = n.id) AS "connectionCount"`

const asArray = (value: string | string[] | undefined) => (value === undefined ? [] : [value].flat().filter(Boolean))

export const routes: FastifyPluginAsyncZod<{ db: Db; swarm: Swarm }> = async (app, { db, swarm }) => {
    app.get('/health', { schema: { tags: ['meta'], response: { 200: z.object({ ok: z.boolean() }) } } }, async () => ({ ok: true }))

    app.get(
        '/connection-types',
        {
            schema: {
                tags: ['meta'],
                summary: 'Connection types and the node kinds each one joins',
                response: {
                    200: z.array(
                        z.object({ id: z.string(), label: z.string(), inverse: z.string(), from: z.array(z.string()), to: z.array(z.string()) }),
                    ),
                },
            },
        },
        async () => Object.entries(connectionTypes).map(([id, spec]) => ({ id, ...spec, from: [...spec.from], to: [...spec.to] })),
    )

    app.post(
        '/records/prepare',
        {
            schema: {
                tags: ['records'],
                summary: 'Build the exact record to sign',
                description:
                    'Normalizes the payload (trims text, lowercases and dedupes tags), fills in `createdAt` and `nonce`, and validates it. ' +
                    'Payloads: `add_node` {kind, title, role?, where?, years?, externalUrl?, format?, audioRef?, artworkRef?, tags?, note?}; ' +
                    '`add_note` {node, text}; `add_connection` {from, type, to, note, source?}; `add_tag` {node, tag}; ' +
                    '`add_private_part` {node, encryptedRef, iv, contentType, description?, price: {amount, currency}, acceptedCurrencies?, keyHolder?, paymentChainBlock?} ' +
                    '(keyHolder defaults to this operator, paymentChainBlock to the current payment chain head).',
                body: z.object({
                    type: z.enum(recordTypes),
                    owner: address,
                    payload: z.record(z.string(), z.unknown()),
                }),
                response: {
                    200: z.object({
                        record: z.record(z.string(), z.unknown()).describe('the record without its signature'),
                        message: z.string().describe('sign this with personal_sign, then POST /records with {...record, signature}'),
                    }),
                    400: errorSchema,
                },
            },
        },
        async request => {
            const { type, owner, payload } = request.body
            const draft =
                type === 'add_private_part'
                    ? {
                          keyHolder: config.publicUrl,
                          paymentChainBlock: { chainId: config.paymentChain.chainId, number: (await paymentChain.getBlockNumber()).toString() },
                          ...payload,
                      }
                    : payload
            const record = createUnsignedRecord(type, owner.toLowerCase(), normalizeDraft(type, draft))
            return { record, message: signingMessage(record) }
        },
    )

    app.post(
        '/records',
        {
            schema: {
                tags: ['records'],
                summary: 'Submit a signed record',
                description:
                    'Verifies the signature against `owner`, checks the record against the graph, stores it on Swarm and announces it on-chain. ' +
                    'An `add_node` for a node that already exists (same source link, or same name and place) adds its note and tags to that node.',
                body: recordSchema,
                response: {
                    201: z.object({
                        id: id.describe('the record reference'),
                        nodeId: id.optional().describe('for add_node: the node it created or added to'),
                        existing: z.boolean(),
                    }),
                    ...errors,
                },
            },
        },
        async (request, reply) => reply.code(201).send(await submitRecord(db, swarm, request.body)),
    )

    app.get(
        '/records/:id',
        {
            schema: {
                tags: ['records'],
                summary: 'A stored record and its chain status',
                params: z.object({ id }),
                response: {
                    200: z.object({
                        id,
                        type: z.string(),
                        owner: z.string(),
                        createdAt: z.string(),
                        blockNumber: z.string().nullable(),
                        txHash: z.string().nullable(),
                        body: z.record(z.string(), z.unknown()),
                    }),
                    404: errorSchema,
                },
            },
        },
        async (request, reply) => {
            const { rows } = await db.query(
                `SELECT id, type, owner, created_at AS "createdAt", block_number AS "blockNumber", tx_hash AS "txHash", body
                 FROM records WHERE id = $1`,
                [request.params.id],
            )
            return rows[0] ?? reply.code(404).send({ error: 'record not found' })
        },
    )

    app.post(
        '/media',
        {
            schema: {
                tags: ['media'],
                summary: 'Upload a file to Swarm',
                description:
                    'multipart/form-data with one `file` field: audio/* or image/* for public media (`audioRef`, `artworkRef`), ' +
                    'or application/octet-stream for encrypted private parts (`encryptedRef`).',
                response: { 201: z.object({ ref: id, contentType: z.string(), size: z.number() }), 400: errorSchema, 415: errorSchema },
            },
        },
        async (request, reply) => {
            const file = await request.file()
            if (!file) throw new HttpError(400, 'missing file')
            if (!/^(audio\/|image\/|application\/octet-stream$)/.test(file.mimetype)) {
                throw new HttpError(415, 'only audio/*, image/* or application/octet-stream (encrypted) files')
            }
            const data = await file.toBuffer()
            const ref = await swarm.uploadFile(data, file.filename, file.mimetype)
            return reply.code(201).send({ ref, contentType: file.mimetype, size: data.length })
        },
    )

    app.get(
        '/media/:ref',
        {
            schema: {
                tags: ['media'],
                summary: 'Stream a file from Swarm',
                description: 'Supports `Range` requests.',
                params: z.object({ ref: id }),
            },
        },
        async (request, reply) => {
            const range = request.headers.range
            const res = await fetch(swarm.fileUrl(request.params.ref), { headers: range ? { range } : {} })
            for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
                const value = res.headers.get(header)
                if (value) reply.header(header, value)
            }
            reply.code(res.status)
            return res.body ? reply.send(Readable.fromWeb(res.body as NodeReadableStream)) : reply.send()
        },
    )

    app.get(
        '/nodes',
        {
            schema: {
                tags: ['nodes'],
                summary: 'List nodes, newest first',
                querystring: z.object({
                    kind: z.enum(nodeKinds).optional(),
                    q: z.string().optional().describe('title search'),
                    tag: z.union([z.string(), z.array(z.string())]).optional().describe('repeatable; all must match'),
                    limit: z.coerce.number().int().min(1).max(200).default(50),
                }),
                response: { 200: z.array(nodeSummarySchema) },
            },
        },
        async request => {
            const query = request.query
            const where: string[] = []
            const params: unknown[] = []
            const param = (value: unknown) => `$${params.push(value)}`

            if (query.kind) where.push(`n.kind = ${param(query.kind)}`)
            const tags = [...new Set(asArray(query.tag).map(normalizeTag))]
            if (tags.length) {
                where.push(`n.id IN (SELECT node_id FROM node_tags WHERE tag = ANY(${param(tags)})
                            GROUP BY node_id HAVING count(*) = ${param(tags.length)})`)
            }
            const q = normalizeText(query.q ?? '')
            if (q) where.push(`(lower(n.title) LIKE '%' || ${param(q)} || '%' OR $${params.length} <% lower(n.title))`)

            const { rows } = await db.query(
                `SELECT ${summaryColumns} FROM nodes n JOIN records r ON r.id = n.id
                 ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY n.created_at DESC LIMIT ${param(query.limit)}`,
                params,
            )
            return rows
        },
    )

    app.get(
        '/nodes/:id',
        {
            schema: {
                tags: ['nodes'],
                summary: 'A node with its tags, notes and connections',
                description: 'Accepts the id of any record that created or was merged into the node.',
                params: z.object({ id }),
                querystring: z.object({ buyer: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().describe('marks the parts this address bought') }),
                response: { 200: nodeDetailSchema, 404: errorSchema },
            },
        },
        async (request, reply) => {
            const node = await resolveNode(db, request.params.id)
            if (!node) return reply.code(404).send({ error: 'node not found' })
            const buyer = request.query.buyer?.toLowerCase() ?? null
            const [detail, notes, connections, privateParts] = await Promise.all([
                db.query(`SELECT ${nodeColumns} FROM nodes n JOIN records r ON r.id = n.id WHERE n.id = $1`, [node.id]),
                db.query(
                    `SELECT nt.id, nt.owner, nt.text, nt.created_at AS "createdAt", r.block_number IS NOT NULL AS confirmed
                     FROM notes nt JOIN records r ON r.id = nt.id WHERE nt.node_id = $1 ORDER BY nt.created_at DESC`,
                    [node.id],
                ),
                db.query<{ type: keyof typeof connectionTypes; direction: 'out' | 'in' }>(
                    `SELECT c.id, c.type, c.note, c.source, c.owner, c.created_at AS "createdAt", d.direction,
                            o.id AS "nodeId", o.kind AS "nodeKind", o.title AS "nodeTitle"
                     FROM connections c
                     CROSS JOIN LATERAL (VALUES (CASE WHEN c.from_id = $1 THEN 'out' ELSE 'in' END)) d(direction)
                     JOIN nodes o ON o.id = CASE WHEN c.from_id = $1 THEN c.to_id ELSE c.from_id END
                     WHERE c.from_id = $1 OR c.to_id = $1 ORDER BY c.created_at DESC`,
                    [node.id],
                ),
                db.query(
                    `SELECT p.id, p.owner, p.description, p.content_type AS "contentType",
                            json_build_object('amount', p.price_amount, 'currency', p.price_currency) AS price,
                            p.accepted_currencies AS "acceptedCurrencies", p.key_holder AS "keyHolder", p.created_at AS "createdAt",
                            EXISTS (SELECT 1 FROM content_keys k WHERE k.private_part_id = p.id) AS sellable,
                            EXISTS (SELECT 1 FROM purchases b WHERE b.private_part_id = p.id AND b.buyer = $2) AS purchased
                     FROM private_parts p WHERE p.node_id = $1 ORDER BY p.created_at`,
                    [node.id, buyer],
                ),
            ])
            return {
                ...detail.rows[0],
                privateParts: privateParts.rows,
                notes: notes.rows,
                connections: connections.rows.map(c => ({
                    ...c,
                    label: c.direction === 'out' ? connectionTypes[c.type].label : connectionTypes[c.type].inverse,
                })),
            }
        },
    )

    app.get(
        '/tags',
        {
            schema: {
                tags: ['nodes'],
                summary: 'Tag autocomplete with usage counts',
                querystring: z.object({ q: z.string().default('') }),
                response: { 200: z.array(z.object({ tag: z.string(), count: z.number() })) },
            },
        },
        async request => {
            const { rows } = await db.query(
                `SELECT tag, count(*)::int AS count FROM node_tags WHERE tag LIKE $1 || '%'
                 GROUP BY tag ORDER BY count DESC, tag LIMIT 20`,
                [normalizeTag(request.query.q)],
            )
            return rows
        },
    )

    app.get(
        '/status',
        {
            schema: {
                tags: ['meta'],
                summary: 'Outbox, indexer progress and record counts',
                response: {
                    200: z.object({
                        outbox: z.record(z.string(), z.number()),
                        chainEvents: z.record(z.string(), z.number()),
                        indexerNextBlock: z.string().nullable(),
                        records: z.record(z.string(), z.object({ total: z.number(), confirmed: z.number() })),
                    }),
                },
            },
        },
        async () => {
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
        },
    )
}
