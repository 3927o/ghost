import type { DatabaseConfig, DriverOptions } from '../types.ts'
export function postgres(config: Extract<DatabaseConfig, { type: 'postgres' | 'mysql' }>): DriverOptions {
  return { type: 'postgres', url: config.url, poolSize: config.poolSize ?? 10 }
}
