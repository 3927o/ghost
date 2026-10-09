/** Business transactions, execution admission and durable Redis publication. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Database, RunRepository, OutboxRepository, RunOwnershipLostError } from '@ghost/database'
import { ChatService, SubmissionConflictError } from '../apps/api/chat-service.ts'
import { OutboxDispatcher } from '../apps/api/outbox-dispatcher.ts'
import { AgentRunHandler } from '../apps/agent-worker/run-handler.ts'
import { createServer } from '../apps/api/server.ts'

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'ghost-store-'))
  const db = new Database(join(directory, 'ghost.sqlite'))
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
  return { db, chat: new ChatService(db), runs: new RunRepository(db), outbox: new OutboxRepository(db) }
}

test('submission is atomic and idempotent; outbox failure rolls back messages and run', t => {
  const { db, chat, outbox } = fixture(t)
  const first = chat.submit('owner', 'main', 'first', 'request-1')
  assert.deepEqual(chat.submit('owner', 'main', 'first', 'request-1'), { ...first, accepted: false })
  assert.throws(() => chat.submit('owner', 'main', 'different', 'request-1'), SubmissionConflictError)
  assert.deepEqual(outbox.pending(), [first.runId])
  assert.equal(chat.getConversation('owner', 'main').messages.length, 2)
  db.sql.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON run_outbox BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END;")
  assert.throws(() => chat.submit('another-user', 'main', 'new', 'new'), /outbox unavailable/)
  assert.equal(chat.getConversation('another-user', 'main').messages.length, 0)
  assert.deepEqual(outbox.pending(), [first.runId])
})

test('same-conversation execution is ordered; terminal redelivery cannot repeat model work', async t => {
  const { db, chat, runs } = fixture(t)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const handler = new AgentRunHandler(db, { async execute(run, _signal, onText) {
    calls++
    onText('partial')
    if (run.input === 'first') await gate
    return `answer:${run.input}`
  } })
  const first = chat.submit('owner', 'main', 'first', 'first').runId
  const second = chat.submit('owner', 'main', 'second', 'second').runId
  const other = chat.submit('other', 'main', 'other', 'other').runId
  const signal = new AbortController().signal
  const pending = handler.execute(first, signal)
  assert.equal(await handler.execute(second, signal), 'defer')
  assert.equal(await handler.execute(other, signal), 'done')
  assert.equal(chat.getRun('other', 'main', first), undefined)
  assert.throws(() => runs.updateOwned(first, 'wrong-owner', 'completed', 'bad', null), RunOwnershipLostError)
  await delay(150)
  assert.equal(chat.getConversation('owner', 'main').messages[1].content, 'partial')
  release()
  await pending
  await handler.execute(second, signal)
  await handler.execute(first, signal)
  assert.equal(calls, 3)
  assert.equal(chat.getRun('owner', 'main', first)!.status, 'completed')
})

test('outbox retries a failed send and an ambiguous Redis acknowledgement with the same run ID', async t => {
  const { chat, outbox } = fixture(t)
  const id = chat.submit('owner', 'main', 'hello', 'id').runId
  const delivered = new Set<string>()
  let attempts = 0
  const dispatcher = new OutboxDispatcher(outbox, { async publish(runId) {
    attempts++
    delivered.add(runId)
    if (attempts === 1) throw new Error('Connection lost after Redis accepted the job')
  } }, () => {})
  await dispatcher.flush()
  assert.deepEqual(outbox.pending(), [id])
  await dispatcher.flush()
  assert.deepEqual(outbox.pending(), [])
  assert.equal(delivered.size, 1)
  assert.equal(attempts, 2)
  await dispatcher.stop()
})

test('API accepts and reads commands without any executor or model configuration', async t => {
  const { db, chat } = fixture(t)
  const server = await createServer({ chat, logger: false })
  // Server owns no database resources; close before fixture teardown.
  const body = { userId: 'owner', channel: 'main', content: 'hello', requestId: 'retry-key' }
  try {
    const response = await server.inject({ method: 'POST', url: '/api/message', payload: body })
    assert.equal(response.statusCode, 202)
    const { runId } = response.json()
    assert.equal((await server.inject({ method: 'POST', url: '/api/message', payload: body })).json().runId, runId)
    assert.equal((await server.inject({ method: 'POST', url: '/api/message', payload: { ...body, content: 'changed' } })).statusCode, 409)
    const history = await server.inject('/api/conversation?userId=owner&channel=main')
    assert.equal(history.json().messages.length, 2)
    assert.deepEqual(history.json().activeRunIds, [runId])
    assert.deepEqual(new OutboxRepository(db).pending(), [runId])
    assert.equal((await server.inject(`/api/runs/${runId}?userId=someone-else&channel=main`)).statusCode, 404)
    assert.equal((await server.inject(`/api/runs/${runId}/events?userId=someone-else&channel=main`)).statusCode, 404)
  } finally { await server.close() }
})
