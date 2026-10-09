import type { DatabaseConfig, DatabaseModels } from '@ghost/database-client'
import { sessionEntities } from './entities.ts'
import { initializeSchema } from '../migrations/initial.ts'
export function sessionModels(config: DatabaseConfig): DatabaseModels {
  const entities = sessionEntities(config)
  return { entities, initialize: runner => initializeSchema(runner, 'session', entities) }
}
export { SessionRepository } from './session-repository.ts'
export type { SessionRow, WriterRow } from './entities.ts'
