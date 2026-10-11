/** Run admission and result commits; database ownership stays in main.ts. */
import { randomUUID } from 'node:crypto'
import type { DatabaseAccess, EntityManager } from '@ghost/database-client'
import { ConversationRepository, MessageRepository, RunRepository, RunOwnershipLostError } from '@ghost/database'
import { isTerminalRun, reduceRunEvent, type RunEventPayload, type RunView } from '@ghost/contracts'
import type { AgentExecutor } from './runtime/events.ts'
import { RunProjection } from './run-projection.ts'

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
    const projection = new RunProjection(runId)
    let buffered: { event: RunEventPayload; time: number }[] = []
    let outstanding = 0
    let pending = Promise.resolve()
    let persistenceFailed = false
    let finishing = false
    const flush = () => {
      timer = undefined
      if (!buffered.length) return
      const batch = buffered
      buffered = []
      const snapshot = projection.view
      pending = pending.then(() => this.commit(runId, token, snapshot, batch)).finally(() => { outstanding -= batch.length })
        .catch(error => { persistenceFailed = true; throw error })
      // Keep the rejection observable to the final drain; stop model work promptly.
      void pending.catch(error => controller.abort(error))
    }
    const enqueue = (event: RunEventPayload) => {
      const previous = buffered.at(-1)
      if (event.type === 'assistant.delta' && previous?.event.type === 'assistant.delta'
        && previous.event.messageId === event.messageId && previous.event.index === event.index && previous.event.kind === event.kind) {
        previous.event = { ...event, text: previous.event.text + event.text }
      } else {
        buffered.push({ event, time: Date.now() })
        outstanding++
      }
      if (outstanding > 4096) { controller.abort(new Error('Run event persistence cannot keep up')); return }
      timer ??= setTimeout(flush, 100)
    }
    try {
      const started: RunEventPayload = { type: 'run.started' }
      projection.apply(started)
      enqueue(started)
      await this.executor.execute({ id: runId, sessionId: admission.runtime_session_id, input: admission.input }, executionSignal, event => {
        if (executionSignal.aborted || finishing) return
        try { for (const value of projection.accept(event)) enqueue(value) }
        catch (error) { controller.abort(error) }
      })
      finishing = true
      clearTimeout(timer)
      await pending
      executionSignal.throwIfAborted()
      const event: RunEventPayload = { type: 'run.completed' }
      projection.apply(event)
      buffered.push({ event, time: Date.now() })
      await this.commit(runId, token, projection.view, buffered)
    } catch (error) {
      finishing = true
      clearTimeout(timer)
      await pending.catch(() => {})
      console.error(`[AgentRun] ${runId}:`, error)
      const event: RunEventPayload = { type: 'run.failed', error: executionSignal.aborted ? '生成已中断' : '生成失败，请重试' }
      // Failed DB batches have no replay entries. Settle from the authoritative saved view instead.
      if (persistenceFailed) {
        const row = await this.db.read(manager => new RunRepository(manager).getExecution(runId))
        if (!row) throw new RunOwnershipLostError(`Run ${runId} disappeared`)
        projection.view = { status: row.status, text: row.text, error: row.error, parts: JSON.parse(row.parts ?? '[]') }
        buffered = []
      }
      buffered = buffered.filter(value => value.event.type !== 'run.completed')
      if (!persistenceFailed) {
        const row = await this.db.read(manager => new RunRepository(manager).getExecution(runId))
        if (!row) throw new RunOwnershipLostError(`Run ${runId} disappeared`)
        projection.view = buffered.reduce((view, value) => reduceRunEvent(view, value.event), {
          status: row.status, text: row.text, error: row.error, parts: JSON.parse(row.parts ?? '[]'),
        } as RunView)
      }
      projection.apply(event)
      buffered.push({ event, time: Date.now() })
      try { await this.commit(runId, token, projection.view, buffered) }
      catch (failure) { if (!(failure instanceof RunOwnershipLostError)) throw failure }
    } finally { clearTimeout(timer) }
    return 'done'
  }

  private commit(id: string, token: string, view: RunView, events: { event: RunEventPayload; time: number }[]): Promise<void> {
    return this.db.transaction(async manager => {
      const runs = new RunRepository(manager)
      const run = await runs.getExecution(id)
      if (!run) throw new RunOwnershipLostError(`Run ${id} disappeared`)
      await new ConversationRepository(manager).lock(run.conversation_id)
      await runs.updateOwned(id, token, view.status, view.text, view.error, view, events)
      await new MessageRepository(manager).updateReply(id, view.text, view.error)
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
