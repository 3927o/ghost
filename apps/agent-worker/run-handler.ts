/** Run admission and result commits. A redelivered running task is interrupted, never re-executed. */
import { randomUUID } from 'node:crypto'
import { Database, ConversationRepository, MessageRepository, RunRepository, RunOwnershipLostError } from '@ghost/database'
import type { AgentExecutor, RunStatus } from '@ghost/contracts'
import { isTerminalRun } from '@ghost/contracts'

export class AgentRunHandler {
  private readonly db: Database
  private readonly executor: AgentExecutor
  private readonly conversations: ConversationRepository
  private readonly messages: MessageRepository
  private readonly runs: RunRepository

  constructor(db: Database, executor: AgentExecutor) {
    this.db = db
    this.executor = executor
    this.conversations = new ConversationRepository(db)
    this.messages = new MessageRepository(db)
    this.runs = new RunRepository(db)
  }

  async execute(runId: string, signal: AbortSignal): Promise<'done' | 'defer'> {
    signal.throwIfAborted()
    const token = randomUUID()
    const admission = this.db.transaction(() => {
      const run = this.runs.getExecution(runId)
      if (!run || isTerminalRun(run.status)) return 'done' as const
      if (run.status === 'running') {
        this.reject(runId, '执行已中断，请重新发送消息')
        return 'done' as const
      }
      if (this.runs.hasEarlierRun(runId)) return 'defer' as const
      this.runs.start(runId, token)
      return run
    })
    if (typeof admission === 'string') return admission
    const controller = new AbortController()
    const executionSignal = AbortSignal.any([signal, controller.signal])
    let timer: NodeJS.Timeout | undefined
    let text = ''
    const flush = () => {
      timer = undefined
      try { this.commit(runId, token, 'running', text, null) } catch (error) { controller.abort(error) }
    }
    try {
      const result = await this.executor.execute({ id: runId, sessionId: admission.runtime_session_id, input: admission.input }, executionSignal, value => {
        if (executionSignal.aborted) return
        text = value
        timer ??= setTimeout(flush, 100)
      })
      executionSignal.throwIfAborted()
      this.commit(runId, token, 'completed', result, null)
    } catch (error) {
      console.error(`[AgentRun] ${runId}:`, error)
      try {
        this.commit(runId, token, 'failed', text, executionSignal.aborted ? '生成已中断' : '生成失败，请重试')
      } catch (failure) {
        if (!(failure instanceof RunOwnershipLostError)) throw failure
      }
    } finally {
      clearTimeout(timer)
    }
    return 'done'
  }

  private commit(id: string, token: string, status: RunStatus, text: string, error: string | null): void {
    this.db.transaction(() => {
      this.runs.updateOwned(id, token, status, text, error)
      this.messages.updateReply(id, text, error)
      this.conversations.touch(this.runs.getExecution(id)!.conversation_id)
    })
  }

  /** Called inside a transaction after queue delivery supersedes the previous attempt. */
  private reject(id: string, error: string): void {
    const run = this.runs.getExecution(id)
    if (!run || isTerminalRun(run.status)) return
    this.runs.failUnfinished(id, error)
    this.messages.updateReply(id, run.text, error)
    this.conversations.touch(run.conversation_id)
  }

  deliveryFailed(id: string, error: Error): void {
    console.error(`[AgentRun] Delivery failed for ${id}:`, error)
    this.db.transaction(() => this.reject(id, '任务投递失败，请重试'))
  }
}
