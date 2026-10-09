/** Independent Agent execution process. API shutdown has no effect on this lifecycle. */
import { join } from 'node:path'
import { businessModels } from '@ghost/database'
import { createDatabase } from '@ghost/database-client'
import { AgentRunHandler } from './run-handler.ts'
import { databaseConfig, loadEnvironment, rootDir, redisConfig } from '@ghost/config'
import { QueueWorker } from '@ghost/queue'
import type { RunJob } from '@ghost/contracts'
import { AgentCore } from './runtime/index.ts'
import { loadModelConfig } from './model-config.ts'

loadEnvironment()
const { provider, model } = loadModelConfig(process.env)
const dbConfig = databaseConfig()
const core = new AgentCore({
  dshHome: process.env.DSH_HOME || join(rootDir, 'data/sessions'),
  skillsDir: process.env.AGENT_SKILLS_DIR || join(import.meta.dirname, 'skills'),
  modelProvider: provider, modelName: model, sessionDatabase: databaseConfig(true),
})
const db = await createDatabase(dbConfig, businessModels(dbConfig))
let worker: QueueWorker<RunJob> | undefined
let deadline: NodeJS.Timeout | undefined
try {
  const handler = new AgentRunHandler(db, core)
  const consumer = worker = new QueueWorker<RunJob>(redisConfig(), {
    execute: (job, signal) => handler.execute(job.data.runId, signal),
    deliveryFailed: (job, error) => handler.deliveryFailed(job.data.runId, error),
  }, { lockDuration: Number(process.env.WORKER_LOCK_MS || 30000), concurrency: Number(process.env.WORKER_CONCURRENCY || 3) })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (deadline) return
      // A non-cooperative tool may outlive cancellation; Redis redelivery will mark the run interrupted.
      deadline = setTimeout(() => process.exit(1), 10_000).unref()
      consumer.stop().catch(error => console.error('[Worker] Shutdown failed:', error))
    })
  }
  await core.init()
  await worker.ready()
  console.log(`[Worker] Ready: ${provider}/${model}`)
  await worker.start()
} catch (error) {
  console.error('[Worker] Fatal error:', error)
  process.exitCode = 1
} finally {
  try {
    try { await worker?.stop() } finally {
      try { await core.dispose() } finally { await db.close() }
    }
  } finally {
    clearTimeout(deadline)
  }
}
