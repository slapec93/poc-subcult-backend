import { chainConfig, int, optional, required } from '@subcult/shared'

export const config = {
    databaseUrl: required('DATABASE_URL'),
    beeUrl: required('BEE_URL'),
    chain: chainConfig(),
    startBlock: BigInt(required('START_BLOCK')),
    confirmations: BigInt(int('CONFIRMATIONS', 2)),
    blockRange: BigInt(int('BLOCK_RANGE', 1000)),
    pollIntervalMs: int('POLL_INTERVAL_MS', 5_000),
    concurrency: int('INDEXER_CONCURRENCY', 10),
    maxAttempts: int('INDEXER_MAX_ATTEMPTS', 8),
    allowedSenders: (optional('ALLOWED_SENDERS') ?? '')
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean),
}
