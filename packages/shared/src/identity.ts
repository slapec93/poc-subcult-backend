import type { NodePayload } from './records.ts'

export function normalizeText(value: string): string {
    return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

export function normalizeTag(tag: string): string {
    return normalizeText(tag).replace(/^#/, '')
}

function youtubeId(url: URL): string | null {
    const host = url.hostname.replace(/^(www\.|m\.|music\.)/, '')
    if (host === 'youtu.be') return url.pathname.slice(1) || null
    if (host !== 'youtube.com') return null
    if (url.pathname === '/watch') return url.searchParams.get('v')
    const match = url.pathname.match(/^\/(shorts|embed|live)\/([^/]+)/)
    return match ? match[2] : null
}

export function normalizeSourceUrl(raw: string): string {
    const url = new URL(raw)
    const video = youtubeId(url)
    if (video) return `youtube:${video}`
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`.toLowerCase()
}

// Two creation records with the same key describe the same node; null means the node is unique by its record.
export function identityKey(node: Pick<NodePayload, 'kind' | 'title' | 'where' | 'externalUrl'>): string | null {
    switch (node.kind) {
        case 'sound':
            return node.externalUrl ? `sound:${normalizeSourceUrl(node.externalUrl)}` : null
        case 'person':
            return `person:${normalizeText(node.title)}`
        case 'place':
            return `place:${normalizeText(node.title)}|${normalizeText(node.where ?? '')}`
    }
}
