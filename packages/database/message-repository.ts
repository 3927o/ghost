/** User-visible messages; Agent framework events never enter this repository. */
import type { ChatMessage, RunStatus } from '@ghost/contracts'
import type { Database } from './database.ts'

export class MessageRepository {
  private readonly db: Database
  constructor(db: Database) { this.db = db }

  appendTurn(conversationId: string, runId: string, content: string, time: number): void {
    const insert = this.db.sql.prepare(`INSERT INTO messages (id, conversation_id, run_id, role, content, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)`)
    insert.run(`user-${runId}`, conversationId, runId, 'user', content, time)
    insert.run(`assistant-${runId}`, conversationId, runId, 'assistant', '', time)
  }

  list(conversationId: string): ChatMessage[] {
    const rows = this.db.sql.prepare(`SELECT m.*, r.status FROM messages m JOIN runs r ON r.id = m.run_id
      WHERE m.conversation_id = ? ORDER BY m.rowid`).all(conversationId) as unknown as {
        id: string; role: 'user' | 'assistant'; content: string; timestamp: number; error: number;
        run_id: string; status: RunStatus
      }[]
    return rows.map(row => ({
      id: row.id, role: row.role, content: row.content, timestamp: row.timestamp,
      error: !!row.error, runId: row.run_id,
      streaming: row.role === 'assistant' && (row.status === 'queued' || row.status === 'running'),
    }))
  }

  updateReply(runId: string, text: string, error: string | null): void {
    this.db.sql.prepare("UPDATE messages SET content = ?, error = ? WHERE run_id = ? AND role = 'assistant'")
      .run([text, error].filter(Boolean).join('\n\n'), error ? 1 : 0, runId)
  }
}
