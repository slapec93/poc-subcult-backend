import {
    applyRecord,
    connectionAllowed,
    connectionTypes,
    hasValidSignature,
    identityKey,
    resolveNode,
    serializeRecord,
    withTransaction,
    type Db,
    type SubcultRecord,
    type Swarm,
} from '@subcult/shared'

export class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message)
    }
}

const MAX_CLOCK_SKEW_MS = 10 * 60_000

async function requireNode(db: Db, id: string) {
    const node = await resolveNode(db, id)
    if (!node) throw new HttpError(404, `node ${id} not found`)
    return node
}

// Checks what the schema can't: the signer, the clock, and the graph the record refers to.
async function check(db: Db, record: SubcultRecord) {
    if (!(await hasValidSignature(record))) throw new HttpError(401, 'signature does not match owner')
    if (Math.abs(Date.now() - Date.parse(record.createdAt)) > MAX_CLOCK_SKEW_MS) {
        throw new HttpError(400, 'createdAt is more than 10 minutes off; prepare the record again')
    }
    switch (record.type) {
        case 'add_note':
            await requireNode(db, record.payload.node)
            return
        case 'add_tag': {
            const node = await requireNode(db, record.payload.node)
            const { rowCount } = await db.query(`SELECT 1 FROM node_tags WHERE node_id = $1 AND tag = $2`, [
                node.id,
                record.payload.tag,
            ])
            if (rowCount) throw new HttpError(409, `node already has tag ${record.payload.tag}`)
            return
        }
        case 'add_connection': {
            const { from, to, type } = record.payload
            const [source, target] = [await requireNode(db, from), await requireNode(db, to)]
            if (!connectionAllowed(type, source.kind, target.kind)) {
                throw new HttpError(400, `${connectionTypes[type].label} cannot connect ${source.kind} to ${target.kind}`)
            }
            const { rowCount } = await db.query(`SELECT 1 FROM connections WHERE from_id = $1 AND type = $2 AND to_id = $3`, [
                source.id,
                type,
                target.id,
            ])
            if (rowCount) throw new HttpError(409, 'this connection already exists; add a note to the node instead')
            return
        }
        case 'add_node':
            return
    }
}

export async function existingNodeFor(db: Db, record: SubcultRecord) {
    if (record.type !== 'add_node') return null
    const key = identityKey(record.payload)
    if (!key) return null
    const { rows } = await db.query<{ id: string }>(`SELECT id FROM nodes WHERE identity_key = $1`, [key])
    return rows[0]?.id ?? null
}

// Verifies, stores on Swarm, applies locally and queues the on-chain announcement.
export async function submitRecord(db: Db, swarm: Swarm, record: SubcultRecord) {
    await check(db, record)
    const existing = await existingNodeFor(db, record)
    const ref = await swarm.uploadBytes(new TextEncoder().encode(serializeRecord(record)))
    await withTransaction(db, async client => {
        await applyRecord(client, ref, record)
        await client.query(`INSERT INTO chain_outbox (swarm_ref) VALUES ($1) ON CONFLICT DO NOTHING`, [ref])
    })
    const nodeId = record.type === 'add_node' ? (await resolveNode(db, ref))?.id : undefined
    return { id: ref, nodeId, existing: Boolean(existing) }
}
