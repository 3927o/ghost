/** Independent Agent execution process. API shutdown has no effect on this lifecycle. */
import { join } from 'node:path'
import { Database } from '@ghost/database'
import { AgentRunHandler } from './run-handler.ts'
import { databasePath, loadEnvironment, rootDir, redisConfig } from '@ghost/config'
import { QueueWorker } from '@ghost/queue'
import type { RunJob } from '@ghost/contracts'
import { AgentCore } from './runtime/index.ts'
import { loadModelConfig } from './model-config.ts'

loadEnvironment()
const { provider, model } = loadModelConfig(process.env)
const path = databasePath()
const db = new Database(path)
const core = new AgentCore({
  dshHome: process.env.DSH_HOME || join(rootDir, 'data/sessions'),
  skillsDir: process.env.AGENT_SKILLS_DIR || join(import.meta.dirname, 'skills'),
  modelProvider: provider, modelName: model, sessionDbPath: path,
})
const handler = new AgentRunHandler(db, core)
const worker = new QueueWorker<RunJob>(redisConfig(), {
  execute: (job, signal) => handler.execute(job.data.runId, signal),
  deliveryFailed: (job, error) => handler.deliveryFailed(job.data.runId, error),
}, { lockDuration: Number(process.env.WORKER_LOCK_MS || 30000) })
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (stopping) return
    stopping = true
    // A non-cooperative tool may outlive cancellation; Redis redelivery will mark the run interrupted.
    setTimeout(() => process.exit(1), 10_000).unref()
    worker.stop().catch(error => console.error('[Worker] Shutdown failed:', error))
  })
}
try {
  await core.init()
  await worker.ready()
  console.log(`[Worker] Ready: ${provider}/${model}`)
  await worker.start()
} catch (error) {
  console.error('[Worker] Fatal error:', error)
  process.exitCode = 1
} finally {
  try { await worker.stop() } finally {
    try { await core.dispose() } finally { db.close() }
  }
}
