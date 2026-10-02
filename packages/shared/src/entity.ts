import { keccak256, stringToBytes } from 'viem'

export function normalizeName(name: string): string {
    return name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function entityId(name: string): string {
    return keccak256(stringToBytes(normalizeName(name))).slice(2)
}
