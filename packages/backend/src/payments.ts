import { createChainClient } from '@subcult/shared'
import { parseAbi, parseEventLogs, type Hash } from 'viem'
import type { Currency } from './currencies.ts'
import { HttpError } from './publish.ts'

const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])

type Chain = ReturnType<typeof createChainClient>

export interface Expected {
    buyer: string
    payTo: string
    afterBlock: bigint
    options: Array<{ currency: Currency; minAmount: bigint }>
}

// Accepts the first currency in which the transaction paid the seller enough, from the buyer, after the part was published.
export async function verifyPayment(chain: Chain, confirmations: number, expected: Expected, hash: Hash) {
    const receipt = await chain.getTransactionReceipt({ hash }).catch(() => null)
    if (!receipt) throw new HttpError(404, 'transaction not found; it may not be mined yet')
    if (receipt.status !== 'success') throw new HttpError(400, 'transaction failed')
    const depth = (await chain.getBlockNumber()) - receipt.blockNumber + 1n
    if (depth < BigInt(confirmations)) throw new HttpError(409, `wait for ${confirmations} confirmations (has ${depth})`)
    if (receipt.blockNumber <= expected.afterBlock) throw new HttpError(400, 'payment was made before this part was published')

    const tx = await chain.getTransaction({ hash })
    if (tx.from.toLowerCase() !== expected.buyer) throw new HttpError(400, 'transaction was not sent by the buyer')

    const transfers = parseEventLogs({ abi: transferAbi, logs: receipt.logs, eventName: 'Transfer' }).filter(
        log => log.args.from.toLowerCase() === expected.buyer && log.args.to.toLowerCase() === expected.payTo,
    )
    const found = []
    for (const { currency, minAmount } of expected.options) {
        const { parsed } = currency
        const paid =
            parsed.kind === 'native'
                ? tx.to?.toLowerCase() === expected.payTo
                    ? tx.value
                    : 0n
                : parsed.kind === 'erc20'
                  ? transfers.filter(log => log.address.toLowerCase() === parsed.address).reduce((sum, log) => sum + log.args.value, 0n)
                  : 0n
        if (paid >= minAmount) return { currency, paid, blockNumber: receipt.blockNumber }
        if (paid > 0n) found.push(`${paid} of ${minAmount} ${currency.symbol}`)
    }
    throw new HttpError(400, found.length ? `underpaid: ${found.join(', ')}` : 'no accepted payment from the buyer to the seller in this transaction')
}
