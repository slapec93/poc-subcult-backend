import { randomBytes } from 'node:crypto'
import { z } from 'zod'

export const APP_ID = 'subcult'
export const EVENT_VERSION = 1

export const entityTypes = ['artist', 'label', 'place', 'radio_show', 'event', 'tag'] as const
export const objectKinds = ['track', 'release', 'radio_show'] as const

const swarmRef = z.string().regex(/^[0-9a-f]{64}$/)

export const entityRefSchema = z.object({
    type: z.enum(entityTypes),
    name: z.string().trim().min(1).max(200),
})

export const addObjectSchema = z.object({
    app: z.literal(APP_ID),
    v: z.literal(EVENT_VERSION),
    type: z.literal('add_object'),
    author: z.string().min(1).max(100),
    createdAt: z.iso.datetime(),
    nonce: z.string().regex(/^[0-9a-f]{32}$/),
    signature: z.string().nullable(),
    object: z.object({
        kind: z.enum(objectKinds),
        title: z.string().trim().min(1).max(300),
        note: z.string().trim().min(1).max(10_000),
        artworkRef: swarmRef.optional(),
        audioRef: swarmRef.optional(),
        externalUrl: z.url().optional(),
        entities: z.array(entityRefSchema).max(50),
    }),
})

export const subcultEventSchema = z.discriminatedUnion('type', [addObjectSchema])

export type EntityRef = z.infer<typeof entityRefSchema>
export type AddObjectEvent = z.infer<typeof addObjectSchema>
export type SubcultEvent = z.infer<typeof subcultEventSchema>

export function buildAddObjectEvent(author: string, object: AddObjectEvent['object']): AddObjectEvent {
    return addObjectSchema.parse({
        app: APP_ID,
        v: EVENT_VERSION,
        type: 'add_object',
        author,
        createdAt: new Date().toISOString(),
        nonce: randomBytes(16).toString('hex'),
        signature: null,
        object,
    })
}

export function parseEvent(bytes: Uint8Array): SubcultEvent | null {
    let json: unknown
    try {
        json = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
        return null
    }
    const result = subcultEventSchema.safeParse(json)
    return result.success ? result.data : null
}
