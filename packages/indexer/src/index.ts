import { applyEvent, createChainClient, createDb, notifyAbi, parseEvent, Swarm, withTransaction } from '@subcult/shared'
import type { Hash } from 'viem'
import { config } from './config.ts'

const db = createDb(config.databaseUrl)
const swarm = new Swarm(config.beeUrl)
const chain = createChainClient(config.chain.chainId, config.chain.rpcUrl)
const notificationEvent = notifyAbi[0]

interface PendingEvent {
    block_number: string
    log_index: number
    tx_hash: Hash
    swarm_ref: string
    attempts: number
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function ensureCursor() {
    await db.query(`INSERT INTO indexer_state (id, next_block) VALUES (1, $1) ON CONFLICT DO NOTHING`, [
        config.startBlock.toString(),
    ])
}

async function scanOnce(): Promise<boolean> {
    const { rows } = await db.query<{ next_block: string }>(`SELECT next_block FROM indexer_state WHERE id = 1`)
    if (rows.length === 0) {
        await ensureCursor()
        return true
    }
    const fromBlock = BigInt(rows[0].next_block)
    const safeHead = (await chain.getBlockNumber()) - config.confirmations
    if (fromBlock > safeHead) {
        return false
    }
    const toBlock = fromBlock + config.blockRange - 1n < safeHead ? fromBlock + config.blockRange - 1n : safeHead
    const logs = await chain.getLogs({ address: config.chain.contractAddress, event: notificationEvent, fromBlock, toBlock })

    await withTransaction(db, async client => {
        for (const log of logs) {
            if (!log.args.data) continue
            await client.query(
                `INSERT INTO chain_events (block_number, log_index, tx_hash, swarm_ref) VALUES ($1, $2, $3, $4)
                 ON CONFLICT DO NOTHING`,
                [log.blockNumber.toString(), log.logIndex, log.transactionHash, log.args.data.slice(2)],
            )
        }
        await client.query(`UPDATE indexer_state SET next_block = $1 WHERE id = 1`, [(toBlock + 1n).toString()])
    })
    if (logs.length > 0) {
        console.log(`Blocks ${fromBlock}-${toBlock}: queued ${logs.length} event(s)`)
    }
    return toBlock < safeHead
}

async function setStatus(event: PendingEvent, status: string, error?: string) {
    await db.query(`UPDATE chain_events SET status = $3, last_error = $4 WHERE block_number = $1 AND log_index = $2`, [
        event.block_number,
        event.log_index,
        status,
        error ?? null,
    ])
}

async function processEvent(event: PendingEvent) {
    if (config.allowedSenders.length > 0) {
        const tx = await chain.getTransaction({ hash: event.tx_hash })
        if (!config.allowedSenders.includes(tx.from.toLowerCase())) {
            return setStatus(event, 'ignored', `sender ${tx.from} not allowed`)
        }
    }
    const parsed = parseEvent(await swarm.downloadBytes(event.swarm_ref))
    if (!parsed) {
        return setStatus(event, 'ignored', 'not a subcult event')
    }
    await withTransaction(db, async client => {
        await applyEvent(client, event.swarm_ref, parsed, {
            blockNumber: BigInt(event.block_number),
            logIndex: event.log_index,
            txHash: event.tx_hash,
        })
        await client.query(`UPDATE chain_outbox SET status = 'confirmed' WHERE swarm_ref = $1`, [event.swarm_ref])
    })
    await setStatus(event, 'done')
}

async function retryLater(event: PendingEvent, err: unknown) {
    const attempts = event.attempts + 1
    const status = attempts >= config.maxAttempts ? 'failed' : 'pending'
    const backoffMs = Math.min(1000 * 2 ** attempts, 10 * 60_000)
    await db.query(
        `UPDATE chain_events SET attempts = $3, status = $4, last_error = $5,
         next_attempt_at = now() + ($6 || ' milliseconds')::interval
         WHERE block_number = $1 AND log_index = $2`,
        [event.block_number, event.log_index, attempts, status, String(err), backoffMs],
    )
    console.error(`Event ${event.swarm_ref} attempt ${attempts} failed (${status}):`, err)
}

// add_object is commutative, so a batch can be applied in parallel; order-dependent events will need a sequential path.
async function processPending(): Promise<number> {
    const { rows } = await db.query<PendingEvent>(
        `SELECT block_number, log_index, tx_hash, swarm_ref, attempts FROM chain_events
         WHERE status = 'pending' AND next_attempt_at <= now()
         ORDER BY block_number, log_index LIMIT $1`,
        [config.concurrency],
    )
    await Promise.all(rows.map(event => processEvent(event).catch(err => retryLater(event, err))))
    return rows.length
}

async function loop(name: string, step: () => Promise<boolean | number>) {
    while (true) {
        try {
            if (await step()) continue
        } catch (err) {
            console.error(`${name} failed:`, err)
        }
        await sleep(config.pollIntervalMs)
    }
}

await ensureCursor()
console.log(
    `Indexing ${config.chain.contractAddress} on chain ${config.chain.chainId}` +
        (config.allowedSenders.length ? `, senders: ${config.allowedSenders.join(', ')}` : ', any sender'),
)
void loop('scanner', scanOnce)
void loop('processor', processPending)
