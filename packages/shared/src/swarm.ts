export class Swarm {
    constructor(
        readonly beeUrl: string,
        private readonly batchId?: string,
    ) {}

    async uploadBytes(data: Uint8Array): Promise<string> {
        return this.upload('/bytes', data, 'application/octet-stream')
    }

    async uploadFile(data: Uint8Array, name: string, contentType: string): Promise<string> {
        return this.upload(`/bzz?name=${encodeURIComponent(name)}`, data, contentType)
    }

    async downloadBytes(ref: string, timeoutMs = 60_000): Promise<Uint8Array> {
        const res = await fetch(`${this.beeUrl}/bytes/${ref}`, { signal: AbortSignal.timeout(timeoutMs) })
        if (!res.ok) {
            throw new Error(`Bee download ${ref} failed: HTTP ${res.status}`)
        }
        return new Uint8Array(await res.arrayBuffer())
    }

    fileUrl(ref: string): string {
        return `${this.beeUrl}/bzz/${ref}/`
    }

    private async upload(path: string, data: Uint8Array, contentType: string): Promise<string> {
        if (!this.batchId) {
            throw new Error('POSTAGE_BATCH_ID is not configured')
        }
        const res = await fetch(`${this.beeUrl}${path}`, {
            method: 'POST',
            headers: { 'content-type': contentType, 'swarm-postage-batch-id': this.batchId },
            body: data as Uint8Array<ArrayBuffer>,
        })
        if (!res.ok) {
            throw new Error(`Bee upload failed: HTTP ${res.status} ${await res.text()}`)
        }
        const { reference } = (await res.json()) as { reference: string }
        return reference
    }
}
