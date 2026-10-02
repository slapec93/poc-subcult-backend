export const nodeKinds = ['sound', 'person', 'place'] as const
export type NodeKind = (typeof nodeKinds)[number]

export const soundFormats = ['track', 'tape', 'release', 'dj_set', 'radio_show'] as const

interface ConnectionType {
    label: string
    inverse: string
    from: readonly NodeKind[]
    to: readonly NodeKind[]
}

export const connectionTypes = {
    recorded_by: { label: 'Recorded by', inverse: 'Recorded', from: ['sound'], to: ['person'] },
    played_by_dj: { label: 'Played by DJ', inverse: 'Played', from: ['sound'], to: ['person'] },
    played_at: { label: 'Played at', inverse: 'Played here', from: ['sound'], to: ['place'] },
    recorded_at: { label: 'Recorded at', inverse: 'Recorded here', from: ['sound'], to: ['place'] },
    played_in_set: { label: 'Played in set', inverse: 'Includes', from: ['sound'], to: ['sound'] },
    continues_in: { label: 'Continues in', inverse: 'Continues from', from: ['sound'], to: ['sound'] },
    resident_at: { label: 'Resident at', inverse: 'Resident DJ', from: ['person'], to: ['place'] },
} as const satisfies Record<string, ConnectionType>

export type ConnectionTypeId = keyof typeof connectionTypes
export const connectionTypeIds = Object.keys(connectionTypes) as [ConnectionTypeId, ...ConnectionTypeId[]]

export function connectionAllowed(type: ConnectionTypeId, fromKind: string, toKind: string): boolean {
    const spec: ConnectionType = connectionTypes[type]
    return spec.from.includes(fromKind as NodeKind) && spec.to.includes(toKind as NodeKind)
}
