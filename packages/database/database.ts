/** SQLite connection and synchronous transaction boundary, with no business operations. */
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export class Database {
  readonly sql: DatabaseSync

  constructor(path: string) {
    const absolute = resolve(path)
    mkdirSync(dirname(absolute), { recursive: true })
    this.sql = new DatabaseSync(absolute, { timeout: 5_000 })
    try {
      this.sql.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      this.transaction(() => this.sql.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')))
    } catch (error) {
      this.sql.close()
      throw error
    }
  }

  transaction<T>(operation: () => T, write = true): T {
    this.sql.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN')
    try {
      const result = operation()
      this.sql.exec('COMMIT')
      return result
    } catch (error) {
      if (this.sql.isTransaction) this.sql.exec('ROLLBACK')
      throw error
    }
  }

  close(): void { this.sql.close() }
}
