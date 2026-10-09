/** Application transactions are independent of Redis and Agent runtime. */
import { randomUUID } from 'node:crypto'
import type { DatabaseAccess } from '@ghost/database-client'
import { ConversationRepository, MessageRepository, RunRepository, OutboxRepository } from '@ghost/database'
import type { Conversation, MessageResponse } from '@ghost/contracts'
export class SubmissionConflictError extends Error {}
export class ChatService {
  private readonly db: DatabaseAccess
  constructor(db: DatabaseAccess) { this.db = db }
  submit(userId: string, logicalId: string, content: string, requestId: string): Promise<MessageResponse> {
    return this.db.transaction(async manager => {
      const conversations = new ConversationRepository(manager)
      const runs = new RunRepository(manager)
      const conversation = await conversations.ensure(userId, logicalId)
      const existing = await runs.findByRequest(conversation.id, requestId)
      if (existing) {
        if (existing.input !== content) throw new SubmissionConflictError('requestId already used with different content')
        return { conversationId: logicalId, runId: existing.id, accepted: false }
      }
      const id = randomUUID()
      const now = Date.now()
      const sequence = await conversations.nextSequence(conversation.id)
      await runs.create(id, conversation.id, requestId, content, sequence, now)
      await new MessageRepository(manager).appendTurn(conversation.id, id, content, sequence, now)
      await new OutboxRepository(manager).add(id)
      await conversations.touch(conversation.id, now)
      return { conversationId: logicalId, runId: id, accepted: true }
    })
  }
  getConversation(userId: string, logicalId: string): Promise<Conversation> {
    return this.db.read(async manager => {
      const row = await new ConversationRepository(manager).find(userId, logicalId)
      return { id: logicalId, title: logicalId, createdAt: row?.created_at ?? Date.now(), updatedAt: row?.updated_at ?? Date.now(),
        messages: row ? await new MessageRepository(manager).list(row.id) : [], activeRunIds: row ? await new RunRepository(manager).activeIds(row.id) : [] }
    })
  }
  getRun(userId: string, logicalId: string, runId: string) {
    return this.db.read(manager => new RunRepository(manager).getSnapshot(userId, logicalId, runId))
  }
}
