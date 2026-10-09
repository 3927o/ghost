import type { DatabaseConfig, DatabaseModels } from '@ghost/database-client'
import { businessEntities } from './entities.ts'
import { initializeSchema } from '../migrations/initial.ts'
export function businessModels(config: DatabaseConfig): DatabaseModels {
  const entities = businessEntities(config)
  return { entities, initialize: runner => initializeSchema(runner, 'business', entities) }
}
export { ConversationRepository } from './conversation-repository.ts'
export { MessageRepository } from './message-repository.ts'
export { RunRepository, RunOwnershipLostError } from './run-repository.ts'
export { OutboxRepository, outboxStore } from './outbox-repository.ts'
