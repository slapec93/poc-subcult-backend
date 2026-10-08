import { chainConfig, int, optional, required } from '@subcult/shared'
import { parseCurrencies } from './currencies.ts'

const port = int('PORT', 3000)
const DEFAULT_PAYMENT_RPC = 'https://ethereum-rpc.publicnode.com'
const chain = chainConfig()

export const config = {
    port,
    databaseUrl: required('DATABASE_URL'),
    beeUrl: required('BEE_URL'),
    postageBatchId: optional('POSTAGE_BATCH_ID'),
    operatorPrivateKey: optional('OPERATOR_PRIVATE_KEY') as `0x${string}` | undefined,
    outboxIntervalMs: int('OUTBOX_INTERVAL_MS', 2_000),
    chain,
    publicUrl: (optional('PUBLIC_URL') ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    masterKey: optional('MASTER_KEY'),
    paymentChain: {
        chainId: int('PAYMENT_CHAIN_ID', 1),
        rpcUrl: optional('PAYMENT_RPC_URL') ?? DEFAULT_PAYMENT_RPC,
        publicRpcUrl: optional('PUBLIC_PAYMENT_RPC_URL') ?? optional('PAYMENT_RPC_URL') ?? DEFAULT_PAYMENT_RPC,
    },
    paymentConfirmations: int('PAYMENT_CONFIRMATIONS', 3),
    paymentToleranceBps: int('PAYMENT_TOLERANCE_BPS', 0),
    currencies: parseCurrencies(optional('CURRENCIES')),
}
