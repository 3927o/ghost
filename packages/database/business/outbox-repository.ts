import type { DatabaseAccess, EntityManager } from '@ghost/database-client'
import { OutboxEntity } from './entities.ts'
export class OutboxRepository {
  private readonly manager: EntityManager
  constructor(manager: EntityManager) { this.manager = manager }
  async add(runId: string): Promise<void> { await this.manager.getRepository(OutboxEntity).insert({ run_id: runId, created_at: Date.now() }) }
  async pending(limit = 100): Promise<string[]> {
    return (await this.manager.getRepository(OutboxEntity).find({ order: { created_at: 'ASC', run_id: 'ASC' }, take: limit })).map(row => row.run_id)
  }
  async acknowledge(runId: string): Promise<void> { await this.manager.getRepository(OutboxEntity).delete({ run_id: runId }) }
}
/** Keeps each background operation inside its own client access scope. */
export function outboxStore(db: DatabaseAccess) {
  return { pending: () => db.read(manager => new OutboxRepository(manager).pending()),
    acknowledge: (id: string) => db.transaction(manager => new OutboxRepository(manager).acknowledge(id)) }
}
