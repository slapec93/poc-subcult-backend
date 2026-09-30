import { chainConfig, int, optional, required } from '@subcult/shared'

export const config = {
    port: int('PORT', 3000),
    databaseUrl: required('DATABASE_URL'),
    beeUrl: required('BEE_URL'),
    postageBatchId: optional('POSTAGE_BATCH_ID'),
    operatorPrivateKey: optional('OPERATOR_PRIVATE_KEY') as `0x${string}` | undefined,
    outboxIntervalMs: int('OUTBOX_INTERVAL_MS', 2_000),
    chain: chainConfig(),
}
