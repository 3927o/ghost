import { In, LessThan, MoreThan } from 'typeorm'
import type { EntityManager } from '@ghost/database-client'
import { reduceRunEvent, type RunSnapshot, type RunStatus, type RunView, type RunEvent, type RunEventPayload } from '@ghost/contracts'
import { ConversationEntity, RunEntity, RunEventEntity, type RunRow } from './entities.ts'
export class RunOwnershipLostError extends Error {}
export interface RunRecord extends RunRow { runtime_session_id: string }
export class RunRepository {
  private readonly manager: EntityManager
  constructor(manager: EntityManager) { this.manager = manager }
  findByRequest(conversationId: string, requestId: string) { return this.manager.getRepository(RunEntity).findOneBy({ conversation_id: conversationId, request_id: requestId }) }
  async create(id: string, conversationId: string, requestId: string, input: string, sequence: number, time: number): Promise<void> {
    await this.manager.getRepository(RunEntity).insert({ id, conversation_id: conversationId, request_id: requestId, input, sequence,
      status: 'queued', text: '', error: null, revision: 0, parts: null, event_sequence: 0, owner_token: null, active_conversation: null, created_at: time, updated_at: time })
  }
  async activeIds(conversationId: string): Promise<string[]> {
    return (await this.manager.getRepository(RunEntity).find({ where: { conversation_id: conversationId, status: In(['queued', 'running']) }, order: { sequence: 'ASC' } })).map(row => row.id)
  }
  async getSnapshot(userId: string, logicalId: string, runId: string): Promise<RunSnapshot | undefined> {
    const conversation = await this.manager.getRepository(ConversationEntity).findOneBy({ user_id: userId, logical_id: logicalId })
    if (!conversation) return undefined
    const row = await this.manager.getRepository(RunEntity).findOneBy({ id: runId, conversation_id: conversation.id })
    return row ? { id: row.id, conversationId: logicalId, assistantMessageId: `assistant-${row.id}`, status: row.status, text: row.text,
      error: row.error, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
      parts: JSON.parse(row.parts ?? '[]'), lastEventSeq: row.event_sequence } : undefined
  }
  /** Authorization and replay metadata without reading large text/presentation snapshots on every poll. */
  async observe(userId: string, logicalId: string, runId: string, after: number) {
    const run = await this.manager.getRepository(RunEntity).createQueryBuilder('run')
      .innerJoin('Conversation', 'conversation', 'conversation.id = run.conversation_id')
      .select(['run.id', 'run.status', 'run.event_sequence'])
      .where('run.id = :runId AND conversation.user_id = :userId AND conversation.logical_id = :logicalId', { runId, userId, logicalId }).getOne()
    if (!run) return undefined
    const rows = after < run.event_sequence ? await this.manager.getRepository(RunEventEntity).find({
      where: { run_id: runId, sequence: MoreThan(after) }, order: { sequence: 'ASC' }, take: 200,
    }) : []
    const events: RunEvent[] = rows.map(row => ({ type: 'event', runId, sequence: row.sequence, time: row.time, event: JSON.parse(row.event) }))
    return { status: run.status, lastEventSeq: run.event_sequence, events }
  }
  async getExecution(id: string): Promise<RunRecord | undefined> {
    const row = await this.manager.getRepository(RunEntity).findOneBy({ id })
    if (!row) return undefined
    const conversation = await this.manager.getRepository(ConversationEntity).findOneByOrFail({ id: row.conversation_id })
    return { ...row, runtime_session_id: conversation.runtime_session_id }
  }
  async hasEarlierRun(id: string): Promise<boolean> {
    const target = await this.manager.getRepository(RunEntity).findOneByOrFail({ id })
    return this.manager.getRepository(RunEntity).existsBy({ conversation_id: target.conversation_id, sequence: LessThan(target.sequence), status: In(['queued', 'running']) })
  }
  async start(id: string, token: string): Promise<void> {
    const row = await this.manager.getRepository(RunEntity).findOneByOrFail({ id })
    const result = await this.manager.getRepository(RunEntity).update({ id, status: 'queued' }, {
      status: 'running', owner_token: token, active_conversation: row.conversation_id, revision: () => 'revision + 1', updated_at: Date.now(),
    })
    if (result.affected !== 1) throw new RunOwnershipLostError(`Run ${id} has already started`)
  }
  async updateOwned(id: string, token: string, status: RunStatus, text: string, error: string | null,
    view?: RunView, events: { event: RunEventPayload; time: number }[] = []): Promise<void> {
    const row = await this.manager.getRepository(RunEntity).findOneByOrFail({ id })
    const result = await this.manager.getRepository(RunEntity).update({ id, owner_token: token, status: 'running' }, {
      status, text, error, revision: () => 'revision + 1', updated_at: Date.now(), ...(status === 'running' ? {} : { active_conversation: null }),
      ...(view ? { parts: JSON.stringify(view.parts) } : {}), event_sequence: row.event_sequence + events.length,
    })
    if (result.affected !== 1) throw new RunOwnershipLostError(`Run ${id} is no longer owned by this execution`)
    if (events.length) await this.manager.getRepository(RunEventEntity).insert(events.map((value, index) => ({
      run_id: id, sequence: row.event_sequence + index + 1, event: JSON.stringify(value.event), time: value.time,
    })))
  }
  async failUnfinished(id: string, error: string): Promise<void> {
    const row = await this.manager.getRepository(RunEntity).findOneByOrFail({ id })
    if (!['queued', 'running'].includes(row.status)) return
    const event: RunEventPayload = { type: 'run.failed', error }
    const view = reduceRunEvent({ status: row.status, text: row.text, error: row.error, parts: JSON.parse(row.parts ?? '[]') }, event)
    await this.manager.getRepository(RunEntity).update({ id, status: In(['queued', 'running']) }, {
      status: 'failed', error, owner_token: null, active_conversation: null, revision: () => 'revision + 1', updated_at: Date.now(),
      parts: JSON.stringify(view.parts), event_sequence: row.event_sequence + 1,
    })
    await this.manager.getRepository(RunEventEntity).insert({ run_id: id, sequence: row.event_sequence + 1, time: Date.now(), event: JSON.stringify(event) })
  }
}
