import pg from 'pg'

export type Db = pg.Pool
export type DbClient = pg.PoolClient

export function createDb(connectionString: string): Db {
    return new pg.Pool({ connectionString })
}

export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
    const client = await db.connect()
    try {
        await client.query('BEGIN')
        const result = await fn(client)
        await client.query('COMMIT')
        return result
    } catch (err) {
        await client.query('ROLLBACK')
        throw err
    } finally {
        client.release()
    }
}
