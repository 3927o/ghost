/** Business transactions, execution admission and durable Redis publication. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createDatabase } from '@ghost/database-client'
import { businessModels, RunRepository, outboxStore, RunOwnershipLostError } from '@ghost/database'
import { ChatService, SubmissionConflictError } from '../apps/api/chat-service.ts'
import { OutboxDispatcher } from '../apps/api/outbox-dispatcher.ts'
import { AgentRunHandler } from '../apps/agent-worker/run-handler.ts'
import { createServer } from '../apps/api/server.ts'
import { startText, deltaText, finishText } from './fixtures/agent-events.ts'

async function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'ghost-store-'))
  const config = { type: 'sqlite' as const, path: join(directory, 'ghost.sqlite') }
  const db = await createDatabase(config, businessModels(config))
  t.after(async () => { await db.close(); rmSync(directory, { recursive: true, force: true }) })
  return { db, chat: new ChatService(db), runs: { updateOwned: (...args: Parameters<RunRepository['updateOwned']>) => db.transaction(manager => new RunRepository(manager).updateOwned(...args)) }, outbox: outboxStore(db) }
}

test('submission is atomic and idempotent; outbox failure rolls back messages and run', async t => {
  const { db, chat, outbox } = await fixture(t)
  const first = await chat.submit('owner', 'main', 'first', 'request-1')
  assert.deepEqual(await chat.submit('owner', 'main', 'first', 'request-1'), { ...first, accepted: false })
  await assert.rejects(() => chat.submit('owner', 'main', 'different', 'request-1'), SubmissionConflictError)
  assert.deepEqual(await outbox.pending(), [first.runId])
  assert.equal((await chat.getConversation('owner', 'main')).messages.length, 2)
  await db.transaction(manager => manager.query("CREATE TRIGGER reject_outbox BEFORE INSERT ON run_outbox BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END;"))
  await assert.rejects(() => chat.submit('another-user', 'main', 'new', 'new'), /outbox unavailable/)
  assert.equal((await chat.getConversation('another-user', 'main')).messages.length, 0)
  assert.deepEqual(await outbox.pending(), [first.runId])
})

test('same-conversation execution is ordered; terminal redelivery cannot repeat model work', async t => {
  const { db, chat, runs } = await fixture(t)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const handler = new AgentRunHandler(db, { async execute(run, _signal, onEvent) {
    calls++
    startText(onEvent)
    deltaText(onEvent, 'partial')
    if (run.input === 'first') await gate
    finishText(onEvent, `answer:${run.input}`)
  } })
  const first = (await chat.submit('owner', 'main', 'first', 'first')).runId
  const second = (await chat.submit('owner', 'main', 'second', 'second')).runId
  const other = (await chat.submit('other', 'main', 'other', 'other')).runId
  const signal = new AbortController().signal
  const pending = handler.execute(first, signal)
  assert.equal(await handler.execute(second, signal), 'defer')
  assert.equal(await handler.execute(other, signal), 'done')
  assert.equal(await chat.getRun('other', 'main', first), undefined)
  await assert.rejects(() => runs.updateOwned(first, 'wrong-owner', 'completed', 'bad', null), RunOwnershipLostError)
  await delay(150)
  assert.equal((await chat.getConversation('owner', 'main')).messages[1].content, 'partial')
  release()
  await pending
  await handler.execute(second, signal)
  await handler.execute(first, signal)
  assert.equal(calls, 3)
  assert.equal((await chat.getRun('owner', 'main', first))!.status, 'completed')
})

test('outbox retries a failed send and an ambiguous Redis acknowledgement with the same run ID', async t => {
  const { chat, outbox } = await fixture(t)
  const id = (await chat.submit('owner', 'main', 'hello', 'id')).runId
  const delivered = new Set<string>()
  let attempts = 0
  const dispatcher = new OutboxDispatcher(outbox, { async publish(runId) {
    attempts++
    delivered.add(runId)
    if (attempts === 1) throw new Error('Connection lost after Redis accepted the job')
  } }, () => {})
  await dispatcher.flush()
  assert.deepEqual(await outbox.pending(), [id])
  await dispatcher.flush()
  assert.deepEqual(await outbox.pending(), [])
  assert.equal(delivered.size, 1)
  assert.equal(attempts, 2)
  await dispatcher.stop()
})

test('API accepts and reads commands without any executor or model configuration', async t => {
  const { db, chat } = await fixture(t)
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
    assert.deepEqual(await outboxStore(db).pending(), [runId])
    assert.equal((await server.inject(`/api/runs/${runId}?userId=someone-else&channel=main`)).statusCode, 404)
    assert.equal((await server.inject(`/api/runs/${runId}/events?userId=someone-else&channel=main`)).statusCode, 404)
  } finally { await server.close() }
})
