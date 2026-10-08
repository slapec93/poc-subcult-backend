import type pg from 'pg'
import type { DbClient } from './db.ts'
import { identityKey } from './identity.ts'
import { connectionAllowed } from './model.ts'
import type { PayloadOf, SubcultRecord } from './records.ts'

export interface ChainPosition {
    blockNumber: bigint
    logIndex: number
    txHash: string
}

// retryable: a referenced node may still arrive (the indexer retries); otherwise the record is invalid for good.
export class RecordError extends Error {
    constructor(
        message: string,
        readonly retryable: boolean,
    ) {
        super(message)
    }
}

type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>

export async function resolveNode(db: Queryable, id: string): Promise<{ id: string; kind: string } | null> {
    const { rows } = await db.query<{ id: string; kind: string }>(
        `SELECT n.id, n.kind FROM nodes n
         WHERE n.id = COALESCE((SELECT node_id FROM node_aliases WHERE alias_id = $1), $1)`,
        [id],
    )
    return rows[0] ?? null
}

async function requireNode(client: DbClient, id: string) {
    const node = await resolveNode(client, id)
    if (!node) throw new RecordError(`node ${id} not found`, true)
    return node
}

// Idempotent: the API applies a record before it is on-chain, the indexer applies it again when it is.
export async function applyRecord(client: DbClient, ref: string, record: SubcultRecord, position?: ChainPosition) {
    const inserted = await client.query(
        `INSERT INTO records (id, type, owner, created_at, body) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING`,
        [ref, record.type, record.owner, record.createdAt, JSON.stringify(record)],
    )
    if (inserted.rowCount === 1) {
        const context = { client, ref, owner: record.owner, createdAt: record.createdAt }
        switch (record.type) {
            case 'add_node':
                await applyNode(context, record.payload)
                break
            case 'add_note':
                await addNote(context, (await requireNode(client, record.payload.node)).id, record.payload.text)
                break
            case 'add_connection':
                await applyConnection(context, record.payload)
                break
            case 'add_tag':
                await addTags(context, (await requireNode(client, record.payload.node)).id, [record.payload.tag])
                break
            case 'add_private_part':
                await applyPrivatePart(context, record.payload)
                break
        }
    }
    if (position) {
        await client.query(
            `UPDATE records SET block_number = $2, log_index = $3, tx_hash = $4 WHERE id = $1 AND block_number IS NULL`,
            [ref, position.blockNumber.toString(), position.logIndex, position.txHash],
        )
    }
}

interface Context {
    client: DbClient
    ref: string
    owner: string
    createdAt: string
}

async function applyNode(context: Context, node: PayloadOf<'add_node'>) {
    const { client, ref, owner, createdAt } = context
    const key = identityKey(node)
    const existing = key ? await client.query<{ id: string }>(`SELECT id FROM nodes WHERE identity_key = $1`, [key]) : null
    let nodeId = ref
    if (existing?.rows[0]) {
        nodeId = existing.rows[0].id
        await client.query(`INSERT INTO node_aliases (alias_id, node_id) VALUES ($1, $2)`, [ref, nodeId])
    } else {
        await client.query(
            `INSERT INTO nodes (id, kind, title, role, locality, years, external_url, format, audio_ref, artwork_ref,
                                identity_key, owner, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [
                ref,
                node.kind,
                node.title,
                node.role ?? null,
                node.where ?? null,
                node.years ?? null,
                node.externalUrl ?? null,
                node.format ?? null,
                node.audioRef ?? null,
                node.artworkRef ?? null,
                key,
                owner,
                createdAt,
            ],
        )
    }
    if (node.note) await addNote(context, nodeId, node.note)
    await addTags(context, nodeId, node.tags ?? [])
}

async function addNote({ client, ref, owner, createdAt }: Context, nodeId: string, text: string) {
    await client.query(`INSERT INTO notes (id, node_id, owner, text, created_at) VALUES ($1, $2, $3, $4, $5)`, [
        ref,
        nodeId,
        owner,
        text,
        createdAt,
    ])
}

async function addTags({ client, ref, owner, createdAt }: Context, nodeId: string, tags: string[]) {
    for (const tag of tags) {
        await client.query(
            `INSERT INTO node_tags (node_id, tag, record_id, owner, created_at) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING`,
            [nodeId, tag, ref, owner, createdAt],
        )
    }
}

async function applyConnection({ client, ref, owner, createdAt }: Context, connection: PayloadOf<'add_connection'>) {
    const from = await requireNode(client, connection.from)
    const to = await requireNode(client, connection.to)
    if (!connectionAllowed(connection.type, from.kind, to.kind)) {
        throw new RecordError(`${connection.type} cannot connect ${from.kind} to ${to.kind}`, false)
    }
    await client.query(
        `INSERT INTO connections (id, from_id, type, to_id, owner, note, source, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (from_id, type, to_id) DO NOTHING`,
        [ref, from.id, connection.type, to.id, owner, connection.note, connection.source ?? null, createdAt],
    )
}

async function applyPrivatePart({ client, ref, owner, createdAt }: Context, part: PayloadOf<'add_private_part'>) {
    const node = await requireNode(client, part.node)
    await client.query(
        `INSERT INTO private_parts (id, node_id, owner, encrypted_ref, iv, content_type, description, price_amount,
                                    price_currency, accepted_currencies, key_holder, payment_chain_id, payment_chain_block, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
            ref,
            node.id,
            owner,
            part.encryptedRef,
            part.iv,
            part.contentType,
            part.description ?? null,
            part.price.amount,
            part.price.currency,
            part.acceptedCurrencies ?? null,
            part.keyHolder,
            part.paymentChainBlock.chainId,
            part.paymentChainBlock.number,
            createdAt,
        ],
    )
}
