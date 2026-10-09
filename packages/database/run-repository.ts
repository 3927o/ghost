/** Execution state and ownership checks. Redis decides which run is delivered to a Worker. */
import type { RunSnapshot, RunStatus } from '@ghost/contracts'
import type { Database } from './database.ts'

export class RunOwnershipLostError extends Error {}

export interface RunRecord {
  id: string
  conversation_id: string
  runtime_session_id: string
  input: string
  status: RunStatus
  text: string
  error: string | null
  owner_token: string | null
}

export class RunRepository {
  private readonly db: Database
  constructor(db: Database) { this.db = db }

  findByRequest(conversationId: string, requestId: string): { id: string; input: string } | undefined {
    return this.db.sql.prepare('SELECT id, input FROM runs WHERE conversation_id = ? AND request_id = ?')
      .get(conversationId, requestId) as { id: string; input: string } | undefined
  }

  create(id: string, conversationId: string, requestId: string, input: string, time: number): void {
    this.db.sql.prepare(`INSERT INTO runs (id, conversation_id, request_id, input, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run(id, conversationId, requestId, input, time, time)
  }

  activeIds(conversationId: string): string[] {
    return (this.db.sql.prepare("SELECT id FROM runs WHERE conversation_id = ? AND status IN ('queued', 'running') ORDER BY rowid")
      .all(conversationId) as { id: string }[]).map(row => row.id)
  }

  getSnapshot(userId: string, logicalId: string, runId: string): RunSnapshot | undefined {
    const row = this.db.sql.prepare(`SELECT r.*, c.logical_id FROM runs r JOIN conversations c ON c.id = r.conversation_id
      WHERE r.id = ? AND c.user_id = ? AND c.logical_id = ?`).get(runId, userId, logicalId) as
      (RunRecord & { logical_id: string; revision: number; created_at: number; updated_at: number }) | undefined
    return row && {
      id: row.id, conversationId: row.logical_id, assistantMessageId: `assistant-${row.id}`,
      status: row.status, text: row.text, error: row.error, revision: row.revision,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  }

  getExecution(id: string): RunRecord | undefined {
    return this.db.sql.prepare(`SELECT r.*, c.runtime_session_id FROM runs r JOIN conversations c ON c.id = r.conversation_id
      WHERE r.id = ?`).get(id) as RunRecord | undefined
  }

  /** Admission rule, evaluated with the start transition in one business transaction. */
  hasEarlierRun(id: string): boolean {
    return !!this.db.sql.prepare(`SELECT 1 FROM runs earlier JOIN runs target ON earlier.conversation_id = target.conversation_id
      WHERE target.id = ? AND earlier.rowid < target.rowid AND earlier.status IN ('queued', 'running') LIMIT 1`).get(id)
  }

  start(id: string, token: string): void {
    const result = this.db.sql.prepare(`UPDATE runs SET status = 'running', owner_token = ?, revision = revision + 1,
      updated_at = ? WHERE id = ? AND status = 'queued'`).run(token, Date.now(), id)
    if (result.changes !== 1) throw new RunOwnershipLostError(`Run ${id} has already started`)
  }

  updateOwned(id: string, token: string, status: RunStatus, text: string, error: string | null): void {
    const result = this.db.sql.prepare(`UPDATE runs SET status = ?, text = ?, error = ?, revision = revision + 1,
      updated_at = ? WHERE id = ? AND owner_token = ? AND status = 'running'`)
      .run(status, text, error, Date.now(), id, token)
    if (result.changes !== 1) throw new RunOwnershipLostError(`Run ${id} is no longer owned by this execution`)
  }

  failUnfinished(id: string, error: string): void {
    this.db.sql.prepare(`UPDATE runs SET status = 'failed', error = ?, owner_token = NULL,
      revision = revision + 1, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')`)
      .run(error, Date.now(), id)
  }
}
