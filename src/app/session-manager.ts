import { createHash } from 'node:crypto'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionOwnershipLostError } from '@deepseek-ai/dsh-session-persistence'
import type { AgentCore, RunTurnParams, TurnResult } from '../agent-core/index.ts'
import type { Conversation } from '../shared/types.ts'
import { conversationHistory } from './conversation-history.ts'

interface SessionEntry {
  handle: AgentHandle
  lastActivity: number
}

interface RunConversationParams extends Omit<RunTurnParams, 'agent'> {
  userId: string
  conversationId: string
}

/**
 * Application policy for conversation identity, active Agents and their lifetime.
 * Serializes work for each conversation and projects its events for the client.
 */
export class SessionManager {
  private sessions = new Map<string, SessionEntry>()
  private pending = new Map<string, Promise<unknown>>()
  private readonly core: AgentCore
  private readonly timeoutMs: number
  private readonly cleanupInterval: NodeJS.Timeout
  private disposal?: Promise<void>

  constructor(core: AgentCore, timeoutMs = 30 * 60 * 1000) {
    this.core = core
    this.timeoutMs = timeoutMs
    this.cleanupInterval = setInterval(() => {
      this.cleanup().then(count => {
        if (count > 0) console.log(`[SessionManager] Cleaned up ${count} inactive session(s)`)
      }).catch(error => console.error('[SessionManager] Session cleanup failed:', error))
    }, 5 * 60 * 1000)
  }

  private sessionId(userId: string, conversationId: string): string {
    const key = JSON.stringify([userId, conversationId])
    return `ghost-${createHash('sha256').update(key).digest('hex')}`
  }

  /** Serialize creation, turns, history reads and disposal for one conversation. */
  private runExclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    if (this.disposal) return Promise.reject(new Error('Session manager is shutting down'))
    const previous = this.pending.get(sessionId) ?? Promise.resolve()
    const task = previous.catch(() => {}).then(operation)
    this.pending.set(sessionId, task)
    return task.finally(() => {
      if (this.pending.get(sessionId) === task) this.pending.delete(sessionId)
    })
  }

  private async getOrCreateSession(sessionId: string): Promise<SessionEntry> {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const persisted = await this.core.hasSession(sessionId)
    const handle = persisted ? await this.core.resume(sessionId) : await this.core.create(sessionId)
    const entry = { handle, lastActivity: Date.now() }
    this.sessions.set(sessionId, entry)
    return entry
  }

  private async discardSession(sessionId: string, entry: SessionEntry): Promise<void> {
    try {
      await entry.handle.dispose()
    } catch (error) {
      console.error(`[SessionManager] Failed to dispose session "${sessionId}" after losing ownership:`, error)
    } finally {
      if (this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId)
    }
  }

  getConversation(userId: string, conversationId: string): Promise<Conversation> {
    const sessionId = this.sessionId(userId, conversationId)
    return this.runExclusive(sessionId, async () => {
      if (!this.sessions.has(sessionId) && !await this.core.hasSession(sessionId)) {
        return conversationHistory(conversationId, Date.now(), [])
      }

      const entry = this.sessions.get(sessionId)
      try {
        let stored
        try {
          stored = await this.core.readSession(sessionId)
        } catch (error) {
          if (!(error instanceof SessionOwnershipLostError) || !entry) throw error
          await this.discardSession(sessionId, entry)
          stored = await this.core.readSession(sessionId)
        }
        const { createdAt, events } = stored
        return conversationHistory(conversationId, createdAt, events)
      } finally {
        if (entry) entry.lastActivity = Date.now()
      }
    })
  }

  runTurn(params: RunConversationParams): Promise<TurnResult & { conversationId: string }> {
    const { userId, conversationId, ...turn } = params
    const sessionId = this.sessionId(userId, conversationId)
    return this.runExclusive(sessionId, async () => {
      const entry = await this.getOrCreateSession(sessionId)
      try {
        const result = await this.core.runTurn({ ...turn, agent: entry.handle.agent })
        return { ...result, conversationId }
      } catch (error) {
        if (error instanceof SessionOwnershipLostError) await this.discardSession(sessionId, entry)
        throw error
      } finally {
        entry.lastActivity = Date.now()
      }
    })
  }

  /** Clean up sessions inactive for longer than timeout */
  private async cleanup(): Promise<number> {
    if (this.disposal) return 0
    const now = Date.now()
    const expired = [...this.sessions.entries()].filter(([, entry]) => now - entry.lastActivity > this.timeoutMs)
    let removed = 0
    await Promise.all(expired.map(([sessionId, entry]) => this.runExclusive(sessionId, async () => {
      if (this.sessions.get(sessionId) !== entry || Date.now() - entry.lastActivity <= this.timeoutMs) return
      await entry.handle.dispose()
      this.sessions.delete(sessionId)
      removed++
    })))
    return removed
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      clearInterval(this.cleanupInterval)
      this.disposal = this.disposeSessions()
    }
    return this.disposal
  }

  private async disposeSessions(): Promise<void> {
    await Promise.allSettled([...this.pending.values()])
    const disposals = Array.from(this.sessions.values()).map(entry =>
      entry.handle.dispose().catch(err => {
        console.error(`Failed to dispose agent ${entry.handle.agent.id}:`, err)
      })
    )
    await Promise.all(disposals)
    this.sessions.clear()
  }

  getActiveSessionCount(): number {
    return this.sessions.size
  }
}
