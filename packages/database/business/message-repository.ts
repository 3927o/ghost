import type { EntityManager } from '@ghost/database-client'
import type { ChatMessage } from '@ghost/contracts'
import { MessageEntity, RunEntity } from './entities.ts'
export class MessageRepository {
  private readonly manager: EntityManager
  constructor(manager: EntityManager) { this.manager = manager }
  async appendTurn(conversationId: string, runId: string, content: string, sequence: number, timestamp: number): Promise<void> {
    await this.manager.getRepository(MessageEntity).insert([
      { id: `user-${runId}`, conversation_id: conversationId, run_id: runId, sequence: sequence * 2, role: 'user', content, timestamp, error: false },
      { id: `assistant-${runId}`, conversation_id: conversationId, run_id: runId, sequence: sequence * 2 + 1, role: 'assistant', content: '', timestamp, error: false },
    ])
  }
  async list(conversationId: string): Promise<ChatMessage[]> {
    const rows = await this.manager.getRepository(MessageEntity).find({ where: { conversation_id: conversationId }, order: { sequence: 'ASC' } })
    const runs = new Map((await this.manager.getRepository(RunEntity).findBy({ conversation_id: conversationId })).map(run => [run.id, run]))
    return rows.map(row => ({ id: row.id, role: row.role, content: row.content, timestamp: row.timestamp, error: row.error, runId: row.run_id,
      streaming: row.role === 'assistant' && ['queued', 'running'].includes(runs.get(row.run_id)!.status),
      ...(row.role === 'assistant' ? { parts: JSON.parse(runs.get(row.run_id)!.parts ?? '[]'), failure: runs.get(row.run_id)!.error ?? undefined } : {}) }))
  }
  async updateReply(runId: string, text: string, error: string | null): Promise<void> {
    await this.manager.getRepository(MessageEntity).update({ run_id: runId, role: 'assistant' }, { content: [text, error].filter(Boolean).join('\n\n'), error: !!error })
  }
}
