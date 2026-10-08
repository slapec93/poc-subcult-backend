import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { encrypt } from 'eciesjs'
import { hexToBytes, toHex } from 'viem'

function masterKeyBytes(masterKey: string) {
    if (!/^[0-9a-f]{64}$/i.test(masterKey)) throw new Error('MASTER_KEY must be 32 bytes as hex')
    return Buffer.from(masterKey, 'hex')
}

// Content keys at rest: AES-256-GCM under MASTER_KEY, stored as iv|tag|ciphertext in base64.
export function sealKey(masterKey: string, keyHex: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', masterKeyBytes(masterKey), iv)
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(keyHex, 'hex')), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
}

export function openKey(masterKey: string, sealed: string): string {
    const data = Buffer.from(sealed, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', masterKeyBytes(masterKey), data.subarray(0, 12))
    decipher.setAuthTag(data.subarray(12, 28))
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('hex')
}

// ECIES to the buyer's secp256k1 public key, recovered from their unlock signature.
export function encryptForBuyer(publicKey: `0x${string}`, keyHex: string): string {
    return toHex(encrypt(publicKey.slice(2), hexToBytes(`0x${keyHex}`)))
}
