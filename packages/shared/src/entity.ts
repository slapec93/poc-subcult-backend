import { keccak256, stringToBytes } from 'viem'
import type { EntityRef } from './events.ts'

export function normalizeName(name: string): string {
    return name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function entityId(entity: EntityRef): string {
    return keccak256(stringToBytes(`${entity.type}:${normalizeName(entity.name)}`)).slice(2)
}
