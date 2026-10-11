import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '@ghost/database-client'
import { businessModels } from '@ghost/database'
import { ChatService } from '../apps/api/chat-service.ts'

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

test('business v1 upgrades in place and preserves existing conversations, replies and runs', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ghost-upgrade-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const config = { type: 'sqlite' as const, path: join(directory, 'ghost.sqlite') }
  const original = await createDatabase(config, businessModels(config))
  const submission = await new ChatService(original).submit('owner', 'main', 'preserved input', 'request')
  await original.close()
  const old = new DatabaseSync(config.path)
  old.exec("DROP TABLE run_events; ALTER TABLE runs DROP COLUMN parts; ALTER TABLE runs DROP COLUMN event_sequence; UPDATE ghost_schema_versions SET version = 1 WHERE name = 'business'")
  old.close()
  for (let attempt = 0; attempt < 2; attempt++) {
    const upgraded = await createDatabase(config, businessModels(config))
    try {
      const chat = new ChatService(upgraded)
      const run = (await chat.getRun('owner', 'main', submission.runId))!
      assert.equal(run.status, 'queued')
      assert.equal(run.lastEventSeq, 0)
      assert.deepEqual(run.parts, [])
      assert.equal((await chat.getConversation('owner', 'main')).messages[0].content, 'preserved input')
      assert.deepEqual((await chat.getRunEvents('owner', 'main', submission.runId, 0))!.events, [])
      assert.equal((await upgraded.read(manager => manager.query("SELECT version FROM ghost_schema_versions WHERE name = 'business'")))[0].version, 2)
    } finally { await upgraded.close() }
  }
})
