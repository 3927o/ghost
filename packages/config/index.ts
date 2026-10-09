/** Shared filesystem configuration; API startup never validates model credentials. */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export const rootDir = resolve(import.meta.dirname, '../..')

export function loadEnvironment(): void {
  const envFile = process.env.GHOST_ENV_FILE ?? resolve(rootDir, '.env')
  if (envFile && existsSync(envFile)) process.loadEnvFile(envFile)
}

export function databasePath(): string {
  return resolve(process.env.DATABASE_PATH || resolve(rootDir, 'data/ghost.sqlite'))
}

export function redisConfig() {
  return {
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
    queueName: process.env.REDIS_QUEUE_NAME || 'ghost-agent-runs',
  }
}
