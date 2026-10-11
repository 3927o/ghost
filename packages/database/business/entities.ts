import { EntitySchema, type EntitySchemaColumnOptions } from 'typeorm'
import type { DatabaseConfig } from '@ghost/database-client'
import type { RunStatus } from '@ghost/contracts'
const id: EntitySchemaColumnOptions = { type: 'varchar', length: 64, primary: true }
const ref: EntitySchemaColumnOptions = { type: 'varchar', length: 64 }
const integer: EntitySchemaColumnOptions = { type: 'integer', default: 0 }
const time: EntitySchemaColumnOptions = { type: 'bigint', transformer: { to: (v: number) => v, from: (v: string | number) => Number(v) } }
export interface ConversationRow { id: string; user_id: string; logical_id: string; runtime_session_id: string; next_sequence: number; lock_version: number; created_at: number; updated_at: number }
export interface RunRow { id: string; conversation_id: string; request_id: string; sequence: number; input: string; status: RunStatus; text: string; error: string | null; revision: number; parts: string | null; event_sequence: number; owner_token: string | null; active_conversation: string | null; created_at: number; updated_at: number }
export interface RunEventRow { run_id: string; sequence: number; event: string; time: number }
export interface MessageRow { id: string; conversation_id: string; run_id: string; sequence: number; role: 'user' | 'assistant'; content: string; timestamp: number; error: boolean }
export interface OutboxRow { run_id: string; created_at: number }
export const ConversationEntity = new EntitySchema<ConversationRow>({ name: 'Conversation', tableName: 'conversations', columns: {
  id, user_id: { type: 'varchar', length: 128 }, logical_id: { type: 'varchar', length: 64 }, runtime_session_id: { ...ref, unique: true },
  next_sequence: integer, lock_version: integer, created_at: time, updated_at: time,
}, uniques: [{ columns: ['user_id', 'logical_id'] }] })
export const RunEntity = new EntitySchema<RunRow>({ name: 'Run', tableName: 'runs', columns: {
  id, conversation_id: ref, request_id: { type: 'varchar', length: 128 }, sequence: integer,
  input: { type: 'text' }, status: { type: 'varchar', length: 16 }, text: { type: 'text' }, error: { type: 'text', nullable: true }, revision: integer,
  parts: { type: 'text', nullable: true }, event_sequence: integer,
  owner_token: { ...ref, nullable: true }, active_conversation: { ...ref, nullable: true, unique: true }, created_at: time, updated_at: time,
}, uniques: [{ columns: ['conversation_id', 'request_id'] }, { columns: ['conversation_id', 'sequence'] }],
foreignKeys: [{ target: 'Conversation', columnNames: ['conversation_id'], referencedColumnNames: ['id'] }], indices: [{ columns: ['conversation_id', 'status'] }] })
export const MessageEntity = new EntitySchema<MessageRow>({ name: 'Message', tableName: 'messages', columns: {
  id, conversation_id: ref, run_id: ref, sequence: integer, role: { type: 'varchar', length: 16 }, content: { type: 'text' }, timestamp: time, error: { type: Boolean, default: false },
}, uniques: [{ columns: ['run_id', 'role'] }], indices: [{ columns: ['conversation_id', 'sequence'] }],
foreignKeys: [{ target: 'Run', columnNames: ['run_id'], referencedColumnNames: ['id'] }, { target: 'Conversation', columnNames: ['conversation_id'], referencedColumnNames: ['id'] }] })
export const OutboxEntity = new EntitySchema<OutboxRow>({ name: 'Outbox', tableName: 'run_outbox', columns: { run_id: id, created_at: time },
foreignKeys: [{ target: 'Run', columnNames: ['run_id'], referencedColumnNames: ['id'] }] })
export const RunEventEntity = new EntitySchema<RunEventRow>({ name: 'RunEvent', tableName: 'run_events', columns: {
  run_id: id, sequence: { ...integer, primary: true }, event: { type: 'text' }, time,
}, foreignKeys: [{ target: 'Run', columnNames: ['run_id'], referencedColumnNames: ['id'] }] })
export function businessEntities(config: DatabaseConfig): EntitySchema[] {
  return [ConversationEntity, RunEntity, MessageEntity, OutboxEntity, RunEventEntity].map(entity => new EntitySchema({ ...entity.options, columns: Object.fromEntries(Object.entries(entity.options.columns).map(([name, column]) => [name,
    config.type === 'mysql' && column?.type === 'text' ? { ...column, type: 'longtext' } : column,
  ])) }))
}
