/** Independently deployable API entry point; models and Agent runtime belong to the Worker. */
import { businessModels, outboxStore } from '@ghost/database'
import { createDatabase } from '@ghost/database-client'
import { RedisQueue } from '@ghost/queue'
import type { RunJob } from '@ghost/contracts'
import { ChatService } from './chat-service.ts'
import { OutboxDispatcher } from './outbox-dispatcher.ts'
import { databaseConfig, loadEnvironment, redisConfig } from '@ghost/config'
import { createServer } from './server.ts'

loadEnvironment()
const dbConfig = databaseConfig()
const db = await createDatabase(dbConfig, businessModels(dbConfig))
let queue: RedisQueue<RunJob> | undefined
let dispatcher: OutboxDispatcher | undefined
let server: Awaited<ReturnType<typeof createServer>> | undefined
let closing: Promise<void> | undefined
function closeResources(): Promise<void> {
  return closing ??= (async () => {
    try { await dispatcher?.stop() } finally {
      try { await queue?.close() } finally { await db.close() }
    }
  })()
}

try {
  const transport = queue = new RedisQueue<RunJob>(redisConfig(), {
    attempts: 3, backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 1000, removeOnFail: 1000,
  })
  dispatcher = new OutboxDispatcher(outboxStore(db), {
    publish: runId => transport.publish(runId, 'agent-run', { runId }),
  })
  server = await createServer({ chat: new ChatService(db) })
  server.addHook('onClose', closeResources)
  dispatcher.start()
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      const deadline = setTimeout(() => process.exit(1), 10_000).unref()
      try { await server!.close() } finally { clearTimeout(deadline) }
    })
  }
  await server.listen({ host: process.env.HOST || '0.0.0.0', port: Number(process.env.PORT || 3000) })
} catch (error) {
  console.error('[API] Fatal error:', error)
  process.exitCode = 1
  try { await server?.close() } finally { await closeResources() }
}
