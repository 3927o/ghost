/** Independently deployable API entry point; models and Agent runtime belong to the Worker. */
import { Database, OutboxRepository } from '@ghost/database'
import { RedisQueue } from '@ghost/queue'
import type { RunJob } from '@ghost/contracts'
import { ChatService } from './chat-service.ts'
import { OutboxDispatcher } from './outbox-dispatcher.ts'
import { databasePath, loadEnvironment, redisConfig } from '@ghost/config'
import { createServer } from './server.ts'

loadEnvironment()
const db = new Database(databasePath())
const queue = new RedisQueue<RunJob>(redisConfig(), {
  attempts: 3, backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: 1000, removeOnFail: 1000,
})
const dispatcher = new OutboxDispatcher(new OutboxRepository(db), {
  publish: runId => queue.publish(runId, 'agent-run', { runId }),
})
const server = await createServer({ chat: new ChatService(db) })
server.addHook('onClose', async () => {
  try { await dispatcher.stop() } finally {
    try { await queue.close() } finally { db.close() }
  }
})
dispatcher.start()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    const deadline = setTimeout(() => process.exit(1), 10_000).unref()
    try { await server.close() } finally { clearTimeout(deadline) }
  })
}
try {
  await server.listen({ host: process.env.HOST || '0.0.0.0', port: Number(process.env.PORT || 3000) })
} catch (error) {
  server.log.error(error)
  await server.close()
  process.exitCode = 1
}
