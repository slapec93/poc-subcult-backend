import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { normalizeTag } from './identity.ts'
import { connectionTypeIds, nodeKinds, soundFormats } from './model.ts'

export const APP_ID = 'subcult'
export const RECORD_VERSION = 2

const ref = z.string().regex(/^[0-9a-f]{64}$/)
const text = (max: number) => z.string().trim().min(1).max(max)
export const tagSchema = z.string().transform(normalizeTag).pipe(z.string().min(1).max(50))

export const nodePayloadSchema = z
    .object({
        kind: z.enum(nodeKinds),
        title: text(300),
        role: text(100).optional(),
        where: text(200).optional(),
        years: text(50).optional(),
        externalUrl: z.url().optional(),
        format: z.enum(soundFormats).optional(),
        audioRef: ref.optional(),
        artworkRef: ref.optional(),
        tags: z.array(tagSchema).max(30).default([]),
        note: text(10_000).optional(),
    })
    .superRefine((node, ctx) => {
        if (node.kind !== 'sound') {
            if (node.format || node.audioRef) ctx.addIssue({ code: 'custom', message: 'format and audio are for sounds only' })
            return
        }
        if (!node.note) ctx.addIssue({ code: 'custom', path: ['note'], message: 'a sound needs a note on why it matters' })
        if (!node.audioRef && !node.externalUrl) {
            ctx.addIssue({ code: 'custom', message: 'a sound needs uploaded audio or a link' })
        }
    })

export const notePayloadSchema = z.object({ node: ref, text: text(10_000) })

export const connectionPayloadSchema = z.object({
    from: ref,
    type: z.enum(connectionTypeIds),
    to: ref,
    note: text(2_000),
    source: z.url().optional(),
})

export const tagPayloadSchema = z.object({ node: ref, tag: tagSchema })

const envelope = {
    app: z.literal(APP_ID),
    v: z.literal(RECORD_VERSION),
    author: text(100),
    createdAt: z.iso.datetime(),
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
    signature: z.string().nullable(),
}

export const recordSchema = z.discriminatedUnion('type', [
    z.object({ ...envelope, type: z.literal('add_node'), payload: nodePayloadSchema }),
    z.object({ ...envelope, type: z.literal('add_note'), payload: notePayloadSchema }),
    z.object({ ...envelope, type: z.literal('add_connection'), payload: connectionPayloadSchema }),
    z.object({ ...envelope, type: z.literal('add_tag'), payload: tagPayloadSchema }),
])

export type SubcultRecord = z.infer<typeof recordSchema>
export type RecordType = SubcultRecord['type']
export type NodePayload = z.infer<typeof nodePayloadSchema>
export type PayloadOf<T extends RecordType> = Extract<SubcultRecord, { type: T }>['payload']

export function buildRecord<T extends RecordType>(type: T, author: string, payload: z.input<typeof recordSchema>['payload']) {
    return recordSchema.parse({
        app: APP_ID,
        v: RECORD_VERSION,
        type,
        author,
        createdAt: new Date().toISOString(),
        nonce: randomBytes(16).toString('hex'),
        signature: null,
        payload,
    }) as Extract<SubcultRecord, { type: T }>
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
