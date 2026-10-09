/** Chat use cases coordinate repositories in one transaction, independent of Redis availability. */
import { randomUUID } from 'node:crypto'
import { Database, ConversationRepository, MessageRepository, RunRepository, OutboxRepository } from '@ghost/database'
import type { Conversation, MessageResponse } from '@ghost/contracts'

export class SubmissionConflictError extends Error {}

export class ChatService {
  private readonly db: Database
  private readonly conversations: ConversationRepository
  private readonly messages: MessageRepository
  private readonly runs: RunRepository
  private readonly outbox: OutboxRepository

  constructor(db: Database) {
    this.db = db
    this.conversations = new ConversationRepository(db)
    this.messages = new MessageRepository(db)
    this.runs = new RunRepository(db)
    this.outbox = new OutboxRepository(db)
  }

  submit(userId: string, logicalId: string, content: string, requestId: string): MessageResponse {
    return this.db.transaction(() => {
      const conversation = this.conversations.ensure(userId, logicalId)
      const existing = this.runs.findByRequest(conversation.id, requestId)
      if (existing) {
        if (existing.input !== content) throw new SubmissionConflictError('requestId already used with different content')
        return { conversationId: logicalId, runId: existing.id, accepted: false }
      }
      const id = randomUUID()
      const now = Date.now()
      this.runs.create(id, conversation.id, requestId, content, now)
      this.messages.appendTurn(conversation.id, id, content, now)
      this.outbox.add(id)
      this.conversations.touch(conversation.id, now)
      return { conversationId: logicalId, runId: id, accepted: true }
    })
  }

  getConversation(userId: string, logicalId: string): Conversation {
    return this.db.transaction(() => {
      const row = this.conversations.find(userId, logicalId)
      return {
        id: logicalId, title: logicalId,
        createdAt: row?.created_at ?? Date.now(), updatedAt: row?.updated_at ?? Date.now(),
        messages: row ? this.messages.list(row.id) : [], activeRunIds: row ? this.runs.activeIds(row.id) : [],
      }
    }, false)
  }

  getRun(userId: string, logicalId: string, runId: string) {
    return this.runs.getSnapshot(userId, logicalId, runId)
  }
}
