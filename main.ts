/**
 * Ghost Personal Agent - Main Entry Point
 *
 * Architecture:
 * - Application Layer: Fastify HTTP server
 * - Agent Core: Cordis + DSH (agent runtime)
 *
 * Usage:
 *   npm start
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentCore } from './src/agent-core/index.ts'
import { SessionManager } from './src/app/session-manager.ts'
import { createServer } from './src/app/server.ts'
import { loadModelConfig } from './model-config.ts'

const rootDir = dirname(fileURLToPath(import.meta.url))

// Load .env
const envFile = join(rootDir, '.env')
if (existsSync(envFile)) {
  process.loadEnvFile(envFile)
} else {
  console.error('Error: .env file not found. Copy .env.example to .env and configure it.')
  process.exit(1)
}

// Load and validate model config
const { provider, model } = loadModelConfig(process.env)
console.log(`[Main] Using model: ${provider}/${model}`)

// Initialize Agent Core
const agentCore = new AgentCore({
  dshHome: process.env.DSH_HOME || join(rootDir, 'data', 'sessions'),
  skillsDir: join(rootDir, 'skills'),
  modelProvider: provider,
  modelName: model,
  sessionDbPath: process.env.SESSION_DB_PATH || join(rootDir, 'data', 'ghost.sqlite'),
})

await agentCore.init()
const sessionManager = new SessionManager(agentCore, 30 * 60 * 1000)

// Create and start HTTP server
const server = await createServer({
  host: process.env.HOST || '0.0.0.0',
  port: parseInt(process.env.PORT || '3000', 10),
  sessionManager,
})

// The entry point owns shutdown order: requests, application sessions, runtime.
server.addHook('onClose', async () => {
  try {
    await sessionManager.dispose()
  } finally {
    await agentCore.dispose()
  }
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    server.log.info(`Received ${signal}, shutting down gracefully...`)
    await server.close()
    process.exit(0)
  })
}

try {
  await server.listen({
    host: process.env.HOST || '0.0.0.0',
    port: parseInt(process.env.PORT || '3000', 10),
  })
  console.log(`[Main] Server listening on http://${process.env.HOST || '0.0.0.0'}:${process.env.PORT || '3000'}`)
} catch (err) {
  server.log.error(err)
  await server.close()
  process.exit(1)
}
