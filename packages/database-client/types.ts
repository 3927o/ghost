import type { DataSourceOptions, EntityManager, EntitySchema, QueryRunner } from 'typeorm'

export type DatabaseConfig =
  | { type: 'postgres' | 'mysql'; url: string; poolSize?: number }
  | { type: 'sqlite'; path: string }

export interface DatabaseAccess {
  /** A consistent snapshot. The manager is valid only for this callback. */
  read<T>(operation: (manager: EntityManager) => Promise<T>): Promise<T>
  /** Database-only work; never hold this transaction over model/tool calls. */
  transaction<T>(operation: (manager: EntityManager) => Promise<T>): Promise<T>
}
export interface DatabaseClient extends DatabaseAccess { close(): Promise<void> }
export interface DatabaseModels {
  entities: EntitySchema[]
  initialize: (runner: QueryRunner) => Promise<void>
}
export type DriverOptions = DataSourceOptions
export type { EntityManager, EntitySchema, QueryRunner } from 'typeorm'
