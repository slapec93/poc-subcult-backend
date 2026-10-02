import { applyRecord, buildRecord, withTransaction, type Db, type RecordType, type Swarm } from '@subcult/shared'

export type Publish = <T extends RecordType>(type: T, author: string, payload: object) => Promise<string>

// Stores the record on Swarm, applies it locally, and queues its on-chain announcement in the same transaction.
export function createPublisher(db: Db, swarm: Swarm): Publish {
    return async (type, author, payload) => {
        const record = buildRecord(type, author, payload as never)
        const ref = await swarm.uploadBytes(new TextEncoder().encode(JSON.stringify(record)))
        await withTransaction(db, async client => {
            await applyRecord(client, ref, record)
            await client.query(`INSERT INTO chain_outbox (swarm_ref) VALUES ($1) ON CONFLICT DO NOTHING`, [ref])
        })
        return ref
    }
}
