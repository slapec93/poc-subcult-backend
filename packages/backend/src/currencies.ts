import { parseCurrencyId, type ParsedCurrency } from '@subcult/shared'
import { parseUnits } from 'viem'
import { z } from 'zod'

const currencyConfigSchema = z.object({
    id: z.string(),
    symbol: z.string(),
    decimals: z.number().int().min(0).max(36),
    price: z.boolean().describe('sellers may set prices in it'),
    payable: z.boolean().describe('buyers may pay with it'),
    rate: z.string().regex(/^fixed:\d+(\.\d+)?$/, 'fixed:<usd>; without quotes, only fixed rates are safe'),
})

export type CurrencyConfig = z.infer<typeof currencyConfigSchema>
export type Currency = CurrencyConfig & { parsed: ParsedCurrency }

// Prices in USD, paid in USDC or USDT on Ethereum mainnet; symbol and decimals verified on-chain.
const defaults: CurrencyConfig[] = [
    { id: 'iso4217:USD', symbol: 'USD', decimals: 2, price: true, payable: false, rate: 'fixed:1' },
    { id: 'eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6, price: false, payable: true, rate: 'fixed:1' },
    { id: 'eip155:1/erc20:0xdac17f958d2ee523a2206206994597c13d831ec7', symbol: 'USDT', decimals: 6, price: false, payable: true, rate: 'fixed:1' },
]

export function parseCurrencies(json: string | undefined): Currency[] {
    const list = json ? z.array(currencyConfigSchema).parse(JSON.parse(json)) : defaults
    return list.map(c => ({ ...c, parsed: parseCurrencyId(c.id) }))
}

export const usdRate = (currency: Currency) => currency.rate.slice('fixed:'.length)

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b

// Price → amount in the payment currency's smallest unit, at the configured fixed rates.
export function convert(amount: string, from: Currency, to: Currency): bigint {
    if (from.id === to.id) return parseUnits(amount, to.decimals)
    const usd18 = (parseUnits(amount, 18) * parseUnits(usdRate(from), 18)) / 10n ** 18n
    return ceilDiv(usd18 * 10n ** BigInt(to.decimals), parseUnits(usdRate(to), 18))
}

