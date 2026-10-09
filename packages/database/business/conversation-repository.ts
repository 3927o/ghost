import { randomUUID } from 'node:crypto'
import type { EntityManager } from '@ghost/database-client'
import { ConversationEntity } from './entities.ts'
export class ConversationRepository {
  private readonly manager: EntityManager
  constructor(manager: EntityManager) { this.manager = manager }
  find(userId: string, logicalId: string) { return this.manager.getRepository(ConversationEntity).findOneBy({ user_id: userId, logical_id: logicalId }) }
  async ensure(userId: string, logicalId: string) {
    const now = Date.now()
    await this.manager.createQueryBuilder().insert().into(ConversationEntity).values({ id: randomUUID(), user_id: userId, logical_id: logicalId,
      runtime_session_id: randomUUID(), next_sequence: 0, lock_version: 0, created_at: now, updated_at: now }).orIgnore().execute()
    const row = await this.find(userId, logicalId)
    if (!row) throw new Error('Conversation could not be created')
    return this.lock(row.id)
  }
  /** A write to the conversation row serializes admission and sequence allocation on every backend. */
  async lock(id: string) {
    const repo = this.manager.getRepository(ConversationEntity)
    const result = await repo.increment({ id }, 'lock_version', 1)
    if (result.affected !== 1) throw new Error(`Conversation ${id} does not exist`)
    return (await repo.findOneByOrFail({ id }))
  }
  async nextSequence(id: string): Promise<number> {
    const repo = this.manager.getRepository(ConversationEntity)
    await repo.increment({ id }, 'next_sequence', 1)
    return (await repo.findOneByOrFail({ id })).next_sequence
  }
  async touch(id: string, time = Date.now()): Promise<void> { await this.manager.getRepository(ConversationEntity).update({ id }, { updated_at: time }) }
}
