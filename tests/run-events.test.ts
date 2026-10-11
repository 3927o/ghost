import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { createDatabase, type DatabaseAccess } from '@ghost/database-client'
import { businessModels } from '@ghost/database'
import { emptyRunView, reduceRunEvent, type RunStreamEvent } from '@ghost/contracts'
import { AgentRunHandler } from '../apps/agent-worker/run-handler.ts'
import { RunProjection } from '../apps/agent-worker/run-projection.ts'
import { ChatService } from '../apps/api/chat-service.ts'
import { createServer } from '../apps/api/server.ts'
import { readMessageStream } from '../apps/web/src/lib/message-stream.ts'
import { startText, deltaText, finishText, callTool, finishTool } from './fixtures/agent-events.ts'
import { LlmAttemptId, ToolCallId, createSystemMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'

async function fixture(t: { after: (fn: () => void | Promise<void>) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'ghost-events-'))
  const config = { type: 'sqlite' as const, path: join(directory, 'ghost.sqlite') }
  const db = await createDatabase(config, businessModels(config))
  t.after(async () => { await db.close(); rmSync(directory, { recursive: true, force: true }) })
  return { db, chat: new ChatService(db) }
}

test('projection retains message boundaries, tools, reasoning and attempts without exposing prompts or replay state', () => {
  const projection = new RunProjection('run')
  const events: unknown[] = []
  const emit = (input: Parameters<RunProjection['accept']>[0]) => events.push(...projection.accept(input))
  emit({ type: 'session', event: { type: 'system/message', seq: SessionSeq(0), time: 0, surfaceOp: 'append',
    data: { turn: 1, step: 1, message: createSystemMessage('private prompt') } } })
  startText(emit, 'retry')
  deltaText(emit, '未采用的文本', 'retry')
  emit({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: LlmAttemptId('retry'), revision: 1, index: 1, time: 1,
    chunk: { type: 'tool-call-delta', index: 1, id: ToolCallId('same-call'), name: 'probe', argumentsDelta: '{' } } })
  emit({ type: 'assistant-stream', frame: { type: 'end', attemptId: LlmAttemptId('retry'), revision: 1, index: 2, outcome: { kind: 'abandoned' } } })
  startText(emit, 'actual')
  emit({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: LlmAttemptId('actual'), revision: 2, index: 0, time: 1,
    chunk: { type: 'reasoning-delta', index: 0, text: '检查工具' } } })
  deltaText(emit, '先查询。', 'actual', 1)
  emit({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: LlmAttemptId('actual'), revision: 2, index: 2, time: 1,
    chunk: { type: 'tool-call-delta', index: 2, id: ToolCallId('same-call'), name: 'probe', argumentsDelta: '{"value":"OK"}' } } })
  callTool(emit, 'same-call')
  finishTool(emit, '查询成功', 'same-call')
  startText(emit, 'final', 2)
  deltaText(emit, '最终结果。', 'final')
  finishText(emit, '最终结果。', 'final', 2, { secret: 'provider-private-token' })
  assert.equal(projection.view.text, '先查询。\n\n最终结果。')
  const tools = projection.view.parts.filter(part => part.type === 'tool')
  assert.equal(tools.length, 2)
  assert.equal(tools[0].status, 'interrupted')
  assert.equal(tools[1].status, 'completed')
  assert.equal(tools[1].result, '查询成功')
  const reasoning = projection.view.parts.find(part => part.id === 'actual')!
  assert.ok(reasoning.type === 'assistant' && reasoning.blocks.some(block => block.kind === 'reasoning'))
  assert.ok(!JSON.stringify(events).includes('private prompt'))
  assert.ok(!JSON.stringify(events).includes('provider-private-token'))
  assert.equal(projection.view.parts.filter(part => part.id === 'final').length, 1)
})

test('SSE resumes after a tool call, replays only missing events, and matches stored presentation', async t => {
  const { db, chat } = await fixture(t)
  const server = await createServer({ chat, logger: false })
  await server.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  const handler = new AgentRunHandler(db, { async execute(_run, _signal, emit) {
    startText(emit, 'first')
    deltaText(emit, '先', 'first'); deltaText(emit, '查询。', 'first')
    finishText(emit, '先查询。', 'first')
    callTool(emit)
    await gate
    finishTool(emit, '工具结果')
    startText(emit, 'second', 2)
    deltaText(emit, '最终回答。', 'second')
    finishText(emit, '最终回答。', 'second', 2)
  } })
  const { runId } = await chat.submit('owner', 'main', 'test', 'request')
  const execution = handler.execute(runId, new AbortController().signal)
  let view = emptyRunView()
  let cursor = 0
  const observation = await fetch(`${base}/api/runs/${runId}/events?userId=owner&channel=main`)
  assert.match(observation.headers.get('content-type')!, /text\/event-stream/)
  await assert.rejects(() => readMessageStream(observation.body!, event => {
    if (event.type === 'snapshot') { view = event.run; cursor = event.run.lastEventSeq }
    else { view = reduceRunEvent(view, event.event); cursor = event.sequence }
    if (event.type === 'event' && event.event.type === 'tool.called') throw new Error('simulated disconnect')
  }), /simulated disconnect/)
  assert.equal(view.parts.find(part => part.type === 'tool')!.status, 'running')
  const lastSeen = cursor
  const reconnect = fetch(`${base}/api/runs/${runId}/events?userId=owner&channel=main`, { headers: { 'Last-Event-ID': String(cursor) } })
  release()
  const resumed = await reconnect
  const received: RunStreamEvent[] = []
  await readMessageStream(resumed.body!, event => {
    assert.equal(event.type, 'event')
    if (event.type === 'event') {
      assert.equal(event.sequence, ++cursor)
      view = reduceRunEvent(view, event.event)
      received.push(event)
    }
  })
  await execution
  const stored = (await chat.getRun('owner', 'main', runId))!
  assert.equal(cursor, stored.lastEventSeq)
  assert.ok(cursor > lastSeen)
  assert.deepEqual(view.parts, stored.parts)
  assert.equal(view.text, '先查询。\n\n最终回答。')
  assert.equal(view.status, 'completed')
  assert.ok(received.some(event => event.type === 'event' && event.event.type === 'tool.result'))
  const history = await chat.getConversation('owner', 'main')
  assert.deepEqual(history.messages[1].parts, stored.parts)
  for (const suffix of ['&after=-1', '&after=999999', '&after=abc']) {
    assert.equal((await fetch(`${base}/api/runs/${runId}/events?userId=owner&channel=main${suffix}`)).status, 400)
  }
  assert.equal((await fetch(`${base}/api/runs/${runId}/events?userId=other&channel=main&after=0`)).status, 404)
})

test('terminal SSE drains multiple replay batches and fragmented UTF-8 remains valid', async t => {
  const { db, chat } = await fixture(t)
  const { runId } = await chat.submit('owner', 'main', 'many events', 'many')
  const handler = new AgentRunHandler(db, { async execute(_run, _signal, emit) {
    startText(emit)
    for (let i = 0; i < 350; i++) deltaText(emit, '中', 'test-attempt', i % 2)
    finishText(emit, '完整回答')
  } })
  await handler.execute(runId, new AbortController().signal)
  const server = await createServer({ chat, logger: false })
  await server.listen({ host: '127.0.0.1', port: 0 })
  t.after(() => server.close())
  const port = (server.server.address() as { port: number }).port
  const response = await fetch(`http://127.0.0.1:${port}/api/runs/${runId}/events?userId=owner&channel=main&after=0`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const fragmented = new ReadableStream<Uint8Array>({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
    controller.close()
  } })
  let count = 0
  let view = emptyRunView()
  await readMessageStream(fragmented, event => {
    assert.equal(event.type, 'event')
    if (event.type === 'event') { assert.equal(event.sequence, ++count); view = reduceRunEvent(view, event.event) }
  })
  assert.ok(count > 200)
  assert.equal(view.text, '完整回答')
  assert.equal(view.status, 'completed')
})

test('a failed persistence batch cannot appear in the saved view without replay records', async t => {
  const { db, chat } = await fixture(t)
  let transactions = 0
  const faulty: DatabaseAccess = { read: db.read, transaction: operation => {
    if (++transactions === 2) return Promise.reject(new Error('simulated write failure'))
    return db.transaction(operation)
  } }
  const { runId } = await chat.submit('owner', 'main', 'failed write', 'failed')
  const handler = new AgentRunHandler(faulty, { async execute(_run, signal, emit) {
    startText(emit); deltaText(emit, '未保存的文本')
    await once(signal, 'abort')
    signal.throwIfAborted()
  } })
  await handler.execute(runId, new AbortController().signal)
  const run = (await chat.getRun('owner', 'main', runId))!
  const observed = (await chat.getRunEvents('owner', 'main', runId, 0))!
  assert.equal(run.status, 'failed')
  assert.equal(run.text, '')
  assert.deepEqual(run.parts, [])
  assert.deepEqual(observed.events.map(event => event.event.type), ['run.failed'])
  assert.deepEqual(observed.events.reduce((view, event) => reduceRunEvent(view, event.event), emptyRunView()).parts, run.parts)
})
