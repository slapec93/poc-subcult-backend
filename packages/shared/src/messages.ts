import { hashMessage, recoverPublicKey } from 'viem'
import { publicKeyToAddress } from 'viem/accounts'
import { z } from 'zod'
import { canonicalJson } from './canonical.ts'
import { addressSchema, APP_ID, signatureSchema } from './records.ts'

// Signed requests that are not records: they go to one operator and never onto Swarm or the chain.
const ref = z.string().regex(/^[0-9a-f]{64}$/)
const expiresAt = z.iso.datetime().describe('the signature is refused after this; at most 15 minutes ahead')

export const registerKeyMessageSchema = z.strictObject({
    app: z.literal(APP_ID),
    type: z.literal('register_key'),
    privatePart: ref,
    key: z.string().regex(/^[0-9a-f]{64}$/, 'the 32-byte AES key as hex'),
    expiresAt,
})

export const unlockMessageSchema = z.strictObject({
    app: z.literal(APP_ID),
    type: z.literal('unlock'),
    privatePart: ref,
    buyer: addressSchema,
    txHash: z
        .string()
        .regex(/^0x[0-9a-f]{64}$/)
        .optional()
        .describe('the payment; required for a first unlock, omitted by a returning buyer'),
    expiresAt,
})

export type RegisterKeyMessage = z.infer<typeof registerKeyMessageSchema>
export type UnlockMessage = z.infer<typeof unlockMessageSchema>

export const signedSchema = <T extends z.ZodType>(message: T) => z.strictObject({ message, signature: signatureSchema })

const MAX_VALIDITY_MS = 15 * 60_000

export function isFresh(message: { expiresAt: string }, now = Date.now()): boolean {
    const expires = Date.parse(message.expiresAt)
    return expires > now && expires - now <= MAX_VALIDITY_MS
}

// Returns the signer's uncompressed public key and address, so a response can be encrypted to that key.
export async function recoverMessageSigner(message: object, signature: string) {
    try {
        const publicKey = await recoverPublicKey({ hash: hashMessage(canonicalJson(message)), signature: signature as `0x${string}` })
        return { publicKey, address: publicKeyToAddress(publicKey).toLowerCase() }
    } catch {
        return null
    }
}
