import { normalizeCurrencyId } from './currency.ts'
import { normalizeTag } from './identity.ts'
import type { RecordType } from './records.ts'

function trimDeep(value: unknown): unknown {
    if (typeof value === 'string') return value.trim() || undefined
    if (Array.isArray(value)) return value.map(trimDeep).filter(v => v !== undefined)
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimDeep(v)]).filter(([, v]) => v !== undefined))
    }
    return value
}

function tagList(value: unknown): string[] | undefined {
    const raw = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value.map(String) : []
    const tags = [...new Set(raw.map(normalizeTag).filter(Boolean))]
    return tags.length ? tags : undefined
}

// Turns loose client input into the exact payload that gets signed; validation happens afterwards.
export function normalizeDraft(type: RecordType, payload: unknown): unknown {
    const draft = trimDeep(payload) as Record<string, unknown> | undefined
    if (!draft || typeof draft !== 'object') return draft
    if (type === 'add_node') return { ...draft, tags: tagList(draft.tags) }
    if (type === 'add_tag' && typeof draft.tag === 'string') return { ...draft, tag: normalizeTag(draft.tag) }
    if (type === 'add_private_part') return normalizePrivatePart(draft)
    return draft
}

function normalizePrivatePart(draft: Record<string, unknown>) {
    const price = draft.price as { amount?: unknown; currency?: unknown } | undefined
    const accepted = draft.acceptedCurrencies
    return {
        ...draft,
        encryptedRef: typeof draft.encryptedRef === 'string' ? draft.encryptedRef.toLowerCase() : draft.encryptedRef,
        iv: typeof draft.iv === 'string' ? draft.iv.toLowerCase() : draft.iv,
        price: price && {
            ...price,
            currency: typeof price.currency === 'string' ? normalizeCurrencyId(price.currency) : price.currency,
        },
        acceptedCurrencies: Array.isArray(accepted) && accepted.length ? [...new Set(accepted.map(c => normalizeCurrencyId(String(c))))] : undefined,
    }
}
