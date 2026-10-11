import { Table, TableColumn, TableForeignKey, type QueryRunner } from 'typeorm'

/** Add event replay and presentation state while retaining every existing run and message. */
export async function addRunEvents(runner: QueryRunner): Promise<void> {
  const sqlite = ['sqlite', 'better-sqlite3'].includes(runner.connection.options.type)
  // SQLite supports additive ALTER directly. Rebuilding a referenced runs table would violate its FKs.
  if (!await runner.hasColumn('runs', 'parts')) {
    if (sqlite) await runner.query('ALTER TABLE "runs" ADD COLUMN "parts" text')
    else await runner.addColumn('runs', new TableColumn({
      name: 'parts', type: runner.connection.options.type === 'mysql' ? 'longtext' : 'text', isNullable: true,
    }))
  }
  if (!await runner.hasColumn('runs', 'event_sequence')) {
    if (sqlite) await runner.query('ALTER TABLE "runs" ADD COLUMN "event_sequence" integer NOT NULL DEFAULT 0')
    else await runner.addColumn('runs', new TableColumn({ name: 'event_sequence', type: 'integer', default: 0 }))
  }
  const metadata = runner.connection.getMetadata('RunEvent')
  const table = Table.create(metadata, runner.connection.driver)
  if (runner.connection.options.type === 'mysql') for (const column of table.columns) {
    if (['varchar', 'text', 'longtext'].includes(column.type)) column.collation = 'utf8mb4_0900_bin'
  }
  await runner.createTable(table, true, false, false)
  const existing = (await runner.getTable(table.name))!
  for (const foreignKey of metadata.foreignKeys) {
    const key = TableForeignKey.create(foreignKey, runner.connection.driver)
    if (!existing.foreignKeys.some(value => value.name === key.name)) await runner.createForeignKey(existing, key)
  }
}
