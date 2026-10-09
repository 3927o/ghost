import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  SessionHandleClosedError, SessionPersistence,
  type SessionAccess, type SessionHandle,
  type SessionPersistenceCreateOptions, type SessionPersistenceOpenOptions,
  type SessionPersistenceStatOptions, type SessionPersistenceListOptions,
} from '@deepseek-ai/dsh-session-persistence'
import '../database-provider/index.ts'
import { SessionStore, WRITER_LEASE_MS } from './session-store.ts'
import { DatabaseSessionHandle } from './session-handle.ts'

/** DSH persistence plugin; Agent creation/resume uses this service unchanged. */
export default class DatabaseSessionPersistence extends SessionPersistence {
  static inject = ['database']
  private readonly database: SessionStore
  private readonly handles = new Set<DatabaseSessionHandle>()
  private readonly writers = new Map<SessionId, DatabaseSessionHandle>()
  private readonly heartbeat: NodeJS.Timeout
  private closing?: Promise<void>
  private readonly opening = new Set<Promise<SessionHandle>>()

  constructor(ctx: Context) {
    super(ctx)
    this.database = new SessionStore(ctx.database)
    ctx.on('session/event', (session, event) => this.writers.get(session.id)?.enqueueLive(event))
    ctx.on('session/flush', session => this.writers.get(session.id)?.flush())
    ctx.on('session/disposed', session => {
      this.writers.get(session.id)?.close().catch(error => ctx.logger.warn(`Database session close failed: ${String(error)}`))
    })
    this.heartbeat = setInterval(() => {
      for (const writer of this.writers.values()) void writer.renewLease().catch(() => {})
    }, WRITER_LEASE_MS / 3)
    this.heartbeat.unref()
    ctx.effect(() => () => this.dispose(), 'Database Session persistence')
  }

  private assertOpen(): void {
    if (this.closing) throw new Error('Database session persistence is shutting down')
  }

  private track(operation: () => Promise<SessionHandle>): Promise<SessionHandle> {
    const pending = operation()
    this.opening.add(pending)
    void pending.finally(() => this.opening.delete(pending)).catch(() => {})
    return pending
  }

  create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    return this.track(async () => {
      this.assertOpen()
      options?.signal?.throwIfAborted()
      const { header: stored, inheritedEventCount, token } = await this.database.create(header, options?.inheritedEventCount)
      return this.adopt(new DatabaseSessionHandle(this.database, stored, inheritedEventCount, 'write', token, this))
    })
  }

  open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    return this.track(async () => {
      this.assertOpen()
      options?.signal?.throwIfAborted()
      if (access !== 'read' && access !== 'write') throw new TypeError('Session access must be read or write')
      const { header, inheritedEventCount, token } = await this.database.open(id, access === 'write')
      return this.adopt(new DatabaseSessionHandle(this.database, header, inheritedEventCount, access, token, this))
    })
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
    if (failures.length) throw new AggregateError(failures, 'Database session flush failed')
  }

  private async adopt(handle: DatabaseSessionHandle): Promise<SessionHandle> {
    if (this.closing) { await handle.close(); throw new Error('Session persistence is shutting down') }
    this.handles.add(handle)
    if (handle.access === 'write') this.writers.set(handle.id, handle)
    return handle
  }

  release(handle: DatabaseSessionHandle): void {
    this.handles.delete(handle)
    if (this.writers.get(handle.id) === handle) this.writers.delete(handle.id)
  }

  reportFailure(id: SessionId, error: unknown): void {
    this.ctx.logger.warn(`Database persistence for session "${id}" failed: ${String(error)}`)
    // Stop model/tool execution as soon as persistence fails or writer ownership is lost.
    this.ctx.get('agents')?.get(id)?.cancel({ kind: 'hook', reason: 'Session persistence failed' })
  }

  private dispose(): Promise<void> {
    return this.closing ??= (async () => {
      clearInterval(this.heartbeat)
      await Promise.allSettled([...this.opening])
      const results = await Promise.allSettled([...this.handles].map(handle => handle.close()))
      const failures = results.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason)
      if (failures.length) throw new AggregateError(failures, 'Session disposal failed')
    })()
  }
}
