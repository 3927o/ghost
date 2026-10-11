/** The same repositories and Cordis consumers run against all three real drivers. */
import { test } from 'node:test'
import { startText, deltaText, finishText } from './fixtures/agent-events.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError, SessionOwnershipLostError } from '@deepseek-ai/dsh-session-persistence'
import { createDatabase, type DatabaseClient, type DatabaseConfig } from '@ghost/database-client'
import { businessModels, ConversationRepository, OutboxRepository, outboxStore } from '@ghost/database'
import { sessionModels, SessionRepository } from '@ghost/database/session'
import { ChatService, SubmissionConflictError } from '../apps/api/chat-service.ts'
import { AgentRunHandler } from '../apps/agent-worker/run-handler.ts'
import * as pgProvider from '../apps/agent-worker/plugins/database-provider-pg/index.ts'
import * as mysqlProvider from '../apps/agent-worker/plugins/database-provider-mysql/index.ts'
import * as sqliteProvider from '../apps/agent-worker/plugins/database-provider-sqlite/index.ts'
import SessionPersistence from '../apps/agent-worker/plugins/session-persistence-database/index.ts'
import { SessionStore } from '../apps/agent-worker/plugins/session-persistence-database/session-store.ts'

for (const backend of ['sqlite', 'postgres', 'mysql'] as const) {
  test(`${backend}: concurrent repositories, transactions, independent clients and plugin shutdown`, { timeout: 180_000 }, async t => {
    const directory = mkdtempSync(join(tmpdir(), `ghost-${backend}-`))
    let container: string | undefined
    let ctx: Context | undefined
    const clients: DatabaseClient[] = []
    t.after(async () => {
      await ctx?.fiber.dispose()
      await Promise.allSettled(clients.map(client => client.close()))
      if (container) execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' })
      rmSync(directory, { recursive: true, force: true })
    })
    let config: DatabaseConfig
    if (backend === 'sqlite') config = { type: 'sqlite', path: join(directory, 'database.sqlite') }
    else {
      const port = backend === 'postgres' ? '5432' : '3306'
      const args = backend === 'postgres'
        ? ['-e', 'POSTGRES_USER=ghost', '-e', 'POSTGRES_PASSWORD=ghost', '-e', 'POSTGRES_DB=ghost', 'postgres:17-alpine']
        : ['-e', 'MYSQL_ROOT_PASSWORD=ghost-root', '-e', 'MYSQL_DATABASE=ghost', '-e', 'MYSQL_USER=ghost', '-e', 'MYSQL_PASSWORD=ghost', 'mysql:8.4']
      container = execFileSync('docker', ['run', '-d', '-p', `127.0.0.1::${port}`, ...args], { encoding: 'utf8' }).trim()
      const mapped = execFileSync('docker', ['port', container, port], { encoding: 'utf8' }).trim().split(':').at(-1)
      config = { type: backend, url: `${backend}://ghost:ghost@127.0.0.1:${mapped}/ghost`, poolSize: 4 }
    }
    const deadline = Date.now() + 100_000
    let business: DatabaseClient
    while (true) {
      try { business = await createDatabase(config, businessModels(config)); clients.push(business); break }
      catch (error) {
        const code = (error as { code?: string; driverError?: { code?: string } }).driverError?.code ?? (error as { code?: string }).code
        if (Date.now() > deadline || (!String(error).includes('Connection terminated unexpectedly') && !['ECONNREFUSED', 'ECONNRESET', '57P03', 'ER_ACCESS_DENIED_ERROR', 'ER_BAD_DB_ERROR', 'PROTOCOL_CONNECTION_LOST'].includes(code ?? ''))) throw error
        await delay(500)
      }
    }
    const second = await createDatabase(config, businessModels(config)); clients.push(second)
    const chat = new ChatService(business)
    const otherChat = new ChatService(second)
    const duplicate = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? chat : otherChat).submit('owner', 'main', 'hello', 'same-request')))
    assert.equal(new Set(duplicate.map(result => result.runId)).size, 1)
    assert.equal(duplicate.filter(result => result.accepted).length, 1)
    const existingDuplicates = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? chat : otherChat).submit('owner', 'main', 'hello', 'same-request')))
    assert.ok(existingDuplicates.every(result => !result.accepted && result.runId === duplicate[0].runId))
    await assert.rejects(() => chat.submit('owner', 'main', 'different', 'same-request'), SubmissionConflictError)
    await otherChat.submit('Owner', 'main', 'case-sensitive', 'same-request')
    assert.equal((await chat.getConversation('owner', 'main')).messages.length, 2)
    assert.equal((await chat.getConversation('Owner', 'main')).messages[0].content, 'case-sensitive')
    const largeContent = '数据库🙂'.repeat(10_000)
    await chat.submit('large-payload', 'main', largeContent, 'large')
    assert.equal((await otherChat.getConversation('large-payload', 'main')).messages[0].content, largeContent)
    const exactIds = await Promise.all(['key', 'key ', 'Key'].map(requestId => chat.submit('exact-identifiers', 'main', 'hello', requestId)))
    assert.equal(new Set(exactIds.map(result => result.runId)).size, 3, 'request IDs preserve case and trailing spaces on every backend')

    await assert.rejects(() => business.transaction(async manager => {
      await new ConversationRepository(manager).ensure('rollback', 'main')
      await new OutboxRepository(manager).add('missing-run')
    }))
    assert.equal(await business.read(manager => new ConversationRepository(manager).find('rollback', 'main')), null)

    const accepted = await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? chat : otherChat).submit('ordered', 'main', `input-${i}`, `request-${i}`)))
    const ordered = (await chat.getConversation('ordered', 'main')).activeRunIds
    assert.equal(ordered.length, accepted.length)
    const executed: string[] = []
    const handler = new AgentRunHandler(business, { async execute(run) { executed.push(run.id) } })
    const signal = new AbortController().signal
    const outcomes = await Promise.all([...ordered].reverse().map(id => handler.execute(id, signal)))
    assert.ok(outcomes.includes('defer'))
    for (const id of ordered) await handler.execute(id, signal)
    assert.deepEqual(executed, ordered)

    let concurrent = 0
    let peak = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const gateDeadline = setTimeout(release, 10_000)
    t.after(() => { clearTimeout(gateDeadline); release() })
    const parallel = new AgentRunHandler(second, { async execute(run, _signal, onEvent) {
      peak = Math.max(peak, ++concurrent)
      startText(onEvent)
      deltaText(onEvent, 'partial')
      if (concurrent === 3) release()
      await gate
      concurrent--
      finishText(onEvent, `final:${run.input}`)
    } })
    const tasks = await Promise.all([0, 1, 2].map(i => chat.submit(`parallel-${i}`, 'main', `text-${i}`, 'one')))
    await Promise.all(tasks.map(task => parallel.execute(task.runId, signal)))
    assert.equal(peak, 3)
    clearTimeout(gateDeadline)
    for (let i = 0; i < 3; i++) assert.equal((await chat.getRun(`parallel-${i}`, 'main', tasks[i].runId))!.text, `final:text-${i}`)

    ctx = new Context()
    const provider = backend === 'postgres' ? pgProvider : backend === 'mysql' ? mysqlProvider : sqliteProvider
    const providerFiber = ctx.plugin(provider, config as never)
    await providerFiber
    await ctx.plugin(SessionPersistence)
    const persistence = ctx.get('sessionPersistence')!
    const service = ctx.get('database')!
    assert.ok(service)
    assert.ok(persistence)
    const headers = [0, 1, 2].map(i => ({ version: SESSION_FORMAT_VERSION, id: SessionId(`session-${backend}-${i}`), createdAt: Date.now(), isSeeded: false } as const))
    const handles = await Promise.all(headers.map(header => persistence.create(header)))
    const verifier = await createDatabase(config, sessionModels(config)); clients.push(verifier)
    const store = new SessionStore(verifier)
    await assert.rejects(() => store.open(headers[0].id, true), SessionAlreadyOwnedError)
    for (let i = 0; i < 3; i++) await handles[i].append([{ type: 'turn/start', seq: SessionSeq(0), time: Date.now(), data: { turn: 1 } }])
    await handles[0].close()
    assert.ok(await persistence.stat(headers[1].id), 'Closing one handle preserves the shared database service')
    const reopened = await persistence.open(headers[0].id, 'write')
    assert.equal((await reopened.read()).events.length, 1)
    await reopened.close()

    // Invalidate ownership through a separate client. A stale writer cannot append.
    await verifier.transaction(async manager => {
      const repo = new SessionRepository(manager)
      await repo.lock(headers[2].id)
      const writer = (await repo.writer(headers[2].id))!
      await repo.claim({ ...writer, token: 'replacement' })
    })
    await assert.rejects(() => handles[2].append([{ type: 'turn/end', seq: SessionSeq(1), time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } }]), SessionOwnershipLostError)
    await handles[2].close()
    assert.equal((await verifier.read(manager => new SessionRepository(manager).writer(headers[2].id)))!.token, 'replacement')

    // Buffer an event, then unload the Provider immediately. The dependent must flush
    // while the service is still usable, and only then may the pool close.
    ctx.emit('session/event', { id: headers[1].id } as never, { type: 'turn/end', seq: SessionSeq(1), time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
    await providerFiber.dispose()
    assert.equal((await store.read(headers[1].id)).events.length, 2)
    assert.equal(await verifier.read(manager => new SessionRepository(manager).writer(headers[1].id)), null)
    await assert.rejects(() => service.read(async () => 1))
    assert.ok((await outboxStore(business).pending()).length > 0, 'Provider disposal does not close the Worker business client')
    await business.close()
    assert.equal((await otherChat.getConversation('owner', 'main')).messages.length, 2, 'Closing one client leaves the other pool usable')

    let entered!: () => void
    let finish!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const finishing = new Promise<void>(resolve => { finish = resolve })
    t.after(finish)
    const active = second.transaction(async manager => {
      await new ConversationRepository(manager).ensure('closing-client', 'main')
      entered()
      await finishing
      return 42
    })
    await started
    let closed = false
    const closing = second.close().then(() => { closed = true })
    try {
      await assert.rejects(() => second.read(async () => 1), /closing/)
      assert.equal(closed, false, 'close waits for the transaction already in progress')
    } finally { finish() }
    assert.equal(await active, 42)
    await closing
  })
}
