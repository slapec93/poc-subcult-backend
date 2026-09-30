import { notifyAbi, resolveChain, type Db } from '@subcult/shared'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { config } from './config.ts'

const MAX_BACKOFF_MS = 5 * 60_000

export function startOutbox(db: Db) {
    if (!config.operatorPrivateKey) {
        console.warn('OPERATOR_PRIVATE_KEY not set: posts are stored but never emitted on-chain')
        return
    }
    const { rpcUrl, chainId, contractAddress } = config.chain
    const wallet = createWalletClient({
        account: privateKeyToAccount(config.operatorPrivateKey),
        chain: resolveChain(chainId, rpcUrl),
        transport: http(rpcUrl),
    })
    console.log(`Outbox sending from ${wallet.account.address} to ${contractAddress}`)

    const tick = async () => {
        const { rows } = await db.query<{ swarm_ref: string; attempts: number }>(
            `SELECT swarm_ref, attempts FROM chain_outbox
             WHERE status = 'pending' AND next_attempt_at <= now()
             ORDER BY created_at LIMIT 20`,
        )
        for (const row of rows) {
            try {
                const hash = await wallet.writeContract({
                    address: contractAddress,
                    abi: notifyAbi,
                    functionName: 'notify',
                    args: [`0x${row.swarm_ref}`],
                })
                await db.query(`UPDATE chain_outbox SET status = 'sent', tx_hash = $2, last_error = NULL WHERE swarm_ref = $1`, [
                    row.swarm_ref,
                    hash,
                ])
                console.log(`notify(${row.swarm_ref}) -> ${hash}`)
            } catch (err) {
                const backoff = Math.min(1000 * 2 ** row.attempts, MAX_BACKOFF_MS)
                await db.query(
                    `UPDATE chain_outbox SET attempts = attempts + 1, last_error = $2,
                     next_attempt_at = now() + ($3 || ' milliseconds')::interval WHERE swarm_ref = $1`,
                    [row.swarm_ref, String(err), backoff],
                )
                console.error(`notify(${row.swarm_ref}) failed, retrying in ${backoff}ms:`, err)
            }
        }
    }

    const loop = async () => {
        try {
            await tick()
        } catch (err) {
            console.error('Outbox tick failed:', err)
        }
        setTimeout(loop, config.outboxIntervalMs)
    }
    void loop()
}
