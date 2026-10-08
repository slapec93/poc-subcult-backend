import { createChainClient } from '@subcult/shared'
import { config } from './config.ts'

export const paymentChain = createChainClient(config.paymentChain.chainId, config.paymentChain.rpcUrl)
