/** Business conversation identity and runtime-session mapping. */
import { randomUUID } from 'node:crypto'
import type { Database } from './database.ts'

export interface ConversationRecord {
  id: string
  logical_id: string
  runtime_session_id: string
  created_at: number
  updated_at: number
}

export class ConversationRepository {
  private readonly db: Database
  constructor(db: Database) { this.db = db }

  find(userId: string, logicalId: string): ConversationRecord | undefined {
    return this.db.sql.prepare('SELECT * FROM conversations WHERE user_id = ? AND logical_id = ?')
      .get(userId, logicalId) as ConversationRecord | undefined
  }

  ensure(userId: string, logicalId: string): ConversationRecord {
    const existing = this.find(userId, logicalId)
    if (existing) return existing
    const now = Date.now()
    this.db.sql.prepare(`INSERT INTO conversations
      (id, user_id, logical_id, runtime_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), userId, logicalId, randomUUID(), now, now)
    return this.find(userId, logicalId)!
  }

  touch(id: string, time = Date.now()): void {
    this.db.sql.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(time, id)
  }
}
