import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '@ghost/database-client'
import { businessModels } from '@ghost/database'

test('incompatible SQLite layout is rejected without changing existing data', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ghost-legacy-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const config = { type: 'sqlite' as const, path: join(directory, 'legacy.sqlite') }
  const original = new DatabaseSync(config.path)
  original.exec("CREATE TABLE conversations (id TEXT PRIMARY KEY, user_id TEXT); INSERT INTO conversations VALUES ('old-id', 'owner')")
  original.close()

  await assert.rejects(() => createDatabase(config, businessModels(config)), /Legacy\/incompatible table conversations/)
  const preserved = new DatabaseSync(config.path)
  try {
    assert.equal(preserved.prepare('SELECT user_id FROM conversations WHERE id = ?').get('old-id')!.user_id, 'owner')
    assert.deepEqual(preserved.prepare('PRAGMA table_info(conversations)').all().map(column => column.name), ['id', 'user_id'])
    assert.deepEqual(preserved.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(table => table.name), ['conversations'])
  } finally { preserved.close() }
})
