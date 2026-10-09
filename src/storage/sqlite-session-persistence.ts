import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  SessionHandleClosedError, SessionOwnershipLostError, SessionPersistence, SessionReadOnlyError,
  materializeAppendBatch,
  type SessionAccess, type SessionHandle, type SessionHandleAppendOptions,
  type SessionHandleFlushOptions, type SessionHandleReadOptions, type SessionHandleReadResult,
  type SessionPersistenceCreateOptions, type SessionPersistenceOpenOptions,
  type SessionPersistenceStatOptions, type SessionPersistenceListOptions,
} from '@deepseek-ai/dsh-session-persistence'
import { SqliteSessionDatabase, WRITER_LEASE_MS } from './sqlite-session-database.ts'

interface Config {
  path: string
}

/** DSH persistence plugin; Agent creation/resume uses this service unchanged. */
export default class SqliteSessionPersistence extends SessionPersistence {
  private readonly database: SqliteSessionDatabase
  private readonly handles = new Set<SqliteSessionHandle>()
  private readonly writers = new Map<SessionId, SqliteSessionHandle>()
  private readonly heartbeat: NodeJS.Timeout
  private closing?: Promise<void>

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.database = new SqliteSessionDatabase(config.path)
    ctx.on('session/event', (session, event) => this.writers.get(session.id)?.enqueueLive(event))
    ctx.on('session/flush', session => this.writers.get(session.id)?.flush())
    ctx.on('session/disposed', session => {
      this.writers.get(session.id)?.close().catch(error => ctx.logger.warn(`SQLite session close failed: ${String(error)}`))
    })
    this.heartbeat = setInterval(() => {
      for (const writer of this.writers.values()) writer.renewLease()
    }, WRITER_LEASE_MS / 3)
    this.heartbeat.unref()
    ctx.effect(() => () => this.dispose(), 'SQLite session database')
  }

  private assertOpen(): void {
    if (this.closing) throw new Error('SQLite session persistence is shutting down')
  }

  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    const { header: stored, inheritedEventCount, token } = this.database.create(header, options?.inheritedEventCount)
    return this.adopt(new SqliteSessionHandle(this.database, stored, inheritedEventCount, 'write', token, this))
  }

  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    if (access !== 'read' && access !== 'write') throw new TypeError('Session access must be read or write')
    const { header, inheritedEventCount, token } = this.database.open(id, access === 'write')
    return this.adopt(new SqliteSessionHandle(this.database, header, inheritedEventCount, access, token, this))
  }

  async stat(id: SessionId, options?: SessionPersistenceStatOptions) {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    return this.database.stat(id)
  }

  async list(options?: SessionPersistenceListOptions) {
    this.assertOpen()
    options?.signal?.throwIfAborted()
    return this.database.list()
  }

  async flush(): Promise<void> {
    this.assertOpen()
    const results = await Promise.allSettled([...this.writers.values()].map(handle => handle.flush()))
    const failures = results.filter(result => result.status === 'rejected' && !(result.reason instanceof SessionHandleClosedError))
      .map(result => (result as PromiseRejectedResult).reason)
    if (failures.length) throw new AggregateError(failures, 'SQLite session flush failed')
  }

  private adopt(handle: SqliteSessionHandle): SessionHandle {
    this.handles.add(handle)
    if (handle.access === 'write') this.writers.set(handle.id, handle)
    return handle
  }

  release(handle: SqliteSessionHandle): void {
    this.handles.delete(handle)
    if (this.writers.get(handle.id) === handle) this.writers.delete(handle.id)
  }

  reportFailure(id: SessionId, error: unknown): void {
    this.ctx.logger.warn(`SQLite persistence for session "${id}" failed: ${String(error)}`)
  }

  private dispose(): Promise<void> {
    return this.closing ??= (async () => {
      clearInterval(this.heartbeat)
      try {
        const results = await Promise.allSettled([...this.handles].map(handle => handle.close()))
        const failures = results.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason)
        if (failures.length) throw new AggregateError(failures, 'SQLite session disposal failed')
      } finally {
        this.database.close()
      }
    })()
  }
}

/** Database operations are synchronous, so each call finishes before another can interleave. */
class SqliteSessionHandle implements SessionHandle {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly access: SessionAccess
  private readonly database: SqliteSessionDatabase
  private readonly token: string | undefined
  private readonly owner: SqliteSessionPersistence
  private buffered: SessionEvent[] = []
  private timer?: NodeJS.Timeout
  private closed = false
  private closing?: Promise<void>
  private lost?: SessionOwnershipLostError
  private observedLength = 0

  constructor(
    database: SqliteSessionDatabase,
    header: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    access: SessionAccess,
    token: string | undefined,
    owner: SqliteSessionPersistence,
  ) {
    this.id = header.id
    this.database = database
    this.header = header
    this.inheritedEventCount = inheritedEventCount
    this.access = access
    this.token = token
    this.owner = owner
  }

  private assertOpen(operation: string): void {
    if (this.closed) throw new SessionHandleClosedError(this.id, operation)
  }

  private assertWrite(operation: string): string {
    if (this.access !== 'write' || !this.token) throw new SessionReadOnlyError(this.id, operation)
    if (this.lost) throw this.lost
    return this.token
  }

  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    this.assertOpen('read')
    options?.signal?.throwIfAborted()
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
      throw new TypeError('Session read offset and length must be non-negative safe integers')
    }
    const { events } = this.database.read(this.id)
    if (events.length < this.observedLength) throw new Error(`Session "${this.id}" log shrank`)
    this.observedLength = events.length
    return { eventState: 'shared-frozen', events: events.slice(offset, offset + length) }
  }

  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.assertOpen('append')
    options?.signal?.throwIfAborted()
    const token = this.assertWrite('append')
    const batch = materializeAppendBatch(events)
    this.drainLive()
    this.database.append(this.id, token, batch)
  }

  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.assertOpen('flush')
    options?.signal?.throwIfAborted()
    const token = this.assertWrite('flush')
    this.drainLive()
    // Commits use synchronous=FULL; an empty session was committed by create.
    this.database.renewWriter(this.id, token)
  }

  enqueueLive(event: SessionEvent): void {
    if (this.closed) return
    this.buffered.push(...materializeAppendBatch([event]))
    if (!this.timer && !this.lost) {
      this.timer = setTimeout(() => {
        try {
          this.drainLive()
        } catch (error) {
          this.owner.reportFailure(this.id, error)
        }
      }, 200)
      this.timer.unref()
    }
  }

  private drainLive(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.buffered.length) return
    this.database.append(this.id, this.assertWrite('append'), this.buffered)
    // On failure the complete batch remains available for a later flush.
    this.buffered = []
  }

  renewLease(): void {
    if (this.closed || this.lost || !this.token) return
    try {
      this.database.renewWriter(this.id, this.token)
    } catch (error) {
      // A failed renewal permanently fences this handle; it never reclaims ownership.
      this.lost = new SessionOwnershipLostError(this.id)
      this.owner.reportFailure(this.id, error)
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = (async () => {
      clearTimeout(this.timer)
      try {
        if (this.access === 'write') this.drainLive()
      } finally {
        try {
          if (this.token) this.database.releaseWriter(this.id, this.token)
        } finally {
          this.owner.release(this)
        }
      }
    })()
    return this.closing
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}
