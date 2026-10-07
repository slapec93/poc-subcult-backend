import { randomBytes } from 'node:crypto'
import { recoverMessageAddress } from 'viem'
import { z } from 'zod'
import { canonicalJson } from './canonical.ts'
import { normalizeTag } from './identity.ts'
import { connectionTypeIds, nodeKinds, soundFormats } from './model.ts'

export const APP_ID = 'subcult'
export const RECORD_VERSION = 3

// Signed content is validated, never transformed: any change would invalidate the signature.
const ref = z.string().regex(/^[0-9a-f]{64}$/)
export const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/, 'a lowercase 0x-prefixed Ethereum address')
const webUrl = z.url({ protocol: /^https?$/ })
const text = (max: number) =>
    z
        .string()
        .min(1)
        .max(max)
        .refine(s => s.trim() === s, 'no leading or trailing whitespace')
const tag = z
    .string()
    .min(1)
    .max(50)
    .refine(t => normalizeTag(t) === t, 'tags are lowercase and trimmed, without a leading #')

export const nodePayloadSchema = z
    .strictObject({
        kind: z.enum(nodeKinds),
        title: text(300),
        role: text(100).optional(),
        where: text(200).optional(),
        years: text(50).optional(),
        externalUrl: webUrl.optional(),
        format: z.enum(soundFormats).optional(),
        audioRef: ref.optional(),
        artworkRef: ref.optional(),
        tags: z.array(tag).max(30).optional(),
        note: text(10_000).optional(),
    })
    .superRefine((node, ctx) => {
        if (node.tags && new Set(node.tags).size !== node.tags.length) {
            ctx.addIssue({ code: 'custom', path: ['tags'], message: 'tags must be unique' })
        }
        if (node.kind !== 'sound') {
            if (node.format || node.audioRef) ctx.addIssue({ code: 'custom', message: 'format and audio are for sounds only' })
            return
        }
        if (!node.note) ctx.addIssue({ code: 'custom', path: ['note'], message: 'a sound needs a note on why it matters' })
        if (!node.audioRef && !node.externalUrl) {
            ctx.addIssue({ code: 'custom', message: 'a sound needs uploaded audio or a link' })
        }
    })

export const notePayloadSchema = z.strictObject({ node: ref, text: text(10_000) })

export const connectionPayloadSchema = z.strictObject({
    from: ref,
    type: z.enum(connectionTypeIds),
    to: ref,
    note: text(2_000),
    source: webUrl.optional(),
})

export const tagPayloadSchema = z.strictObject({ node: ref, tag })

const payloads = {
    add_node: nodePayloadSchema,
    add_note: notePayloadSchema,
    add_connection: connectionPayloadSchema,
    add_tag: tagPayloadSchema,
} as const

export const recordTypes = Object.keys(payloads) as [keyof typeof payloads, ...(keyof typeof payloads)[]]

const envelope = {
    app: z.literal(APP_ID),
    v: z.literal(RECORD_VERSION),
    owner: addressSchema,
    createdAt: z.iso.datetime(),
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
}
const signature = z.string().regex(/^0x[0-9a-f]{130}$/, 'a 65-byte hex signature')

const variants = <S extends z.ZodRawShape>(extra: S) =>
    z.discriminatedUnion('type', [
        z.strictObject({ ...envelope, ...extra, type: z.literal('add_node'), payload: payloads.add_node }),
        z.strictObject({ ...envelope, ...extra, type: z.literal('add_note'), payload: payloads.add_note }),
        z.strictObject({ ...envelope, ...extra, type: z.literal('add_connection'), payload: payloads.add_connection }),
        z.strictObject({ ...envelope, ...extra, type: z.literal('add_tag'), payload: payloads.add_tag }),
    ])

export const unsignedRecordSchema = variants({})
export const recordSchema = variants({ signature })

export type UnsignedRecord = z.infer<typeof unsignedRecordSchema>
export type SubcultRecord = z.infer<typeof recordSchema>
export type RecordType = SubcultRecord['type']
export type NodePayload = z.infer<typeof nodePayloadSchema>
export type PayloadOf<T extends RecordType> = Extract<SubcultRecord, { type: T }>['payload']

// The message a client signs with EIP-191 personal_sign.
export function signingMessage(record: UnsignedRecord | SubcultRecord): string {
    const { signature: _, ...unsigned } = record as SubcultRecord
    return canonicalJson(unsigned)
}

export async function recoverSigner(record: SubcultRecord): Promise<string | null> {
    try {
        const address = await recoverMessageAddress({
            message: signingMessage(record),
            signature: record.signature as `0x${string}`,
        })
        return address.toLowerCase()
    } catch {
        return null
    }
}

export async function hasValidSignature(record: SubcultRecord): Promise<boolean> {
    return (await recoverSigner(record)) === record.owner
}

export function createUnsignedRecord(type: RecordType, owner: string, payload: unknown): UnsignedRecord {
    return unsignedRecordSchema.parse({
        app: APP_ID,
        v: RECORD_VERSION,
        type,
        owner,
        createdAt: new Date().toISOString(),
        nonce: randomBytes(16).toString('hex'),
        payload,
    })
}

export function serializeRecord(record: SubcultRecord): string {
    return canonicalJson(record)
}

export function parseRecord(bytes: Uint8Array): SubcultRecord | null {
    let json: unknown
    try {
        json = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
        return null
    }
    const result = recordSchema.safeParse(json)
    return result.success ? result.data : null
}
