import { Bee } from '@ethersphere/bee-js'
import { ChunkSplitter } from '@ethersphere/core-sdk'

// The /bytes reference of data, computed locally: the root of its chunk tree.
export async function swarmReference(data: Uint8Array): Promise<string> {
    return (await ChunkSplitter.root(data)).hash().toHex()
}

// Uploads are direct (not deferred) so content is on the network before a record is announced, and pinned on the operator's node.
const uploadOptions = { deferred: false, pin: true }

export class Swarm {
    private readonly bee: Bee

    constructor(
        readonly beeUrl: string,
        private readonly batchId?: string,
    ) {
        this.bee = new Bee(beeUrl)
    }

    async uploadBytes(data: Uint8Array): Promise<string> {
        const expected = await swarmReference(data)
        const { reference } = await this.bee.data.upload(this.requireBatch(), data, uploadOptions)
        if (reference.toHex() !== expected) throw new Error(`Bee returned ${reference.toHex()} for data whose reference is ${expected}`)
        return expected
    }

    async uploadFile(data: Uint8Array, name: string, contentType: string): Promise<string> {
        const { reference } = await this.bee.file.upload(this.requireBatch(), data, name, { ...uploadOptions, contentType })
        return reference.toHex()
    }

    // Verified against the reference, so an untrusted node or gateway cannot substitute content.
    async downloadBytes(ref: string, timeoutMs = 60_000): Promise<Uint8Array> {
        const data = (await this.bee.data.download(ref, undefined, { timeout: timeoutMs })).toUint8Array()
        if ((await swarmReference(data)) !== ref) throw new Error(`content returned for ${ref} does not match the reference`)
        return data
    }

    fileUrl(ref: string): string {
        return `${this.beeUrl}/bzz/${ref}/`
    }

    private requireBatch() {
        if (!this.batchId) throw new Error('POSTAGE_BATCH_ID is not configured')
        return this.batchId
    }
}
