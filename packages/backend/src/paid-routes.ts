import {
    isFresh,
    recoverMessageSigner,
    registerKeyMessageSchema,
    signedSchema,
    unlockMessageSchema,
    type Db,
} from '@subcult/shared'
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { formatUnits, type Hash } from 'viem'
import { z } from 'zod'
import { config } from './config.ts'
import { convert, usdRate, type Currency } from './currencies.ts'
import { encryptForBuyer, openKey, sealKey } from './keys.ts'
import { paymentChain } from './payment-chain.ts'
import { verifyPayment } from './payments.ts'
import { HttpError } from './publish.ts'

const id = z.string().regex(/^[0-9a-f]{64}$/)
const errorSchema = z.object({ error: z.string() })

interface PrivatePart {
    id: string
    owner: string
    encryptedRef: string
    iv: string
    contentType: string
    priceAmount: string
    priceCurrency: string
    acceptedCurrencies: string[] | null
    keyHolder: string
    paymentChainBlock: string
}

const currencyView = z.object({
    id: z.string(),
    symbol: z.string(),
    decimals: z.number(),
    price: z.boolean(),
    payable: z.boolean(),
    kind: z.enum(['fiat', 'native', 'erc20']),
    token: z.string().nullable(),
    usdRate: z.string(),
})

export const paidRoutes: FastifyPluginAsyncZod<{ db: Db }> = async (app, { db }) => {
    const chain = paymentChain
    const currencies = new Map(config.currencies.map(c => [c.id, c]))

    function requireMasterKey() {
        if (!config.masterKey) throw new HttpError(503, 'paid content is not configured on this operator (MASTER_KEY)')
        return config.masterKey
    }

    async function findPart(partId: string): Promise<PrivatePart> {
        const { rows } = await db.query<PrivatePart>(
            `SELECT id, owner, encrypted_ref AS "encryptedRef", iv, content_type AS "contentType", price_amount AS "priceAmount",
                    price_currency AS "priceCurrency", accepted_currencies AS "acceptedCurrencies", key_holder AS "keyHolder",
                    payment_chain_block AS "paymentChainBlock"
             FROM private_parts WHERE id = $1`,
            [partId],
        )
        if (!rows[0]) throw new HttpError(404, `private part ${partId} not found`)
        return rows[0]
    }

    async function sealedKey(partId: string) {
        const { rows } = await db.query<{ key_ciphertext: string }>(`SELECT key_ciphertext FROM content_keys WHERE private_part_id = $1`, [partId])
        return rows[0]?.key_ciphertext ?? null
    }

    // What the buyer may pay with, and the least they must pay in each, at fixed rates.
    function paymentOptions(part: PrivatePart) {
        const priceCurrency = currencies.get(part.priceCurrency)
        if (!priceCurrency) throw new HttpError(400, `this operator cannot price ${part.priceCurrency}`)
        return config.currencies
            .filter(c => c.payable && (!part.acceptedCurrencies || part.acceptedCurrencies.includes(c.id)))
            .filter(c => !('chainId' in c.parsed) || c.parsed.chainId === config.paymentChain.chainId)
            .map((currency: Currency) => {
                const amount = convert(part.priceAmount, priceCurrency, currency)
                return { currency, amount, minAmount: (amount * BigInt(10_000 - config.paymentToleranceBps)) / 10_000n }
            })
    }

    app.get(
        '/config',
        {
            schema: {
                tags: ['payments'],
                summary: 'What a client needs to pay: the payment chain, and the key holder URL for new private parts',
                response: {
                    200: z.object({
                        chainId: z.number().describe('where records are announced'),
                        paymentChainId: z.number().describe('where payments are made'),
                        paymentRpcUrl: z.string().describe('an RPC endpoint browsers can use to send payments'),
                        keyHolder: z.string(),
                        paymentConfirmations: z.number(),
                        paidContent: z.boolean(),
                    }),
                },
            },
        },
        async () => ({
            chainId: config.chain.chainId,
            paymentChainId: config.paymentChain.chainId,
            paymentRpcUrl: config.paymentChain.publicRpcUrl,
            keyHolder: config.publicUrl,
            paymentConfirmations: config.paymentConfirmations,
            paidContent: Boolean(config.masterKey),
        }),
    )

    app.get(
        '/currencies',
        {
            schema: {
                tags: ['payments'],
                summary: 'Currencies this operator prices and accepts, with current USD rates',
                response: { 200: z.array(currencyView) },
            },
        },
        async () =>
            config.currencies.map(c => ({
                    id: c.id,
                    symbol: c.symbol,
                    decimals: c.decimals,
                    price: c.price,
                    payable: c.payable,
                    kind: c.parsed.kind,
                    token: c.parsed.kind === 'erc20' ? c.parsed.address : null,
                    usdRate: usdRate(c),
                })),
    )

    app.post(
        '/private-parts/:id/key',
        {
            schema: {
                tags: ['payments'],
                summary: 'Seller hands the content key to this operator',
                description:
                    'Body: `{message, signature}`, where `message` is `{app: "subcult", type: "register_key", privatePart, key, expiresAt}` and ' +
                    '`signature` is personal_sign over its canonical JSON by the private part owner.',
                params: z.object({ id }),
                body: signedSchema(registerKeyMessageSchema),
                response: { 201: z.object({ ok: z.boolean() }), 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema, 409: errorSchema, 503: errorSchema },
            },
        },
        async (request, reply) => {
            const masterKey = requireMasterKey()
            const { message, signature } = request.body
            if (message.privatePart !== request.params.id) throw new HttpError(400, 'message is for another private part')
            if (!isFresh(message)) throw new HttpError(400, 'expiresAt must be in the next 15 minutes')
            const signer = await recoverMessageSigner(message, signature)
            if (!signer) throw new HttpError(401, 'invalid signature')
            const part = await findPart(message.privatePart)
            if (signer.address !== part.owner) throw new HttpError(403, 'only the seller can register the key')
            if (part.keyHolder !== config.publicUrl) throw new HttpError(400, `this part names ${part.keyHolder} as key holder`)
            const { rowCount } = await db.query(
                `INSERT INTO content_keys (private_part_id, key_ciphertext) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [part.id, sealKey(masterKey, message.key)],
            )
            if (!rowCount) throw new HttpError(409, 'a key is already registered for this part')
            return reply.code(201).send({ ok: true })
        },
    )

    app.get(
        '/private-parts/:id/payment',
        {
            schema: {
                tags: ['payments'],
                summary: 'How to pay for a private part',
                description: 'Send at least `amount` (smallest unit) of one option to `payTo` on `chainId`, in a block after `afterBlock`, then call /unlock.',
                params: z.object({ id }),
                response: {
                    200: z.object({
                        payTo: z.string(),
                        chainId: z.number(),
                        afterBlock: z.string(),
                        sellable: z.boolean().describe('whether this operator holds the key and can unlock'),
                        options: z.array(
                            z.object({ currency: z.string(), symbol: z.string(), token: z.string().nullable(), amount: z.string(), displayAmount: z.string() }),
                        ),
                    }),
                    400: errorSchema,
                    404: errorSchema,
                },
            },
        },
        async request => {
            const part = await findPart(request.params.id)
            return {
                payTo: part.owner,
                chainId: config.paymentChain.chainId,
                afterBlock: part.paymentChainBlock,
                sellable: Boolean(await sealedKey(part.id)),
                options: paymentOptions(part).map(({ currency, amount }) => ({
                    currency: currency.id,
                    symbol: currency.symbol,
                    token: currency.parsed.kind === 'erc20' ? currency.parsed.address : null,
                    amount: amount.toString(),
                    displayAmount: formatUnits(amount, currency.decimals),
                })),
            }
        },
    )

    app.post(
        '/unlock',
        {
            schema: {
                tags: ['payments'],
                summary: 'Get the content key after paying',
                description:
                    'Pay the price to the seller (see GET /private-parts/:id/payment), then send `{message, signature}`, where `message` is ' +
                    '`{app: "subcult", type: "unlock", privatePart, buyer, txHash?, expiresAt}` signed with personal_sign by the buyer. ' +
                    'A first unlock needs `txHash`; a returning buyer omits it. The key comes back ECIES-encrypted to the public key ' +
                    'recovered from the signature.',
                body: signedSchema(unlockMessageSchema),
                response: {
                    200: z.object({
                        encryptedKey: z.string().describe('ECIES (secp256k1) ciphertext of the 32-byte AES key, hex'),
                        encryptedRef: id,
                        iv: z.string(),
                        contentType: z.string(),
                        txHash: z.string(),
                    }),
                    400: errorSchema,
                    401: errorSchema,
                    402: errorSchema,
                    403: errorSchema,
                    404: errorSchema,
                    409: errorSchema,
                    503: errorSchema,
                },
            },
        },
        async request => {
            const masterKey = requireMasterKey()
            const { message, signature } = request.body
            if (!isFresh(message)) throw new HttpError(400, 'expiresAt must be in the next 15 minutes')
            const signer = await recoverMessageSigner(message, signature)
            if (!signer || signer.address !== message.buyer) throw new HttpError(401, 'signature does not match buyer')

            const part = await findPart(message.privatePart)
            const sealed = await sealedKey(part.id)
            if (!sealed) throw new HttpError(404, 'this operator has no key for this part')
            const respond = (txHash: string) => ({
                encryptedKey: encryptForBuyer(signer.publicKey, openKey(masterKey, sealed)),
                encryptedRef: part.encryptedRef,
                iv: part.iv,
                contentType: part.contentType,
                txHash,
            })

            const previous = await db.query<{ tx_hash: string }>(
                `SELECT tx_hash FROM purchases WHERE private_part_id = $1 AND buyer = $2 LIMIT 1`,
                [part.id, message.buyer],
            )
            if (previous.rows[0]) return respond(previous.rows[0].tx_hash)
            if (!message.txHash) throw new HttpError(402, 'not purchased yet: pay the seller and send txHash')
            const used = await db.query(`SELECT 1 FROM purchases WHERE tx_hash = $1`, [message.txHash])
            if (used.rowCount) throw new HttpError(409, 'transaction already used for a purchase')

            const options = paymentOptions(part)
            const { currency, paid, blockNumber } = await verifyPayment(
                chain,
                config.paymentConfirmations,
                { buyer: message.buyer, payTo: part.owner, afterBlock: BigInt(part.paymentChainBlock), options },
                message.txHash as Hash,
            )
            await db
                .query(
                    `INSERT INTO purchases (tx_hash, private_part_id, buyer, currency, amount, block_number) VALUES ($1, $2, $3, $4, $5, $6)`,
                    [message.txHash, part.id, message.buyer, currency.id, paid.toString(), blockNumber.toString()],
                )
                .catch(err => {
                    if (err.code === '23505') throw new HttpError(409, 'transaction already used for a purchase')
                    throw err
                })
            return respond(message.txHash)
        },
    )
}
