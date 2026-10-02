import type { DbClient } from './db.ts'
import { entityId, normalizeName } from './entity.ts'
import type { AddObjectEvent, SubcultEvent } from './events.ts'

export interface ChainPosition {
    blockNumber: bigint
    logIndex: number
    txHash: string
}

// Idempotent: the API applies an event before it is on-chain, the indexer applies it again when it is.
export async function applyEvent(client: DbClient, ref: string, event: SubcultEvent, position?: ChainPosition) {
    switch (event.type) {
        case 'add_object':
            await applyAddObject(client, ref, event)
            break
    }
    if (position) {
        await client.query(
            `UPDATE music_objects SET block_number = $2, log_index = $3, tx_hash = $4
             WHERE id = $1 AND block_number IS NULL`,
            [ref, position.blockNumber.toString(), position.logIndex, position.txHash],
        )
    }
}

async function applyAddObject(client: DbClient, ref: string, event: AddObjectEvent) {
    const { object } = event
    const inserted = await client.query(
        `INSERT INTO music_objects (id, author, kind, title, note, artwork_ref, audio_ref, external_url, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
            ref,
            event.author,
            object.kind,
            object.title,
            object.note,
            object.artworkRef ?? null,
            object.audioRef ?? null,
            object.externalUrl ?? null,
            event.createdAt,
        ],
    )
    if (inserted.rowCount === 0) {
        return
    }
    for (const entity of object.entities) {
        const id = entityId(entity.name)
        await client.query(
            `INSERT INTO entities (id, name, normalized_name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
            [id, entity.name.trim(), normalizeName(entity.name)],
        )
        await client.query(
            `INSERT INTO object_entities (object_id, entity_id, type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [ref, id, entity.type],
        )
    }
}
