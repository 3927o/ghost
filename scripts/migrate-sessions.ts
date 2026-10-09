import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SqliteSessionDatabase } from '../src/storage/sqlite-session-database.ts'

const rootDir = resolve(import.meta.dirname, '..')
const envPath = join(rootDir, '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

// The old DSH_HOME had another sessions/ directory for the JSONL provider.
const source = resolve(process.argv[2] || join(process.env.DSH_HOME || join(rootDir, 'data', 'sessions'), 'sessions'))
const path = resolve(process.env.SESSION_DB_PATH || join(rootDir, 'data', 'ghost.sqlite'))
if (!existsSync(source)) throw new Error(`JSONL source directory does not exist: ${source}`)

const ctx = new Context()
const database = new SqliteSessionDatabase(path)
try {
  await ctx.plugin(JsonlSessionPersistence, { root: source, compression: 'none' })
  const persistence = ctx.get('sessionPersistence')!
  const sessions = await persistence.list()
  let imported = 0
  let existing = 0
  for (const { header } of sessions) {
    const handle = await persistence.open(header.id, 'read')
    try {
      const { events } = await handle.read()
      const result = database.importSession(handle.header, handle.inheritedEventCount, events)
      if (result === 'imported') imported++
      else existing++
    } finally {
      await handle.close()
    }
  }
  console.log(`Migrated ${imported} session(s); ${existing} already imported. SQLite: ${path}`)
} finally {
  try {
    await ctx.fiber.dispose()
  } finally {
    database.close()
  }
}
