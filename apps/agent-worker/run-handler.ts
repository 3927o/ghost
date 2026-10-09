/** Run admission and result commits; database ownership stays in main.ts. */
import { randomUUID } from 'node:crypto'
import type { DatabaseAccess, EntityManager } from '@ghost/database-client'
import { ConversationRepository, MessageRepository, RunRepository, RunOwnershipLostError } from '@ghost/database'
import type { AgentExecutor, RunStatus } from '@ghost/contracts'
import { isTerminalRun } from '@ghost/contracts'

export class AgentRunHandler {
  private readonly db: DatabaseAccess
  private readonly executor: AgentExecutor
  constructor(db: DatabaseAccess, executor: AgentExecutor) { this.db = db; this.executor = executor }

  async execute(runId: string, signal: AbortSignal): Promise<'done' | 'defer'> {
    signal.throwIfAborted()
    const token = randomUUID()
    const admission = await this.db.transaction(async manager => {
      const runs = new RunRepository(manager)
      const candidate = await runs.getExecution(runId)
      if (!candidate) return 'done' as const
      await new ConversationRepository(manager).lock(candidate.conversation_id)
      const run = (await runs.getExecution(runId))!
      if (isTerminalRun(run.status)) return 'done' as const
      if (run.status === 'running') {
        await this.reject(manager, runId, '执行已中断，请重新发送消息')
        return 'done' as const
      }
      if (await runs.hasEarlierRun(runId)) return 'defer' as const
      await runs.start(runId, token)
      return run
    })
    if (typeof admission === 'string') return admission
    const controller = new AbortController()
    const executionSignal = AbortSignal.any([signal, controller.signal])
    let timer: NodeJS.Timeout | undefined
    let text = ''
    let pending = Promise.resolve()
    let finishing = false
    const flush = () => {
      timer = undefined
      const snapshot = text
      pending = pending.then(() => this.commit(runId, token, 'running', snapshot, null))
      // Keep the rejection observable to the final drain; stop model work promptly.
      void pending.catch(error => controller.abort(error))
    }
    try {
      const result = await this.executor.execute({ id: runId, sessionId: admission.runtime_session_id, input: admission.input }, executionSignal, value => {
        if (executionSignal.aborted || finishing) return
        text = value
        timer ??= setTimeout(flush, 100)
      })
      finishing = true
      clearTimeout(timer)
      await pending
      executionSignal.throwIfAborted()
      await this.commit(runId, token, 'completed', result, null)
    } catch (error) {
      finishing = true
      clearTimeout(timer)
      await pending.catch(() => {})
      console.error(`[AgentRun] ${runId}:`, error)
      try { await this.commit(runId, token, 'failed', text, executionSignal.aborted ? '生成已中断' : '生成失败，请重试') }
      catch (failure) { if (!(failure instanceof RunOwnershipLostError)) throw failure }
    } finally { clearTimeout(timer) }
    return 'done'
  }

  private commit(id: string, token: string, status: RunStatus, text: string, error: string | null): Promise<void> {
    return this.db.transaction(async manager => {
      const runs = new RunRepository(manager)
      const run = await runs.getExecution(id)
      if (!run) throw new RunOwnershipLostError(`Run ${id} disappeared`)
      await new ConversationRepository(manager).lock(run.conversation_id)
      await runs.updateOwned(id, token, status, text, error)
      await new MessageRepository(manager).updateReply(id, text, error)
      await new ConversationRepository(manager).touch(run.conversation_id)
    })
  }
  private async reject(manager: EntityManager, id: string, error: string): Promise<void> {
    const runs = new RunRepository(manager)
    const run = await runs.getExecution(id)
    if (!run || isTerminalRun(run.status)) return
    await runs.failUnfinished(id, error)
    await new MessageRepository(manager).updateReply(id, run.text, error)
    await new ConversationRepository(manager).touch(run.conversation_id)
  }
  async deliveryFailed(id: string, error: Error): Promise<void> {
    console.error(`[AgentRun] Delivery failed for ${id}:`, error)
    await this.db.transaction(async manager => {
      const run = await new RunRepository(manager).getExecution(id)
      if (!run) return
      await new ConversationRepository(manager).lock(run.conversation_id)
      await this.reject(manager, id, '任务投递失败，请重试')
    })
  }
}
