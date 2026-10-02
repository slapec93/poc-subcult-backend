import { createDb, required } from '@subcult/shared'

if (!process.argv.includes('--yes')) {
    console.error('Wipes all indexed data and rescans the chain from START_BLOCK. Re-run with --yes to confirm.')
    process.exit(1)
}

const db = createDb(required('DATABASE_URL'))
const startBlock = required('START_BLOCK')

await db.query(`TRUNCATE node_tags, connections, notes, node_aliases, nodes, records, chain_events`)
await db.query(
    `INSERT INTO indexer_state (id, next_block) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET next_block = EXCLUDED.next_block`,
    [startBlock],
)
console.log(`Index wiped; the running indexer rescans from block ${startBlock}.`)
await db.end()
