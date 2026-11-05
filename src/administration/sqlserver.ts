import type { CatalogQuery } from '../catalog/common'
import type { AdministrationChange } from '../shared/database-administration'
import { quoteIdentifier } from '../shared/sql/common'
import type { AdministrationPlan } from './reviews'

type NativePlan = AdministrationPlan & { verify(): Promise<boolean> }
type Plan = (sql: string, target: string, state: unknown, notes: string[], verify: NativePlan['verify']) => NativePlan
type Engine = 'sqlserver' | 'azure-sql'

export function sqlServerAdministrationDatabase(change: AdministrationChange, source: string) {
  return 'database' in change ? 'master' : source
}

export async function planSqlServerAdministration(query: CatalogQuery, engine: Engine, source: string, change: AdministrationChange): Promise<NativePlan> {
  const [context] = await query(`SELECT DB_NAME(), DB_ID(), SUSER_SNAME(), ORIGINAL_LOGIN(), USER_NAME(),
    CONVERT(int, SERVERPROPERTY('EngineEdition')), @@TRANCOUNT, @@OPTIONS`)
  const [database, databaseId, observer, login, user, edition, transactions, options] = context ?? []
  const logicalAzure = edition === '5'
  if (!['2', '3', '4', '5', '8'].includes(edition ?? '') || logicalAzure && engine !== 'azure-sql') {
    throw new Error('Use a supported SQL Server or Azure SQL Database connection profile for this server.')
  }
  if (!database || !databaseId || !observer || !login || !user || database !== sqlServerAdministrationDatabase(change, source) ||
    transactions !== '0' || !options || (Number(options) & 2) !== 0) {
    throw new Error('Could not verify the database, login and autocommit state of the administration connection.')
  }
  const plan: Plan = (sql, target, state, notes, verify) => ({
    database, observer, scope: 'database' in change ? (logicalAzure ? 'Azure SQL logical server · Billable database' : 'SQL Server instance') : `Database · ${database}`,
    target, sql, notes, verify, fingerprint: JSON.stringify([context, source, state])
  })
  if (!('database' in change)) return planTable(query, plan, database, change)
  if (engine === 'azure-sql' && change.action !== 'create-database') {
    throw new Error('Reviewed Azure SQL database rename and drop are unavailable.')
  }
  if (change.action === 'checkpoint-database') throw new Error('Checkpointing this database is unavailable.')
  return planDatabase(query, plan, source, logicalAzure, change)
}

function validateName(name: string) {
  if (name.length > 128 || name !== name.trim() || /^(master|model|msdb|tempdb|distribution|resource|mssqlsystemresource)$/i.test(name)) {
    throw new Error('Use a non-system database name of at most 128 characters without leading or trailing spaces.')
  }
}

async function planDatabase(query: CatalogQuery, plan: Plan, source: string, logicalAzure: boolean, change: Exclude<Extract<AdministrationChange, { database: string }>, { action: 'checkpoint-database' }>) {
  const { action, database } = change
  validateName(database)
  const read = async (name: string) => (await query(`SELECT d.name, d.database_id, CONVERT(nvarchar(30),d.create_date,126), d.state,
    d.source_database_id, d.user_access, d.is_read_only${logicalAzure ? '' : `, r.database_guid, d.replica_id, d.is_published,
    d.is_subscribed, d.is_merge_published, d.is_distributor, d.is_in_standby
    FROM sys.databases d LEFT JOIN sys.database_recovery_status r ON r.database_id=d.database_id`}
    ${logicalAzure ? 'FROM sys.databases d' : ''} WHERE d.name=@p1`, [name]))[0]
  const target = quoteIdentifier(database, 'sqlserver')
  const current = await read(database)
  const notes = [
    'Runs in autocommit on a separate master connection. It cannot be rolled back from this query tab.',
    'Other clients can change the catalog after the final check. The server still enforces its own permissions and name checks.'
  ]
  if (action === 'create-database') {
    if (current) throw new Error('That database already exists. Choose an unused name.')
    // Logical master can authorize database creation through its native
    // administrator and database manager roles, including Entra principals.
    // Do not mistake visibility of sys.databases for creation authority.
    if (!logicalAzure && (await query(`SELECT CASE WHEN IS_SRVROLEMEMBER('sysadmin')=1
      OR HAS_PERMS_BY_NAME(NULL,NULL,'CREATE ANY DATABASE')=1
      OR HAS_PERMS_BY_NAME(DB_NAME(),'DATABASE','CREATE DATABASE')=1 THEN 1 ELSE 0 END`))[0]?.[0] !== '1') {
      throw new Error('Creating a database requires the native database creation permission in master.')
    }
    notes.unshift(logicalAzure ? 'Creates a billable database using Azure SQL defaults. Azure must authorize the administrator or database manager.' :
      'Creates a database using SQL Server defaults, including the model database and server storage settings.')
    return plan(`CREATE DATABASE ${target};`, target, null, notes, async () => {
      const created = await read(database)
      return created?.[0] === database && created[3] === '0'
    })
  }

  if (logicalAzure) throw new Error('Reviewed Azure SQL database rename and drop are unavailable.')
  if ((await query("SELECT IS_SRVROLEMEMBER('sysadmin')"))[0]?.[0] !== '1') {
    throw new Error('Rename and drop require sysadmin in this workflow to verify instance-wide database use.')
  }
  const [name, id, , state, snapshot, access, readOnly, guid, replica, ...flags] = current ?? []
  const issuing = await read(source)
  if (!issuing?.[1]) throw new Error('Could not verify the issuing database in master.')
  if (id && id === issuing[1]) throw new Error('Use a connection to a different database before renaming or dropping this database.')
  if (!id || name !== database || Number(id) <= 4 || !guid || state !== '0' || snapshot !== null || access !== '0' || readOnly !== '0' ||
    replica !== null || flags.length !== 5 || flags.some(value => value !== '0')) {
    throw new Error('Choose an online writable user database without snapshots, replication, or restricted access.')
  }
  const [use] = await query(`SELECT CASE WHEN EXISTS (SELECT 1 FROM sys.dm_exec_sessions WHERE database_id=CONVERT(int,@p1))
    OR EXISTS (SELECT 1 FROM sys.dm_exec_requests WHERE database_id=CONVERT(int,@p1))
    OR EXISTS (SELECT 1 FROM sys.dm_tran_locks WHERE resource_database_id=CONVERT(int,@p1))
    OR EXISTS (SELECT 1 FROM sys.databases WHERE source_database_id=CONVERT(int,@p1))
    OR EXISTS (SELECT 1 FROM sys.database_mirroring WHERE database_id=CONVERT(int,@p1) AND mirroring_guid IS NOT NULL)
    THEN 1 ELSE 0 END`, [id])
  if (use?.[0] !== '0') throw new Error('Close connections and resolve locks, snapshots or mirroring on the target before reviewing this change.')
  const byIdentity = async () => (await query(`SELECT d.name FROM sys.databases d JOIN sys.database_recovery_status r ON r.database_id=d.database_id
    WHERE d.database_id=CONVERT(int,@p1) AND r.database_guid=CONVERT(uniqueidentifier,@p2)`, [id, guid]))[0]?.[0]
  if (action === 'rename-database') {
    validateName(change.destination)
    if (await read(change.destination)) throw new Error('The destination database name already exists.')
    const destination = quoteIdentifier(change.destination, 'sqlserver')
    notes.unshift('Renames the database without disconnecting users. Saved profiles keep their existing connection settings.')
    return plan(`ALTER DATABASE ${target} MODIFY NAME = ${destination};`, `${target} TO ${destination}`, current, notes,
      async () => await byIdentity() === change.destination && !(await read(database)))
  }
  notes.unshift('Permanently removes the database and its data without forcing disconnects. Verify that you have a usable backup.')
  return plan(`DROP DATABASE ${target};`, target, current, notes, async () => !(await byIdentity()) && !(await read(database)))
}

async function planTable(query: CatalogQuery, plan: Plan, database: string, change: Extract<AdministrationChange, { schema: string }>) {
  const { schema, table, action } = change
  if (action !== 'analyze-table' && action !== 'reindex-table') throw new Error('This table maintenance operation is unavailable on SQL Server.')
  validateName(database)
  const target = `${quoteIdentifier(schema, 'sqlserver')}.${quoteIdentifier(table, 'sqlserver')}`
  const read = async () => (await query(`SELECT t.object_id, CONVERT(nvarchar(30),t.create_date,126), t.schema_id, s.name, t.name,
    HAS_PERMS_BY_NAME(@p3,'OBJECT','ALTER'), CONVERT(nvarchar(30),t.modify_date,126)
    FROM sys.tables t JOIN sys.schemas s ON s.schema_id=t.schema_id
    WHERE s.name=@p1 AND t.name=@p2 AND t.is_ms_shipped=0 AND t.is_memory_optimized=0 AND t.temporal_type=0`, [schema, table, target]))[0]
  const current = await read(), id = current?.[0]
  if (!id || current[3] !== schema || current[4] !== table) throw new Error('Select a visible, ordinary persistent table in this database.')
  if (current[5] !== '1') throw new Error('Table maintenance requires ALTER permission on the selected table.')
  const shape = async () => action === 'reindex-table'
    ? query(`SELECT TOP (201) i.index_id, i.name, i.type, i.is_disabled, i.is_hypothetical, i.data_space_id, ds.type, i.has_filter
        FROM sys.indexes i LEFT JOIN sys.data_spaces ds ON ds.data_space_id=i.data_space_id
        WHERE i.object_id=CONVERT(int,@p1) AND i.index_id>0 ORDER BY i.index_id`, [id])
    : query(`SELECT TOP (201) stats_id, name, auto_created, user_created, has_filter
        FROM sys.stats WHERE object_id=CONVERT(int,@p1) ORDER BY stats_id`, [id])
  const reviewed = await shape()
  if (!reviewed.length || reviewed.length > 200) throw new Error('The selected table must have between one and 200 visible statistics or indexes for this operation.')
  if (action === 'reindex-table' && reviewed.some(row => !['1', '2'].includes(row[2] ?? '') || row[3] !== '0' ||
    row[4] !== '0' || row[6]?.trim() !== 'FG' || row[7] !== '0')) {
    throw new Error('Index rebuild requires enabled, unfiltered rowstore indexes on ordinary filegroups.')
  }
  const notes = action === 'reindex-table'
    ? ['Rebuilds all reviewed indexes offline. It can block reads and writes and use extra storage and transaction log space.']
    : ['Updates the existing statistics on this table using the server’s sampling defaults. Query plans can change.']
  notes.push('Runs in autocommit on a separate connection. The query tab’s transaction and results stay unchanged.')
  const command = action === 'reindex-table' ? `ALTER INDEX ALL ON ${target} REBUILD;` : `UPDATE STATISTICS ${target};`
  const storage = action === 'reindex-table' ? await query(`SELECT TOP (201) index_id, hobt_id
    FROM sys.partitions WHERE object_id=CONVERT(int,@p1) AND index_id>0 ORDER BY index_id, partition_number`, [id]) : []
  if (action === 'reindex-table' && (storage.length !== reviewed.length || storage.some((row, index) => row[0] !== reviewed[index][0] || !row[1]))) {
    throw new Error('Could not verify one native storage identity per reviewed index.')
  }
  return plan(command, target, [current, reviewed, storage], notes,
    async () => JSON.stringify((await read())?.slice(0, 6)) === JSON.stringify(current.slice(0, 6)) && JSON.stringify(await shape()) === JSON.stringify(reviewed))
}
