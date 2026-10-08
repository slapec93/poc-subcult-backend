import { z } from 'zod'

// CAIP-19 asset ids, so a price means the same on every operator: iso4217:USD, eip155:100/slip44:700, eip155:100/erc20:0x…
export const currencyIdSchema = z
    .string()
    .regex(/^(iso4217:[A-Z]{3}|eip155:\d+\/slip44:\d+|eip155:\d+\/erc20:0x[0-9a-f]{40})$/, 'a CAIP-19 currency id')

export const decimalAmountSchema = z
    .string()
    .regex(/^(0|[1-9]\d{0,17})(\.\d{1,18})?$/, 'a decimal amount like "4.99"')
    .refine(a => /[1-9]/.test(a), 'must be greater than zero')

export type CurrencyId = z.infer<typeof currencyIdSchema>

export type ParsedCurrency =
    | { kind: 'fiat'; code: string }
    | { kind: 'native'; chainId: number }
    | { kind: 'erc20'; chainId: number; address: `0x${string}` }

export function parseCurrencyId(id: string): ParsedCurrency {
    const fiat = id.match(/^iso4217:([A-Z]{3})$/)
    if (fiat) return { kind: 'fiat', code: fiat[1] }
    const native = id.match(/^eip155:(\d+)\/slip44:\d+$/)
    if (native) return { kind: 'native', chainId: Number(native[1]) }
    const token = id.match(/^eip155:(\d+)\/erc20:(0x[0-9a-f]{40})$/)
    if (token) return { kind: 'erc20', chainId: Number(token[1]), address: token[2] as `0x${string}` }
    throw new Error(`unsupported currency id ${id}`)
}

export function normalizeCurrencyId(id: string): string {
    const trimmed = id.trim()
    return trimmed.startsWith('iso4217:') ? trimmed.toUpperCase().replace('ISO4217:', 'iso4217:') : trimmed.toLowerCase()
}
