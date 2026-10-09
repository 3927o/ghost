import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import type { DatabaseAccess, EntityManager } from '@ghost/database-client'
import { SessionRepository, type SessionRow, type WriterRow } from '@ghost/database/session'
import { SessionLogOffset, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionFormatUnsupportedError,
  SessionOwnershipLostError, SessionPersistenceCorruptionError, SessionPersistenceNotFoundError,
  SessionPersistenceRevision, assertContiguous, assertStoredId, assertVersion,
  materializeCreateHeader, validateStoredEvents, type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
export const WRITER_LEASE_MS = 60_000

/** DSH validation and ownership semantics; SQL lives in the shared Repository. */
export class SessionStore {
  private readonly db: DatabaseAccess
  constructor(db: DatabaseAccess) { this.db = db }
  private async requireRow(repo: SessionRepository, id: SessionId): Promise<SessionRow> {
    const row = await repo.find(id)
    if (!row) throw new SessionPersistenceNotFoundError(id)
    return row
  }
  private metadata(row: SessionRow) {
    try {
      const decoded = JSON.parse(row.header)
      assertVersion(decoded)
      const header = materializeCreateHeader(decoded)
      assertStoredId(row.id as SessionId, header)
      if (typeof header.isSeeded !== 'boolean') throw new Error('Invalid isSeeded metadata')
      const inheritedEventCount = SessionLogOffset(row.inherited_event_count)
      if (!header.isSeeded && inheritedEventCount !== 0) throw new Error('Unseeded session has inherited events')
      SessionLogOffset(row.event_count)
      return { header: Object.freeze(header), inheritedEventCount }
    } catch (error) {
      if (error instanceof SessionFormatUnsupportedError || error instanceof SessionPersistenceCorruptionError) throw error
      throw new SessionPersistenceCorruptionError(`Invalid session metadata for "${row.id}"`, { cause: error })
    }
  }
  private snapshot(row: SessionRow): SessionPersistenceSnapshot {
    return { header: this.metadata(row).header, eventCount: row.event_count, revision: SessionPersistenceRevision(`${row.generation}:${row.event_count}`) }
  }
  stat(id: SessionId): Promise<SessionPersistenceSnapshot | undefined> {
    return this.db.read(async manager => { const row = await new SessionRepository(manager).find(id); return row ? this.snapshot(row) : undefined })
  }
  list(): Promise<readonly SessionPersistenceSnapshot[]> {
    return this.db.read(async manager => (await new SessionRepository(manager).list()).map(row => this.snapshot(row)))
  }
  async create(header: SessionHeader, inheritedEventCount?: number) {
    const snapshot = materializeCreateHeader(header)
    assertVersion(snapshot)
    if (typeof snapshot.isSeeded !== 'boolean') throw new TypeError('Session header requires isSeeded')
    if (snapshot.isSeeded && inheritedEventCount === undefined) throw new TypeError('Seeded session requires inheritedEventCount')
    const cut = SessionLogOffset(inheritedEventCount ?? 0)
    if (!snapshot.isSeeded && cut !== 0) throw new TypeError('Unseeded session inheritedEventCount must be 0')
    try {
      return await this.db.transaction(async manager => {
        const repo = new SessionRepository(manager)
        if (await repo.find(header.id)) throw new SessionAlreadyExistsError(header.id)
        await repo.insert({ id: header.id, header: JSON.stringify(snapshot), inherited_event_count: cut, event_count: 0, generation: randomUUID(), lock_version: 0 })
        const token = await this.claimWriter(repo, header.id)
        return { header: Object.freeze(snapshot), inheritedEventCount: cut, token }
      })
    } catch (error) {
      const code = (error as { driverError?: { code?: string } }).driverError?.code
      if (['23505', 'ER_DUP_ENTRY', 'SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_UNIQUE'].includes(code ?? '')) throw new SessionAlreadyExistsError(header.id)
      throw error
    }
  }
  open(id: SessionId, write: boolean) {
    const operation = async (manager: EntityManager) => {
      const repo = new SessionRepository(manager)
      if (write && !await repo.lock(id)) throw new SessionPersistenceNotFoundError(id)
      const row = await this.requireRow(repo, id)
      return { ...this.metadata(row), token: write ? await this.claimWriter(repo, id) : undefined }
    }
    return write ? this.db.transaction(operation) : this.db.read(operation)
  }
  private processAlive(writer: WriterRow): boolean {
    if (writer.hostname !== hostname()) return true
    try { process.kill(writer.pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  }
  private async claimWriter(repo: SessionRepository, id: SessionId): Promise<string> {
    const writer = await repo.writer(id)
    if (writer && writer.expires_at > Date.now() && this.processAlive(writer)) throw new SessionAlreadyOwnedError(id)
    const token = randomUUID()
    await repo.claim({ session_id: id, token, hostname: hostname(), pid: process.pid, expires_at: Date.now() + WRITER_LEASE_MS })
    return token
  }
  private async renew(repo: SessionRepository, id: SessionId, token: string): Promise<void> {
    const now = Date.now()
    if (!await repo.renew(id, token, now, now + WRITER_LEASE_MS)) throw new SessionOwnershipLostError(id)
  }
  renewWriter(id: SessionId, token: string): Promise<void> {
    return this.db.transaction(async manager => {
      const repo = new SessionRepository(manager)
      await repo.lock(id)
      await this.renew(repo, id, token)
    })
  }
  releaseWriter(id: SessionId, token: string): Promise<void> {
    return this.db.transaction(async manager => {
      const repo = new SessionRepository(manager)
      await repo.lock(id)
      await repo.release(id, token)
    })
  }
  read(id: SessionId) {
    return this.db.read(async manager => {
      const repo = new SessionRepository(manager)
      const row = await this.requireRow(repo, id)
      const metadata = this.metadata(row)
      const records = await repo.events(id)
      let events: SessionEvent[]
      try {
        events = records.map((record, index) => {
          const event = JSON.parse(record.event)
          if (record.seq !== index || event.seq !== record.seq) throw new Error('Event sequence mismatch')
          return event
        })
        if (events.length !== row.event_count) throw new Error('Event count mismatch')
        if (events.length < metadata.inheritedEventCount) throw new Error('Inherited prefix is incomplete')
      } catch (error) { throw new SessionPersistenceCorruptionError(`Invalid event log for "${id}"`, { cause: error }) }
      validateStoredEvents(metadata.header, events)
      return { ...metadata, events }
    })
  }
  append(id: SessionId, token: string, batch: readonly SessionEvent[]): Promise<void> {
    return this.db.transaction(async manager => {
      const repo = new SessionRepository(manager)
      await repo.lock(id)
      await this.renew(repo, id, token)
      const row = await this.requireRow(repo, id)
      assertContiguous(id, batch, row.event_count)
      validateStoredEvents(this.metadata(row).header, [...batch])
      await repo.append(id, batch.map(event => ({ session_id: id, seq: event.seq, event: JSON.stringify(event) })), row.event_count + batch.length)
    })
  }
}
