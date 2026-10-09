import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { DriverOptions } from '../types.ts'
export function sqlite(path: string): DriverOptions {
  if (!path.trim()) throw new Error('SQLite path must not be empty')
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true })
  return { type: 'better-sqlite3', database: path === ':memory:' ? path : resolve(path), timeout: 5000 }
}
