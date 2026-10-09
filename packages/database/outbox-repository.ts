/** Unsent run notifications, committed alongside messages and removed only after Redis acknowledges. */
import type { Database } from './database.ts'

export class OutboxRepository {
  private readonly db: Database
  constructor(db: Database) { this.db = db }

  add(runId: string): void {
    this.db.sql.prepare('INSERT INTO run_outbox (run_id) VALUES (?)').run(runId)
  }

  pending(limit = 100): string[] {
    return (this.db.sql.prepare('SELECT run_id FROM run_outbox ORDER BY rowid LIMIT ?').all(limit) as { run_id: string }[])
      .map(row => row.run_id)
  }

  acknowledge(runId: string): void {
    this.db.sql.prepare('DELETE FROM run_outbox WHERE run_id = ?').run(runId)
  }
}
