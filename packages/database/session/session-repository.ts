import { MoreThan } from 'typeorm'
import type { EntityManager } from '@ghost/database-client'
import { SessionEntity, EventEntity, WriterEntity, type SessionRow, type WriterRow, type EventRow } from './entities.ts'
export class SessionRepository {
  private readonly manager: EntityManager
  constructor(manager: EntityManager) { this.manager = manager }
  find(id: string) { return this.manager.getRepository(SessionEntity).findOneBy({ id }) }
  list() { return this.manager.getRepository(SessionEntity).find() }
  async insert(row: SessionRow): Promise<void> { await this.manager.getRepository(SessionEntity).insert(row) }
  async lock(id: string): Promise<boolean> { return (await this.manager.getRepository(SessionEntity).increment({ id }, 'lock_version', 1)).affected === 1 }
  writer(id: string) { return this.manager.getRepository(WriterEntity).findOneBy({ session_id: id }) }
  async claim(writer: WriterRow): Promise<void> { await this.manager.getRepository(WriterEntity).upsert(writer, ['session_id']) }
  async renew(id: string, token: string, now: number, expiresAt: number): Promise<boolean> {
    return (await this.manager.getRepository(WriterEntity).update({ session_id: id, token, expires_at: MoreThan(now) }, { expires_at: expiresAt })).affected === 1
  }
  async release(id: string, token: string): Promise<void> { await this.manager.getRepository(WriterEntity).delete({ session_id: id, token }) }
  events(id: string) { return this.manager.getRepository(EventEntity).find({ where: { session_id: id }, order: { seq: 'ASC' } }) }
  async append(id: string, events: EventRow[], count: number): Promise<void> {
    // Bounded chunks also stay below SQLite's parameter limit for large flushes.
    for (let offset = 0; offset < events.length; offset += 100) await this.manager.getRepository(EventEntity).insert(events.slice(offset, offset + 100))
    await this.manager.getRepository(SessionEntity).update({ id }, { event_count: count })
  }
}
