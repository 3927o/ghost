/** Shared connection configuration; no model or Cordis dependency. */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DatabaseConfig } from '@ghost/database-client'
export const rootDir = resolve(import.meta.dirname, '../..')
export function loadEnvironment(): void {
  const envFile = process.env.GHOST_ENV_FILE ?? resolve(rootDir, '.env')
  if (envFile && existsSync(envFile)) process.loadEnvFile(envFile)
}
export function databaseConfig(agent = false): DatabaseConfig {
  const type = (agent ? process.env.AGENT_DATABASE_TYPE : undefined) || process.env.DATABASE_TYPE || 'sqlite'
  if (type === 'sqlite') return { type, path: resolve((agent ? process.env.AGENT_DATABASE_PATH : undefined) || process.env.DATABASE_PATH || resolve(rootDir, 'data/ghost-orm.sqlite')) }
  if (type !== 'postgres' && type !== 'mysql') throw new Error(`Unsupported database type: ${type}`)
  const url = (agent ? process.env.AGENT_DATABASE_URL : undefined) || process.env.DATABASE_URL
  if (!url) throw new Error(`${agent ? 'AGENT_DATABASE_URL or ' : ''}DATABASE_URL is required for ${type}`)
  return { type, url, poolSize: Number((agent ? process.env.AGENT_DATABASE_POOL_SIZE : undefined) || process.env.DATABASE_POOL_SIZE || 10) }
}
export function redisConfig() {
  return { url: process.env.REDIS_URL || 'redis://127.0.0.1:6379', queueName: process.env.REDIS_QUEUE_NAME || 'ghost-agent-runs' }
}
