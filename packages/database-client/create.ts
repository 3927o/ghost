import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { postgres } from './drivers/postgres.ts'
import { mysql } from './drivers/mysql.ts'
import { sqlite } from './drivers/sqlite.ts'
import type { DatabaseClient, DatabaseConfig, DatabaseModels, EntityManager } from './types.ts'

// SQLite has one connection per DataSource. Serialize access across clients opening
// the same file in this process, including reads, so no operation joins another tx.
const sqliteQueues = new Map<string, Promise<unknown>>()
async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = sqliteQueues.get(key) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(work)
  sqliteQueues.set(key, pending)
  try { return await pending } finally { if (sqliteQueues.get(key) === pending) sqliteQueues.delete(key) }
}

export async function createDatabase(config: DatabaseConfig, models: DatabaseModels): Promise<DatabaseClient> {
  if (config.type !== 'sqlite' && (!config.url || !Number.isInteger(config.poolSize ?? 10) || (config.poolSize ?? 10) < 1)) {
    throw new Error('Database URL and positive integer poolSize are required')
  }
  const options = config.type === 'sqlite' ? sqlite(config.path) : config.type === 'postgres' ? postgres(config) : mysql(config)
  const source = new DataSource({ ...options, entities: models.entities, synchronize: false, logging: false })
  const key = config.type === 'sqlite' ? (config.path === ':memory:' ? `memory:${crypto.randomUUID()}` : resolve(config.path)) : undefined
  const serialize = <T>(work: () => Promise<T>): Promise<T> => key ? exclusive(key, work) : work()
  try {
    await serialize(async () => {
      await source.initialize()
      if (key) {
        await source.query('PRAGMA foreign_keys = ON')
        await source.query('PRAGMA journal_mode = WAL')
        await source.query('PRAGMA synchronous = FULL')
      }
      const runner = source.createQueryRunner()
      await runner.connect()
      let mysqlLocked = false
      let transaction = false
      try {
        if (config.type === 'postgres') {
          await runner.startTransaction()
          transaction = true
          await runner.query('SELECT pg_advisory_xact_lock(514004)')
        } else if (config.type === 'mysql') {
          const rows = await runner.query("SELECT GET_LOCK('ghost-schema', 30) AS acquired")
          if (Number(rows[0].acquired) !== 1) throw new Error('Timed out waiting for schema initialization')
          mysqlLocked = true
        } else {
          await runner.query('BEGIN IMMEDIATE')
          transaction = true
          await runner.query('CREATE TABLE IF NOT EXISTS ghost_sqlite_lock (id INTEGER PRIMARY KEY)')
          await runner.query('INSERT OR IGNORE INTO ghost_sqlite_lock (id) VALUES (1)')
        }
        await models.initialize(runner)
        if (transaction) {
          if (key) await runner.query('COMMIT')
          else await runner.commitTransaction()
          transaction = false
        }
      } catch (error) {
        if (transaction) {
          try { if (key) await runner.query('ROLLBACK'); else await runner.rollbackTransaction() } catch { /* preserve original error */ }
        }
        throw error
      } finally {
        try { if (mysqlLocked) await runner.query("SELECT RELEASE_LOCK('ghost-schema')") } finally { await runner.release() }
      }
    })
  } catch (error) {
    if (source.isInitialized) await source.destroy().catch(() => {})
    throw error
  }

  let closing = false
  let closed: Promise<void> | undefined
  const active = new Set<Promise<unknown>>()
  function execute<T>(operation: (manager: EntityManager) => Promise<T>, write: boolean): Promise<T> {
    if (closing) return Promise.reject(new Error('Database client is closing'))
    const pending = serialize(async () => {
      // Retry only SQLite lock acquisition before invoking the callback. Never
      // replay a callback after an ambiguous commit or an application failure.
      for (let attempt = 0; ; attempt++) {
        let entered = false
        try {
          return await source.transaction(key ? 'SERIALIZABLE' : write ? 'READ COMMITTED' : 'REPEATABLE READ', async manager => {
            if (key && write) await manager.query('UPDATE ghost_sqlite_lock SET id = id WHERE id = 1')
            entered = true
            return operation(manager)
          })
        } catch (error) {
          if (entered || !key || attempt >= 4 || !String(error).includes('SQLITE_BUSY')) throw error
          await delay(20 * (attempt + 1))
        }
      }
    })
    active.add(pending)
    void pending.finally(() => active.delete(pending)).catch(() => {})
    return pending
  }
  return {
    read: operation => execute(operation, false),
    transaction: operation => execute(operation, true),
    close() {
      closing = true
      return closed ??= (async () => {
        await Promise.allSettled([...active])
        await serialize(() => source.destroy())
      })()
    },
  }
}
