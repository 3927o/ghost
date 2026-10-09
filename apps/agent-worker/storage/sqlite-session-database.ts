import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SessionLogOffset, type SessionEvent, type SessionHeader, type SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionFormatUnsupportedError,
  SessionOwnershipLostError, SessionPersistenceCorruptionError, SessionPersistenceNotFoundError,
  SessionPersistenceRevision, assertContiguous, assertStoredId, assertVersion,
  materializeCreateHeader, validateStoredEvents,
  type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'

export const WRITER_LEASE_MS = 60_000

interface StoredSession {
  id: string
  header: string
  inherited_event_count: number
  event_count: number
  generation: string
}

interface Writer {
  token: string
  hostname: string
  pid: number
  expires_at: number
}

/** SQLite details stay behind the DSH persistence provider. */
export class SqliteSessionDatabase {
  private readonly db: DatabaseSync
  readonly path: string

  constructor(path: string) {
    if (!path.trim()) throw new Error('Session database path must not be empty')
    this.path = resolve(path)
    mkdirSync(dirname(this.path), { recursive: true })
    this.db = new DatabaseSync(this.path, { timeout: 5_000 })
    try {
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      this.transaction(() => {
        this.db.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'))
      })
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  // All queries in a transaction run synchronously; never await between them.
  private transaction<T>(operation: () => T, write = true): T {
    this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
    try {
      const result = operation()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  private row(id: SessionId): StoredSession | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as StoredSession | undefined
  }

  private requireRow(id: SessionId): StoredSession {
    const row = this.row(id)
    if (!row) throw new SessionPersistenceNotFoundError(id)
    return row
  }

  private metadata(row: StoredSession) {
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
      throw new SessionPersistenceCorruptionError(`Invalid SQLite session metadata for "${row.id}"`, { cause: error })
    }
  }

  private snapshot(row: StoredSession): SessionPersistenceSnapshot {
    return {
      header: this.metadata(row).header,
      eventCount: row.event_count,
      revision: SessionPersistenceRevision(`${row.generation}:${row.event_count}`),
    }
  }

  stat(id: SessionId): SessionPersistenceSnapshot | undefined {
    const row = this.row(id)
    return row && this.snapshot(row)
  }

  list(): readonly SessionPersistenceSnapshot[] {
    return (this.db.prepare('SELECT * FROM sessions').all() as unknown as StoredSession[])
      .map(row => this.snapshot(row))
  }

  private createMetadata(header: SessionHeader, inheritedEventCount?: number) {
    const snapshot = materializeCreateHeader(header)
    assertVersion(snapshot)
    if (typeof snapshot.isSeeded !== 'boolean') throw new TypeError('Session header requires isSeeded')
    if (snapshot.isSeeded && inheritedEventCount === undefined) throw new TypeError('Seeded session requires inheritedEventCount')
    const cut = SessionLogOffset(inheritedEventCount ?? 0)
    if (!snapshot.isSeeded && cut !== 0) throw new TypeError('Unseeded session inheritedEventCount must be 0')
    return { header: Object.freeze(snapshot), inheritedEventCount: cut }
  }

  private insertSession(header: SessionHeader, inheritedEventCount: number): void {
    this.db.prepare('INSERT INTO sessions (id, header, inherited_event_count, generation) VALUES (?, ?, ?, ?)')
      .run(header.id, JSON.stringify(header), inheritedEventCount, randomUUID())
  }

  create(header: SessionHeader, inheritedEventCount?: number) {
    const metadata = this.createMetadata(header, inheritedEventCount)
    return this.transaction(() => {
      if (this.row(header.id)) throw new SessionAlreadyExistsError(header.id)
      this.insertSession(metadata.header, metadata.inheritedEventCount)
      const token = this.claimWriter(header.id)
      return { ...metadata, token }
    })
  }

  open(id: SessionId, write: boolean) {
    return this.transaction(() => {
      const row = this.requireRow(id)
      return { ...this.metadata(row), token: write ? this.claimWriter(id) : undefined }
    }, write)
  }

  private processAlive(writer: Writer): boolean {
    if (writer.hostname !== hostname()) return true
    try {
      process.kill(writer.pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }

  /** Called inside an immediate transaction, so only one process can claim. */
  private claimWriter(id: SessionId): string {
    const writer = this.db.prepare('SELECT * FROM session_writers WHERE session_id = ?').get(id) as Writer | undefined
    if (writer && writer.expires_at > Date.now() && this.processAlive(writer)) throw new SessionAlreadyOwnedError(id)
    const token = randomUUID()
    this.db.prepare(`
      INSERT INTO session_writers (session_id, token, hostname, pid, expires_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        token = excluded.token, hostname = excluded.hostname, pid = excluded.pid, expires_at = excluded.expires_at
    `).run(id, token, hostname(), process.pid, Date.now() + WRITER_LEASE_MS)
    return token
  }

  renewWriter(id: SessionId, token: string): void {
    const now = Date.now()
    const result = this.db.prepare(`
      UPDATE session_writers SET expires_at = ? WHERE session_id = ? AND token = ? AND expires_at > ?
    `).run(now + WRITER_LEASE_MS, id, token, now)
    if (result.changes !== 1) throw new SessionOwnershipLostError(id)
  }

  releaseWriter(id: SessionId, token: string): void {
    this.db.prepare('DELETE FROM session_writers WHERE session_id = ? AND token = ?').run(id, token)
  }

  read(id: SessionId) {
    return this.transaction(() => {
      const row = this.requireRow(id)
      const metadata = this.metadata(row)
      const records = this.db.prepare('SELECT seq, event FROM session_events WHERE session_id = ? ORDER BY seq')
        .all(id) as { seq: number; event: string }[]
      let events: SessionEvent[]
      try {
        events = records.map((record, index) => {
          const event = JSON.parse(record.event)
          if (record.seq !== index || event.seq !== record.seq) throw new Error('Event sequence mismatch')
          return event
        })
        if (events.length !== row.event_count) throw new Error('Event count mismatch')
        if (events.length < metadata.inheritedEventCount) throw new Error('Inherited prefix is incomplete')
      } catch (error) {
        throw new SessionPersistenceCorruptionError(`Invalid SQLite event log for "${id}"`, { cause: error })
      }
      validateStoredEvents(metadata.header, events)
      return { ...metadata, events }
    }, false)
  }

  append(id: SessionId, token: string, batch: readonly SessionEvent[]): void {
    this.transaction(() => {
      this.renewWriter(id, token)
      const row = this.requireRow(id)
      assertContiguous(id, batch, row.event_count)
      validateStoredEvents(this.metadata(row).header, [...batch])
      this.insertEvents(id, batch, row.event_count)
    })
  }

  private insertEvents(id: SessionId, events: readonly SessionEvent[], cursor: number): void {
    const insert = this.db.prepare('INSERT INTO session_events (session_id, seq, event) VALUES (?, ?, ?)')
    for (const event of events) insert.run(id, event.seq, JSON.stringify(event))
    this.db.prepare('UPDATE sessions SET event_count = ? WHERE id = ?').run(cursor + events.length, id)
  }

  close(): void {
    this.db.close()
  }
}
