import type { Context } from '@deepseek-ai/cordis'
import { createDatabase, type DatabaseAccess, type DatabaseConfig, type EntityManager } from '@ghost/database-client'
import { sessionModels } from '@ghost/database/session'
import { DatabaseService } from './index.ts'
class OrmDatabaseService extends DatabaseService {
  private readonly client: DatabaseAccess
  constructor(client: DatabaseAccess) { super(); this.client = client }
  read<T>(operation: (manager: EntityManager) => Promise<T>): Promise<T> { return this.client.read(operation) }
  transaction<T>(operation: (manager: EntityManager) => Promise<T>): Promise<T> { return this.client.transaction(operation) }
}
export async function provideDatabase(ctx: Context, config: DatabaseConfig): Promise<void> {
  // One grouped effect runs its disposers in reverse order: unregister the service
  // and await dependent cleanup (including Session flush), then close the pool.
  const client = await createDatabase(config, sessionModels(config))
  try {
    ctx.effect(function* () {
      yield () => client.close()
      yield ctx.provide('database', new OrmDatabaseService(client))
    }, 'Agent ORM client and service')
  } catch (error) { await client.close(); throw error }
}
