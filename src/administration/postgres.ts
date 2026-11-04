import type { CatalogQuery } from '../catalog/common'
import type { AdministrationChange } from '../shared/database-administration'
import { quoteIdentifier } from '../shared/sql/common'
import type { AdministrationPlan } from './reviews'

type NativePlan = AdministrationPlan & { verify(): Promise<boolean> }
type Plan = (sql: string, target: string, state: unknown, notes: string[], verify: NativePlan['verify']) => NativePlan

export async function planPostgresAdministration(query: CatalogQuery, change: AdministrationChange): Promise<NativePlan> {
  const [[database, databaseId, observer, actorId, version, maxBytes, superuser, createdb]] = await query(`SELECT
    current_database(), (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()),
    current_user, oid, current_setting('server_version_num'), current_setting('max_identifier_length'),
    rolsuper, rolcreatedb FROM pg_catalog.pg_roles WHERE rolname = current_user`)
  if (!database || !databaseId || !observer || !actorId) throw new Error('Could not verify the database and role for this review.')
  const plan: Plan = (sql, target, state, notes, verify) => ({
    database, observer, scope: 'database' in change ? 'PostgreSQL cluster' : `Database · ${database}`, sql, target, notes, verify,
    fingerprint: JSON.stringify([databaseId, database, actorId, observer, state])
  })
  if (!('database' in change)) return planTable(query, plan, Number(version), change)
  if (change.action === 'checkpoint-database') throw new Error('Checkpointing this database is unavailable.')

  function validateName(name: string) {
    if (Buffer.byteLength(name) > Number(maxBytes) || /^(?:postgres|template[01])$/i.test(name)) {
      throw new Error(`Use a non-system database name of at most ${maxBytes} UTF-8 bytes.`)
    }
  }
  const read = async (name: string) => (await query(`SELECT oid, datdba, datistemplate, datallowconn,
    pg_catalog.pg_has_role(datdba, 'USAGE') FROM pg_catalog.pg_database WHERE datname::text = $1`, [name]))[0]
  const byOid = async (id: string) => (await query('SELECT datname FROM pg_catalog.pg_database WHERE oid = $1::oid', [id]))[0]?.[0]
  const { database: target, action } = change
  validateName(target)
  const identifier = quoteIdentifier(target), current = await read(target)
  const notes = ['The app runs this statement on a separate connection. The query tab and its results stay open.',
    'Other clients can change the catalog between the final check and the statement. PostgreSQL still checks permissions and active connections.']
  if (action === 'create-database') {
    if (superuser !== 'true' && createdb !== 'true') throw new Error('Creating a database requires CREATEDB or a superuser.')
    if (current) throw new Error('That database already exists. Choose an unused name.')
    notes.unshift('Creates a database from the clean template0. PostgreSQL creates it outside a transaction block.')
    return plan(`CREATE DATABASE ${identifier} TEMPLATE template0;`, identifier, null, notes, async () => (await read(target))?.[1] === actorId)
  }

  if (target === database) throw new Error('Use a connection to a different database before renaming or dropping this database.')
  if (!current || current[2] === 'true' || current[3] !== 'true') throw new Error('Choose an existing, connectable database that is not a template.')
  const [oid, , , , owns] = current
  if (!oid || superuser !== 'true' && (owns !== 'true' || action === 'rename-database' && createdb !== 'true')) {
    throw new Error(action === 'rename-database' ? 'Renaming requires database ownership and CREATEDB, or a superuser.' : 'Dropping requires database ownership or a superuser.')
  }
  const [[active]] = await query(`SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datid = $1::oid`, [oid])
  const [[prepared]] = await query(`SELECT count(*) FROM pg_catalog.pg_prepared_xacts WHERE database::text = $1`, [target])
  if (active !== '0' || prepared !== '0') throw new Error('Close connections and resolve prepared transactions on the target database before reviewing this change.')

  if (action === 'rename-database') {
    const { destination } = change
    validateName(destination)
    if (await read(destination)) throw new Error('The destination database name already exists.')
    const quoted = quoteIdentifier(destination)
    notes.unshift('Commits the rename on a separate connection. Saved profiles and open SQL files keep their existing settings.')
    return plan(`ALTER DATABASE ${identifier} RENAME TO ${quoted};`, `${identifier} TO ${quoted}`, current, notes,
      async () => await byOid(oid) === destination && !(await read(target)))
  }

  notes.unshift('Permanently removes the database and its data. PostgreSQL executes the drop outside a transaction block and cannot roll it back.',
    'The drop does not terminate other connections. Verify that you have a usable backup.')
  return plan(`DROP DATABASE ${identifier};`, identifier, current, notes, async () => !(await byOid(oid)) && !(await read(target)))
}

async function planTable(query: CatalogQuery, plan: Plan, version: number, change: Extract<AdministrationChange, { schema: string }>) {
  const { schema, table, action } = change
  if (action === 'optimize-table' || action === 'check-table') throw new Error('This operation is unavailable on PostgreSQL.')
  const read = async () => (await query(`SELECT c.oid, c.relowner, pg_catalog.pg_has_role(c.relowner, 'USAGE'),
    pg_catalog.pg_has_role(d.datdba, 'USAGE'), ${version >= 170000 ? "pg_catalog.has_table_privilege(c.oid, 'MAINTAIN')" : 'false'}
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_database d ON d.datname = current_database()
    WHERE n.nspname::text = $1 AND c.relname::text = $2 AND c.relkind = 'r'
      AND c.relpersistence <> 't' AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhparent = c.oid)`, [schema, table]))[0]
  const current = await read()
  if (!current) throw new Error('Select a visible ordinary table in a user schema.')
  if (current[2] !== 'true' && current[4] !== 'true' && (action === 'reindex-table' || current[3] !== 'true')) {
    throw new Error('The catalog connection lacks permission for this table maintenance operation.')
  }
  const target = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`
  const command = {
    'analyze-table': ['ANALYZE', 'Updates planner statistics for this table. Query plans can change.'],
    'vacuum-table': ['VACUUM', 'Reclaims space for reuse in this table. Vacuum runs outside a transaction block and can take locks.'],
    'reindex-table': ['REINDEX TABLE', 'Rebuilds all indexes on this table. The rebuild can block reads and writes.']
  }[action]
  const indexes = async () => query(`SELECT indexrelid FROM pg_catalog.pg_index WHERE indrelid = $1::oid ORDER BY indexrelid`, [current[0]])
  const reviewedIndexes = action === 'reindex-table' ? await indexes() : []
  if (action === 'reindex-table' && !reviewedIndexes.length) throw new Error('This table has no indexes to rebuild.')
  return plan(`${command[0]} ${target};`, target, [current, reviewedIndexes], [
    command[1], 'The app uses a separate connection. The operation does not use the query tab’s transaction.'
  ], async () => (await read())?.[0] === current[0] &&
    (action !== 'reindex-table' || JSON.stringify(await indexes()) === JSON.stringify(reviewedIndexes)))
}
