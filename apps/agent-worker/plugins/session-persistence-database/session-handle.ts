import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  SessionHandleClosedError, SessionReadOnlyError, materializeAppendBatch,
  type SessionAccess, type SessionHandle, type SessionHandleAppendOptions, type SessionHandleFlushOptions,
  type SessionHandleReadOptions, type SessionHandleReadResult,
} from '@deepseek-ai/dsh-session-persistence'
import type DatabaseSessionPersistence from './index.ts'
import type { SessionStore } from './session-store.ts'

/** One ordered write queue per handle; the shared client never holds per-Agent state. */
export class DatabaseSessionHandle implements SessionHandle {
  readonly id: SessionId
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly access: SessionAccess
  private readonly database: SessionStore
  private readonly token: string | undefined
  private readonly owner: DatabaseSessionPersistence
  private buffered: SessionEvent[] = []
  private timer?: NodeJS.Timeout
  private closed = false
  private closing?: Promise<void>
  private failure?: unknown
  private pending = Promise.resolve()
  private observedLength = 0

  constructor(database: SessionStore, header: SessionHeader, inheritedEventCount: SessionLogOffset,
    access: SessionAccess, token: string | undefined, owner: DatabaseSessionPersistence) {
    this.id = header.id; this.database = database; this.header = header; this.inheritedEventCount = inheritedEventCount
    this.access = access; this.token = token; this.owner = owner
  }
  private assertOpen(operation: string): void { if (this.closed) throw new SessionHandleClosedError(this.id, operation) }
  private assertWrite(operation: string): string {
    if (this.access !== 'write' || !this.token) throw new SessionReadOnlyError(this.id, operation)
    if (this.failure) throw this.failure
    return this.token
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.then(() => {}, error => {
      this.failure ??= error
      this.owner.reportFailure(this.id, error)
    })
    return result
  }
  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    this.assertOpen('read')
    options?.signal?.throwIfAborted()
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new TypeError('Session read offset and length must be non-negative safe integers')
    return this.enqueue(async () => {
      if (this.access === 'write') await this.drainLive()
      const { events } = await this.database.read(this.id)
      if (events.length < this.observedLength) throw new Error(`Session "${this.id}" log shrank`)
      this.observedLength = events.length
      return { eventState: 'detached', events: events.slice(offset, offset + length) }
    })
  }
  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    this.assertOpen('append'); options?.signal?.throwIfAborted(); this.assertWrite('append')
    const batch = materializeAppendBatch(events)
    return this.enqueue(async () => { await this.drainLive(); await this.database.append(this.id, this.assertWrite('append'), batch) })
  }
  async flush(options?: SessionHandleFlushOptions): Promise<void> {
    this.assertOpen('flush'); options?.signal?.throwIfAborted(); this.assertWrite('flush')
    return this.enqueue(async () => { await this.drainLive(); await this.database.renewWriter(this.id, this.assertWrite('flush')) })
  }
  enqueueLive(event: SessionEvent): void {
    if (this.closed || this.failure) return
    this.buffered.push(...materializeAppendBatch([event]))
    if (event.type === 'user/message') {
      void this.enqueue(() => this.drainLive()).catch(() => {})
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        void this.enqueue(() => this.drainLive()).catch(() => {})
      }, 200)
      this.timer.unref()
    }
  }
  private async drainLive(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined
    if (!this.buffered.length) return
    const batch = this.buffered.splice(0)
    try { await this.database.append(this.id, this.assertWrite('append'), batch) }
    catch (error) { this.buffered.unshift(...batch); throw error }
  }
  async renewLease(): Promise<void> {
    if (this.closed || this.failure || !this.token) return
    await this.enqueue(async () => { await this.database.renewWriter(this.id, this.assertWrite('renew')) })
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true; clearTimeout(this.timer)
    return this.closing = this.enqueue(async () => {
      try { if (this.access === 'write' && !this.failure) await this.drainLive() }
      finally {
        try { if (this.token) await this.database.releaseWriter(this.id, this.token) }
        finally { this.owner.release(this) }
      }
    })
  }
  [Symbol.asyncDispose](): Promise<void> { return this.close() }
}
