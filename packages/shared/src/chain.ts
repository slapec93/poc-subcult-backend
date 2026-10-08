import { createPublicClient, defineChain, http, parseAbi, type Chain } from 'viem'
import { foundry, gnosis, mainnet } from 'viem/chains'

export const notifyAbi = parseAbi(['event Notification(bytes32 indexed data)', 'function notify(bytes32 data)'])

export function resolveChain(chainId: number, rpcUrl: string): Chain {
    if (chainId === mainnet.id) return mainnet
    if (chainId === gnosis.id) return gnosis
    if (chainId === foundry.id) return foundry
    return defineChain({
        id: chainId,
        name: `chain-${chainId}`,
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
    })
}

export function createChainClient(chainId: number, rpcUrl: string) {
    return createPublicClient({ chain: resolveChain(chainId, rpcUrl), transport: http(rpcUrl) })
}
