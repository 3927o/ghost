import type { DatabaseConfig, DriverOptions } from '../types.ts'
export function mysql(config: Extract<DatabaseConfig, { type: 'postgres' | 'mysql' }>): DriverOptions {
  // The protocol handshake accepts an 8-bit collation ID. Column DDL separately
  // uses utf8mb4_0900_bin (ID 309) for exact, NO PAD comparisons.
  return { type: 'mysql', url: config.url, poolSize: config.poolSize ?? 10, charset: 'utf8mb4_bin' }
}
