/** Real API/Worker processes and real DSH, with a controlled local model endpoint. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { Database, OutboxRepository, RunRepository } from '@ghost/database'
import { ChatService } from '../apps/api/chat-service.ts'
import { RedisQueue, QueueWorker } from '@ghost/queue'
import { createServer as createNetServer } from 'node:net'
import { readMessageStream } from '../apps/web/src/lib/message-stream.ts'

const root = resolve(import.meta.dirname, '..')
async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, description: string, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await read()
    if (result) return result
    await delay(40)
  }
  throw new Error(`Timed out: ${description}`)
}

test('independent processes survive API restart, serialize runs, recover crashes, and recover Redis publication', { timeout: 60_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ghost-processes-'))
  const path = join(directory, 'ghost.sqlite')
  const db = new Database(path)
  const store = new ChatService(db)
  const reserve = createNetServer()
  reserve.listen(0, '127.0.0.1')
  await once(reserve, 'listening')
  const redisPort = (reserve.address() as { port: number }).port
  await new Promise<void>(resolve => reserve.close(() => resolve()))
  const redisContainer = execFileSync('docker', ['create', '-p', `127.0.0.1:${redisPort}:6379`, 'redis:7-alpine',
    'redis-server', '--save', '', '--appendonly', 'no'], { encoding: 'utf8' }).trim()
  t.after(() => { execFileSync('docker', ['rm', '-f', redisContainer], { stdio: 'ignore' }) })
  const children: ChildProcess[] = []
  const logs = new Map<ChildProcess, string>()
  const modelRequests: { input: string; messages: { role: string; content: unknown }[] }[] = []
  const held = new Map<string, ServerResponse>()
  const holds = new Set(['first', 'crash', 'shutdown', 'lease-loss', 'redis-loss'])
  let modelCalls = 0
  const send = (res: ServerResponse, content: string, finish = false) => {
    res.write(`data: ${JSON.stringify({
      id: 'mock', object: 'chat.completion.chunk', created: 1, model: 'test-model',
      choices: [{ index: 0, delta: finish ? {} : { role: 'assistant', content }, finish_reason: finish ? 'stop' : null }],
      ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}),
    })}\n\n`)
    if (finish) res.end('data: [DONE]\n\n')
  }
  const finish = (input: string) => {
    const res = held.get(input)!
    assert.ok(res, `Model request for ${input} is held`)
    send(res, ' done')
    send(res, '', true)
    held.delete(input)
  }
  const model = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    const payload = JSON.parse(body)
    const raw = payload.messages.findLast((message: { role: string; content: unknown }) =>
      message.role === 'user' && !(typeof message.content === 'string' && message.content.startsWith('<system-reminder>')))?.content
    const input = typeof raw === 'string' ? raw : raw?.map((part: { text?: string }) => part.text ?? '').join('')
    modelCalls++
    modelRequests.push({ input, messages: payload.messages })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    send(res, `reply:${input}`)
    if (holds.has(input)) held.set(input, res)
    else { send(res, ' done'); send(res, '', true) }
  })
  model.listen(0, '127.0.0.1')
  await once(model, 'listening')
  const modelPort = (model.address() as { port: number }).port
  const env = {
    ...process.env, GHOST_ENV_FILE: '', DATABASE_PATH: path, HOST: '127.0.0.1', PORT: '0',
    REDIS_URL: `redis://127.0.0.1:${redisPort}`, WORKER_LOCK_MS: '1500', REDIS_QUEUE_NAME: 'ghost-test',
    DSH_HOME: join(directory, 'dsh'), MODEL_PROVIDER: 'test', MODEL_NAME: 'test-model', TEST_MODEL_KEY: 'local-test',
    MODEL_PROVIDERS: JSON.stringify({ test: {
      api: 'openai-completions', baseURL: `http://127.0.0.1:${modelPort}/v1`, apiKeyEnv: 'TEST_MODEL_KEY',
      models: [{ id: 'test-model', maxTokens: 128 }],
    } }),
  }
  const launch = (entry: string, overrides: Record<string, string> = {}) => {
    const child = spawn(process.execPath, [entry], { cwd: root, env: { ...env, ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    logs.set(child, '')
    child.stdout!.on('data', data => logs.set(child, logs.get(child)! + data.toString()))
    child.stderr!.on('data', data => logs.set(child, logs.get(child)! + data.toString()))
    return child
  }
  const stop = async (child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, 'exit')
    child.kill(signal)
    const deadline = setTimeout(() => child.kill('SIGKILL'), 4000)
    try { await exited } finally { clearTimeout(deadline) }
  }
  t.after(async () => {
    for (const child of children) await stop(child, 'SIGKILL')
    for (const response of held.values()) response.destroy()
    model.closeAllConnections()
    await new Promise<void>(resolve => model.close(() => resolve()))
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const startApi = async () => {
    const child = launch('apps/api/main.ts', { MODEL_PROVIDER: '', MODEL_NAME: '', MODEL_PROVIDERS: '' })
    const url = await until(() => {
      assert.equal(child.exitCode, null, logs.get(child)!)
      return logs.get(child)!.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
    }, 'API listen')
    return { child, url }
  }
  const startWorker = async (overrides: Record<string, string> = {}) => {
    const child = launch('apps/agent-worker/main.ts', overrides)
    await until(() => {
      assert.equal(child.exitCode, null, logs.get(child)!)
      return logs.get(child)!.includes('[Worker] Ready:')
    }, 'Worker ready')
    return child
  }
  const submit = async (url: string, content: string) => {
    const response = await fetch(`${url}/api/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'owner', channel: 'main', content, requestId: content }),
    })
    assert.equal(response.status, 202)
    return (await response.json() as { runId: string }).runId
  }
  const completed = (id: string) => until(() => {
    const run = store.getRun('owner', 'main', id)!
    assert.notEqual(run.status, 'failed', JSON.stringify(run) + [...logs.values()].join('\n'))
    return run.status === 'completed' && run
  }, `run ${id} complete`)

  let api = await startApi()
  const first = await submit(api.url, 'first')
  const second = await submit(api.url, 'second')
  assert.equal(store.getRun('owner', 'main', first)!.status, 'queued')
  assert.equal(modelCalls, 0)
  assert.deepEqual(new OutboxRepository(db).pending(), [first, second])
  // API restart while Redis is offline must retain accepted commands for later delivery.
  await stop(api.child)
  assert.equal(api.child.exitCode, 0, logs.get(api.child)!)
  api = await startApi()
  execFileSync('docker', ['start', redisContainer], { stdio: 'ignore' })
  let worker = await startWorker()
  await until(() => new OutboxRepository(db).pending().length === 0, 'outbox delivery after Redis recovers')
  await until(() => held.has('first'), 'first model request')
  assert.match(JSON.stringify(modelRequests[0].messages), /greeting/, 'Worker loads skills from its own directory')
  const worker2 = await startWorker()
  await delay(350)
  assert.equal(modelCalls, 1, 'Second Worker cannot run the same conversation concurrently')
  const stream = await fetch(`${api.url}/api/runs/${first}/events?userId=owner&channel=main`)
  const reader = stream.body!.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /snapshot/)
  // API shutdown must close a live SSE connection promptly and leave the Worker running.
  await stop(api.child)
  assert.equal(api.child.exitCode, 0, logs.get(api.child)!)
  await reader.cancel().catch(() => {})
  reader.releaseLock()
  assert.equal(store.getRun('owner', 'main', first)!.status, 'running')
  finish('first')
  assert.equal((await completed(first)).text, 'reply:first done')
  await completed(second)
  api = await startApi()
  const terminal = await fetch(`${api.url}/api/runs/${first}/events?userId=owner&channel=main`, { headers: { 'Last-Event-ID': '1' } })
  const replay: string[] = []
  await readMessageStream(terminal.body!, event => replay.push(event.run.text))
  assert.deepEqual(replay, ['reply:first done'])
  const secondRequest = modelRequests.find(request => request.input === 'second')!
  assert.match(JSON.stringify(secondRequest.messages), /reply:first done/, 'DSH session context survives handle disposal')
  await stop(worker2)
  await stop(worker)

  worker = await startWorker()
  const crash = await submit(api.url, 'crash')
  const afterCrash = await submit(api.url, 'after-crash')
  await until(() => held.has('crash'), 'crash model request')
  await stop(worker, 'SIGKILL')
  worker = await startWorker()
  await until(() => store.getRun('owner', 'main', crash)!.status === 'failed', 'abandoned run recovery')
  await completed(afterCrash)
  assert.equal(modelRequests.filter(request => request.input === 'crash').length, 1, 'Interrupted tool/model work is never replayed')
  const shutdown = await submit(api.url, 'shutdown')
  await until(() => held.has('shutdown'), 'shutdown model request')
  await stop(worker)
  assert.equal(worker.exitCode, 0, logs.get(worker)!)
  assert.equal(store.getRun('owner', 'main', shutdown)!.status, 'failed')

  // Losing the DSH writer must abort an in-flight model, even with no new stream events.
  worker = await startWorker()
  const lost = await submit(api.url, 'lease-loss')
  await until(() => held.has('lease-loss'), 'lease-loss model request')
  const tamper = new DatabaseSync(path)
  try {
    tamper.prepare('UPDATE session_writers SET token = ? WHERE session_id = ?')
      .run('replacement-owner', new RunRepository(db).getExecution(lost)!.runtime_session_id)
  } finally { tamper.close() }
  await until(() => store.getRun('owner', 'main', lost)!.status === 'failed', 'writer lease loss cancellation', 25_000)
  await until(() => held.get('lease-loss')!.destroyed, 'model HTTP aborted after lease loss')
  await stop(worker)

  // A connection loss after successful use must also recover; accepted new messages stay in the outbox.
  worker = await startWorker()
  const redisLoss = await submit(api.url, 'redis-loss')
  await until(() => held.has('redis-loss'), 'Redis-loss model request')
  execFileSync('docker', ['stop', '--time', '1', redisContainer], { stdio: 'ignore' })
  await until(() => store.getRun('owner', 'main', redisLoss)!.status === 'failed', 'Redis loss cancels active Agent')
  await until(() => held.get('redis-loss')!.destroyed, 'model HTTP aborted after Redis loss')
  const afterRedis = await submit(api.url, 'after-redis')
  assert.ok(new OutboxRepository(db).pending().includes(afterRedis))
  await stop(worker, 'SIGKILL')
  execFileSync('docker', ['start', redisContainer], { stdio: 'ignore' })
  worker = await startWorker()
  await completed(afterRedis)
  assert.equal(modelRequests.filter(request => request.input === 'redis-loss').length, 1)
  assert.match(JSON.stringify(modelRequests.find(request => request.input === 'after-redis')!.messages), /reply:first done/)
  await stop(worker)

  const history = store.getConversation('owner', 'main')
  assert.equal(history.messages.filter(message => message.role === 'user').length, 8)
  assert.ok(history.messages.some(message => message.error))

  // Reuse the same transport with a different payload, job name and handler, without business storage.
  type DocumentJob = { documentId: string; format: 'pdf' }
  const documentQueue = { url: env.REDIS_URL, queueName: 'document-jobs' }
  const publisher = new RedisQueue<DocumentJob>(documentQueue, { attempts: 1 })
  const received: DocumentJob[] = []
  let deliveryError: Error | undefined
  const consumer = new QueueWorker<DocumentJob>(documentQueue, {
    async execute(job) {
      assert.equal(job.name, 'render-document')
      received.push(job.data)
      return 'done'
    },
    deliveryFailed(_job, error) { deliveryError = error },
  }, { concurrency: 2 })
  await consumer.ready()
  const consuming = consumer.start()
  try {
    await until(async () => {
      try {
        await publisher.publish('document-1', 'render-document', { documentId: 'document-1', format: 'pdf' })
        return true
      } catch { return false }
    }, 'generic task publication')
    await until(() => {
      assert.equal(deliveryError, undefined)
      return received.length === 1
    }, 'generic task consumption')
    assert.deepEqual(received, [{ documentId: 'document-1', format: 'pdf' }])
  } finally {
    await consumer.stop()
    await consuming
    await publisher.close()
  }
})
