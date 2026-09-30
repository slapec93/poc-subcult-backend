export function required(name: string): string {
    const value = process.env[name]
    if (!value) {
        throw new Error(`Missing required env var: ${name}`)
    }
    return value
}

export function optional(name: string): string | undefined {
    return process.env[name] || undefined
}

export function int(name: string, fallback: number): number {
    const value = process.env[name]
    return value ? Number.parseInt(value, 10) : fallback
}

export function chainConfig() {
    return {
        rpcUrl: required('CHAIN_RPC_URL'),
        chainId: int('CHAIN_ID', 100),
        contractAddress: required('CONTRACT_ADDRESS') as `0x${string}`,
    }
}
