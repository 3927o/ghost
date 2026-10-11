import { Table, TableForeignKey, TableIndex, type EntitySchema, type QueryRunner } from 'typeorm'

/** Versioned schema creation and explicit additive migrations; no destructive synchronization. */
export async function initializeSchema(runner: QueryRunner, group: string, entities: EntitySchema[], migrations: ((runner: QueryRunner) => Promise<void>)[] = []): Promise<void> {
  const target = 1 + migrations.length
  await runner.createTable(new Table({ name: 'ghost_schema_versions', columns: [
    { name: 'name', type: 'varchar', length: '32', isPrimary: true },
    { name: 'version', type: 'integer' },
  ] }), true)
  const marker = await runner.manager.createQueryBuilder().select('version').from('ghost_schema_versions', 'v').where('name = :name', { name: group }).getRawOne()
  if (marker) {
    const version = Number(marker.version)
    if (!Number.isInteger(version) || version < 1 || version > target) throw new Error(`Unsupported ${group} schema version: ${marker.version}`)
    for (let next = version + 1; next <= target; next++) {
      await migrations[next - 2](runner)
      await runner.manager.createQueryBuilder().update('ghost_schema_versions').set({ version: next }).where('name = :name', { name: group }).execute()
    }
    return
  }
  const metadata = entities.map(entity => runner.connection.getMetadata(entity))
  // Reject the previous SQLite layout before touching its tables or data.
  for (const entity of metadata) {
    const existing = await runner.getTable(entity.tablePath)
    if (existing && entity.columns.some(column => !existing.findColumnByName(column.databaseName))) {
      throw new Error(`Legacy/incompatible table ${entity.tableName}; use a new database. Existing data was not migrated.`)
    }
  }
  for (const entity of metadata) {
    const table = Table.create(entity, runner.connection.driver)
    // NO PAD binary collation preserves case and trailing spaces in identifiers.
    if (runner.connection.options.type === 'mysql') {
      for (const column of table.columns) if (['varchar', 'text', 'longtext'].includes(column.type)) column.collation = 'utf8mb4_0900_bin'
    }
    await runner.createTable(table, true, false, false)
  }
  for (const entity of metadata) {
    const table = (await runner.getTable(entity.tablePath))!
    for (const foreignKey of entity.foreignKeys) {
      const key = TableForeignKey.create(foreignKey, runner.connection.driver)
      if (!table.foreignKeys.some(existing => existing.name === key.name)) await runner.createForeignKey(table, key)
    }
    for (const index of entity.indices) {
      const value = TableIndex.create(index)
      if (!table.indices.some(existing => existing.name === value.name)) await runner.createIndex(table, value)
    }
  }
  await runner.manager.createQueryBuilder().insert().into('ghost_schema_versions').values({ name: group, version: target }).execute()
}
