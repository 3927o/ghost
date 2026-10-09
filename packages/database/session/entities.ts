import { EntitySchema, type EntitySchemaColumnOptions } from 'typeorm'
import type { DatabaseConfig } from '@ghost/database-client'
const ref: EntitySchemaColumnOptions = { type: 'varchar', length: 128 }
export interface SessionRow { id: string; header: string; inherited_event_count: number; event_count: number; generation: string; lock_version: number }
export interface EventRow { session_id: string; seq: number; event: string }
export interface WriterRow { session_id: string; token: string; hostname: string; pid: number; expires_at: number }
export const SessionEntity = new EntitySchema<SessionRow>({ name: 'StoredSession', tableName: 'sessions', columns: {
  id: { ...ref, primary: true }, header: { type: 'text' }, inherited_event_count: { type: 'integer' }, event_count: { type: 'integer', default: 0 },
  generation: { type: 'varchar', length: 64 }, lock_version: { type: 'integer', default: 0 },
} })
export const EventEntity = new EntitySchema<EventRow>({ name: 'StoredSessionEvent', tableName: 'session_events', columns: {
  session_id: { ...ref, primary: true }, seq: { type: 'integer', primary: true }, event: { type: 'text' },
}, foreignKeys: [{ target: 'StoredSession', columnNames: ['session_id'], referencedColumnNames: ['id'] }] })
export const WriterEntity = new EntitySchema<WriterRow>({ name: 'SessionWriter', tableName: 'session_writers', columns: {
  session_id: { ...ref, primary: true }, token: { type: 'varchar', length: 64 }, hostname: { type: 'varchar', length: 255 }, pid: { type: 'integer' },
  expires_at: { type: 'bigint', transformer: { to: (v: number) => v, from: (v: number | string) => Number(v) } },
}, foreignKeys: [{ target: 'StoredSession', columnNames: ['session_id'], referencedColumnNames: ['id'] }] })
export function sessionEntities(config: DatabaseConfig): EntitySchema[] {
  return [SessionEntity, EventEntity, WriterEntity].map(entity => new EntitySchema({ ...entity.options, columns: Object.fromEntries(Object.entries(entity.options.columns).map(([name, column]) => [name,
    config.type === 'mysql' && column?.type === 'text' ? { ...column, type: 'longtext' } : column,
  ])) }))
}
