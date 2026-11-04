import type { CatalogQuery } from '../catalog/common'
import type { AdministrationChange, AdministrationResult } from '../shared/database-administration'
import { engineNames } from '../shared/database-engines'
import { quoteIdentifier } from '../shared/sql/common'
import type { AdministrationPlan } from './reviews'

type Engine = 'mysql' | 'mariadb'
type NativePlan = AdministrationPlan & { verify(): Promise<boolean>; missingObjects?(): Promise<boolean> }
type Plan = (sql: string, target: string, state: unknown, notes: string[], verify: NativePlan['verify']) => NativePlan

const systemDatabase = /^(?:mysql|sys|performance_schema|information_schema)$|^#(?:mysql50#|sql)/i
const dropPrivileges = ['SELECT', 'SHOW VIEW', 'TRIGGER', 'EVENT', 'PROCESS', 'DROP']
const inventoryLimit = 200

function nameAllowed(name: string) {
  return name.length <= 64 && !/[./\\]| $|[\uD800-\uDFFF]/u.test(name) && !/[\u{10000}-\u{10FFFF}]/u.test(name)
}

async function databaseInventory(query: CatalogQuery, database: string) {
  const records = await query(`
    SELECT 'table', TABLE_NAME, TABLE_TYPE, ENGINE, CAST(CREATE_TIME AS CHAR), TABLE_COLLATION
      FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND BINARY TABLE_SCHEMA = BINARY ?
    UNION ALL SELECT 'routine', ROUTINE_NAME, ROUTINE_TYPE, SECURITY_TYPE, CAST(CREATED AS CHAR), CAST(LAST_ALTERED AS CHAR)
      FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND BINARY ROUTINE_SCHEMA = BINARY ?
    UNION ALL SELECT 'event', EVENT_NAME, STATUS, EVENT_TYPE, CAST(CREATED AS CHAR), CAST(LAST_ALTERED AS CHAR)
      FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? AND BINARY EVENT_SCHEMA = BINARY ?
    UNION ALL SELECT 'trigger', TRIGGER_NAME, EVENT_MANIPULATION, EVENT_OBJECT_TABLE, CAST(CREATED AS CHAR), ACTION_TIMING
      FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND BINARY TRIGGER_SCHEMA = BINARY ?
    LIMIT ${inventoryLimit + 1}`, Array(8).fill(database))
  if (records.length > inventoryLimit) throw new Error(`Reviewed removal supports up to ${inventoryLimit} catalog objects in one database.`)
  return records.map(row => JSON.stringify(row)).sort().map(row => JSON.parse(row) as (string | null)[])
}

async function proveDropVisibility(query: CatalogQuery, engine: Engine, observer: string) {
  const at = observer.lastIndexOf('@')
  if (at < 0) throw new Error('The connected account could not be verified for database removal.')
  const privileges = await query(`SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES
    WHERE BINARY GRANTEE = BINARY CONCAT(QUOTE(?), '@', QUOTE(?))`, [observer.slice(0, at), observer.slice(at + 1)])
  if (dropPrivileges.some(privilege => !privileges.some(row => row[0] === privilege))) {
    throw new Error('Reviewed removal requires direct global SELECT, SHOW VIEW, TRIGGER, EVENT, PROCESS and DROP privileges to verify the target.')
  }
  if (engine === 'mysql' && (await query('SELECT @@GLOBAL.partial_revokes'))[0]?.[0] !== '0') {
    throw new Error('Reviewed removal requires partial revokes to be disabled so an empty catalog cannot hide restricted objects.')
  }
}

async function tableIdentities(query: CatalogQuery, engine: Engine, database: string, inventory: Awaited<ReturnType<typeof databaseInventory>>) {
  const tables = inventory.filter(row => row[0] === 'table' && row[2] !== 'VIEW')
  if (tables.some(row => row[2] !== 'BASE TABLE' || row[3] !== 'InnoDB')) {
    throw new Error('Reviewed removal requires persistent InnoDB tables for every stored table in the target.')
  }
  if (!tables.length) return []
  const source = engine === 'mysql' ? 'INNODB_TABLES' : 'INNODB_SYS_TABLES'
  const keys = tables.map(row => `${database}/${row[1]}`)
  const identities = await query(`SELECT NAME, TABLE_ID FROM information_schema.${source}
    WHERE BINARY NAME IN (${keys.map(() => 'BINARY ?').join(',')}) ORDER BY BINARY NAME LIMIT ${inventoryLimit + 1}`, keys)
  if (identities.length !== keys.length || identities.some(([name, id]) => !name || !id || !keys.includes(name))) {
    throw new Error('Some table identities could not be verified. Reviewed removal excludes partitioned tables and tables whose dictionary names cannot be matched.')
  }
  return identities
}

export async function planMysqlAdministration(query: CatalogQuery, engine: Engine, change: AdministrationChange): Promise<NativePlan> {
  const [[database, observer, caseMode, serverId]] = await query('SELECT DATABASE(), CURRENT_USER(), @@lower_case_table_names, @@server_id')
  if (!observer || !caseMode || !serverId) throw new Error('Could not verify the connection scope for this review.')
  const scope = 'database' in change ? `${engineNames[engine]} server` : `Database · ${change.schema}`
  const plan: Plan = (sql, target, state, notes, verify) => ({
    database: database ?? '', observer, scope, sql, target, notes, verify,
    fingerprint: JSON.stringify([serverId, database, observer, caseMode, state])
  })

  if (!('database' in change)) return planTable(query, plan, engine, database, change)
  if (change.action === 'checkpoint-database') throw new Error('Checkpointing this database is unavailable.')
  if (change.action === 'rename-database') throw new Error('This engine has no native database rename operation.')
  if (!nameAllowed(change.database) || systemDatabase.test(change.database)) throw new Error('Use a non-system database name of at most 64 supported characters.')
  const lookup = caseMode === '0' ? 'BINARY SCHEMA_NAME = BINARY ?' : 'BINARY LOWER(SCHEMA_NAME) = BINARY LOWER(?)'
  const readDatabase = async () => (await query(`SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME
    FROM information_schema.SCHEMATA WHERE ${lookup}`, [change.database]))[0]
  const current = await readDatabase()
  if (change.action === 'create-database') {
    if (current) throw new Error('That database already exists. Choose an unused name.')
    const target = quoteIdentifier(change.database, engine)
    const expected = caseMode === '1' ? (await query('SELECT LOWER(?)', [change.database]))[0]?.[0] : change.database
    return plan(`CREATE DATABASE ${target};`, target, null, [
      'Creates a database with the server defaults. The server checks CREATE permission and rejects an existing name.',
      'This statement commits on a separate connection. The query tab cannot roll it back.'
    ], async () => (await readDatabase())?.[0] === expected)
  }

  const actual = current?.[0]
  if (!actual || !current) throw new Error('The database is missing or outside the visible catalog.')
  if (actual === database || caseMode !== '0' && actual.toLowerCase() === database?.toLowerCase()) {
    throw new Error('Use a connection to a different database before dropping this database.')
  }
  await proveDropVisibility(query, engine, observer)
  const dbCheck = caseMode === '0' ? 'BINARY DB = BINARY ?' : 'BINARY LOWER(DB) = BINARY LOWER(?)'
  if ((await query(`SELECT 1 FROM information_schema.PROCESSLIST WHERE ${dbCheck} LIMIT 1`, [actual])).length) {
    throw new Error('Close sessions using the target database before reviewing its removal.')
  }
  if ((await query(`SELECT 1 FROM information_schema.KEY_COLUMN_USAGE
    WHERE REFERENCED_TABLE_SCHEMA = ? AND BINARY REFERENCED_TABLE_SCHEMA = BINARY ?
      AND BINARY TABLE_SCHEMA <> BINARY ? LIMIT 1`, [actual, actual, actual])).length) {
    throw new Error('Another database has a foreign key referencing the target. Resolve the dependency before removal.')
  }
  const inventory = await databaseInventory(query, actual)
  const identities = await tableIdentities(query, engine, actual, inventory)
  const target = quoteIdentifier(actual, engine)
  const review = plan(`DROP DATABASE ${target};`, target, [current, inventory, identities], [
    `Permanently deletes the database and its data. The review found ${inventory.length} catalog objects. Verify that you have a usable backup.`,
    'The statement commits on a separate connection. Grants can remain after the database is removed.',
    'Other clients can race the final inventory check. The app does not disconnect clients. A session can access this database by a qualified name without selecting it.',
    ...(engine === 'mariadb' ? ['MariaDB can leave a partial drop if the operation fails. Check the catalog before trying again.'] : [])
  ], async () => !await readDatabase())
  return { ...review, missingObjects: async () => {
    if ((await readDatabase())?.[0] !== actual) return false
    const after = new Set((await databaseInventory(query, actual)).map(row => JSON.stringify(row.slice(0, 2))))
    return inventory.some(row => !after.has(JSON.stringify(row.slice(0, 2))))
  } }
}

async function planTable(query: CatalogQuery, plan: Plan, engine: Engine, database: string | null, change: Extract<AdministrationChange, { schema: string }>) {
  const { schema, table, action } = change
  if (action !== 'analyze-table' && action !== 'optimize-table' && action !== 'check-table') {
    throw new Error('This table operation is unavailable for the connected engine.')
  }
  if (schema !== database || systemDatabase.test(schema)) throw new Error('Select a table in the current user database.')
  const values = [schema, table, schema, table]
  const filter = 'TABLE_SCHEMA = ? AND TABLE_NAME = ? AND BINARY TABLE_SCHEMA = BINARY ? AND BINARY TABLE_NAME = BINARY ?'
  const read = async () => (await query(`SELECT ENGINE, TABLE_COLLATION, CAST(CREATE_TIME AS CHAR)
    FROM information_schema.TABLES WHERE ${filter} AND TABLE_TYPE = 'BASE TABLE'`, values))[0]
  const current = await read()
  if (current?.[0] !== 'InnoDB') throw new Error('Select a visible persistent InnoDB table.')
  const indexes = () => query(`SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART, NON_UNIQUE, INDEX_TYPE, COLLATION
    FROM information_schema.STATISTICS WHERE ${filter} ORDER BY BINARY INDEX_NAME, SEQ_IN_INDEX LIMIT ${inventoryLimit + 1}`, values)
  const reviewedIndexes = await indexes()
  if (reviewedIndexes.length > inventoryLimit) throw new Error(`This review supports up to ${inventoryLimit} index columns.`)
  const target = `${quoteIdentifier(schema, engine)}.${quoteIdentifier(table, engine)}`
  const [command, detail] = {
    'analyze-table': ['ANALYZE TABLE', 'Updates planner statistics. Query plans can change.'],
    'optimize-table': ['OPTIMIZE TABLE', 'May rebuild the table and its indexes. It can take locks and require additional disk space.'],
    'check-table': ['CHECK TABLE', 'Checks the table and indexes. Corrupt InnoDB pages can cause the server to stop. The app does not run a repair.']
  }[action]
  return plan(`${command} ${target};`, target, [current, reviewedIndexes], [
    detail,
    'The server checks permissions and reports the native result. The operation runs on a separate connection and may be written to the binary log.'
  ], async () => {
    const after = await read()
    // A native rebuild can change CREATE_TIME and the storage identity.
    const expected = action === 'optimize-table' ? current.slice(0, 2) : current
    return Boolean(after && JSON.stringify(after.slice(0, expected.length)) === JSON.stringify(expected) &&
      JSON.stringify(await indexes()) === JSON.stringify(reviewedIndexes))
  })
}

export function mysqlMaintenanceResult(rows: (string | null)[][], action: AdministrationChange['action'], table: string): AdministrationResult | undefined {
  if (action !== 'analyze-table' && action !== 'optimize-table' && action !== 'check-table') return
  const expected = { 'analyze-table': 'analyze', 'optimize-table': 'optimize', 'check-table': 'check' }[action]
  if (!rows.length || rows.some(row => row[0] !== table || row[1]?.toLowerCase() !== expected)) return
  if (rows.some(row => row[2]?.toLowerCase() === 'error' || row[2]?.toLowerCase() === 'warning')) {
    if (action === 'check-table') return { status: 'issues', message: 'The server reported integrity-check warnings or errors. Inspect the table before further maintenance.' }
    return
  }
  const last = rows.at(-1)
  if (last?.[2]?.toLowerCase() !== 'status') return
  if (last[3] === 'Table is already up to date') return { status: 'applied', message: 'The server reported that the table is already up to date.' }
  if (last[3] === 'OK') return { status: 'applied', message: 'The server reported OK for the reviewed table and the catalog target was verified.' }
}
