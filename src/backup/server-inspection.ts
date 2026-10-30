import oracledb from 'oracledb'
import { openMysqlTransport } from '../driver/mysql-transport'
import { openSqlServer, streamSqlServer } from '../driver/sqlserver-transport'
import { oracleConnectionOptions } from '../driver/oracle'
import type { ConnectionConfig } from '../shared/contracts'
import type { BackupInspection, BackupRequest } from '../shared/backup'
import { quoteLiteral, validateName, type BackupContext } from './context'
import { openBackupPostgres } from './postgres'
import { header } from './files'

/** Metadata checks only: never CREATE, BACKUP, RESTORE DATABASE or Data Pump OPEN. */
export async function inspectBackupServer(config: ConnectionConfig, request: BackupRequest, context: BackupContext, result: BackupInspection, toolMajor?: number) {
  const metadata = (label: string, value: unknown) => result.metadata.push({ label, value: String(value ?? 'Not reported').slice(0, 1000) })
  if (config.engine === 'postgres') {
    const client = await openBackupPostgres(config, 15000)
    try {
      const version = Number((await client.query('SHOW server_version_num')).rows[0].server_version_num)
      if (toolMajor !== Math.floor(version / 10000)) throw new Error('Install native PostgreSQL tools matching the target server major version.')
      metadata('Server major version', toolMajor)
      if (request.action === 'restore') {
        validateName(request.target!, 63)
        if ((await client.query('SELECT datname FROM pg_database WHERE datname=$1', [request.target])).rows.length) throw new Error('The target database already exists. Choose a new name.')
        const role = (await client.query('SELECT rolsuper,rolcreatedb FROM pg_roles WHERE rolname=current_user')).rows[0]
        if (!role?.rolsuper && !role?.rolcreatedb) throw new Error('This login cannot create the new restore database.')
      }
    } finally { await client.end().catch(() => {}) }
    return
  }
  if (config.engine === 'mysql' || config.engine === 'mariadb') {
    const client = await openMysqlTransport(config)
    const cancel = () => client.destroy()
    context.signal.addEventListener('abort', cancel, { once: true })
    try {
      const version = String((await client.query('SELECT VERSION()'))[0][0])
      if (Number(version.split('.')[0]) !== toolMajor || /mariadb/i.test(version) !== (config.engine === 'mariadb')) throw new Error('Install native client tools matching the server engine and major version.')
      metadata('Server version', version)
      if (request.action === 'restore') {
        validateName(request.target!, 64)
        const source = JSON.parse((await header(request.artifact)).toString().split('\n')[0].replace(/^-- (?:Db Commander|SQLCommander) /, ''))
        if (Number(String(source.version).split('.')[0]) !== toolMajor) throw new Error('The SQL dump major version does not match this server.')
        if ((await client.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [request.target])).length) throw new Error('The target database already exists. Choose a new name.')
      } else if (request.content === 'all') {
        if ((await client.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE' AND ENGINE<>'InnoDB' LIMIT 1", [config.database])).length) throw new Error('A consistent online backup requires all tables to use InnoDB.')
      }
      result.checks.push({ label: 'Server permissions', status: 'warning', detail: 'Only visible catalog objects were inspected. Dump/create/import privileges and concurrent changes are checked again by the operation.' })
    } finally { context.signal.removeEventListener('abort', cancel); await client.end().catch(() => {}) }
    return
  }
  if (config.engine === 'sqlserver' || config.engine === 'azure-sql') {
    const client = await openSqlServer({ ...config, database: 'master' })
    const query = async (sql: string) => {
      context.signal.throwIfAborted()
      const operation = streamSqlServer(client, sql), rows: (string | null)[][] = []
      const cancel = () => operation.cancel()
      context.signal.addEventListener('abort', cancel, { once: true })
      try {
        for await (const frame of operation.frames) {
          if (frame.kind === 'error') throw frame.error
          if (frame.kind === 'row') { if (rows.length >= 200) throw new Error('Backup metadata exceeded its preview limit.'); rows.push(frame.row) }
        }
        context.signal.throwIfAborted(); return rows
      } finally { context.signal.removeEventListener('abort', cancel) }
    }
    try {
      if (config.engine === 'azure-sql') {
        const source = request.action === 'backup' ? config.database : request.artifact, target = request.action === 'backup' ? request.artifact : request.target!
        validateName(source, 128); validateName(target, 128)
        if ((await query(`SELECT name FROM sys.databases WHERE name=N${quoteLiteral(target)}`)).length) throw new Error('The target database already exists. Choose a new name.')
        const sourceState = (await query(`SELECT state_desc FROM sys.databases WHERE name=N${quoteLiteral(source)}`))[0]?.[0]
        if (sourceState !== 'ONLINE') throw new Error('The source recovery database must be visible and ONLINE.')
        metadata('Source database state', sourceState)
        result.checks.push({ label: 'Azure copy', status: 'warning', detail: 'This creates a separately billed database. Azure permissions and copy completion are checked by the operation; this is not an offline backup or point-in-time restore.' })
      } else {
        if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(request.artifact)) throw new Error('Enter an absolute path on the SQL Server host.')
        if (request.action === 'backup') {
          const exists = await query(`DECLARE @e INT; EXEC master.dbo.xp_fileexist N${quoteLiteral(request.artifact)}, @e OUTPUT; SELECT @e;`)
          if (exists[0]?.[0] !== '0') throw new Error('The server backup file already exists or cannot be checked. Choose a new path.')
        } else {
          validateName(request.target!, 128)
          if ((await query(`SELECT name FROM sys.databases WHERE name=N${quoteLiteral(request.target!)}`)).length) throw new Error('The target database already exists. Choose a new name.')
          const files = await query(`RESTORE FILELISTONLY FROM DISK=N${quoteLiteral(request.artifact)}`)
          if (!files.length || files.some(row => !['D', 'L'].includes(row[2] ?? ''))) throw new Error('This restore supports ordinary data/log files only.')
          metadata('Data and log files', files.length)
          metadata('Logical files', files.map(row => row[0]).join(', '))
        }
        result.checks.push({ label: 'Server location', status: 'warning', detail: 'The path belongs to the SQL Server service account. Its directory write access and backup checksums are verified by the job; this check does not browse your computer.' })
      }
    } finally { client.close() }
    return
  }
  if (config.engine === 'oracle') {
    const directory = request.directory ?? '', source = request.sourceSchema ?? config.user.toUpperCase()
    if (!/^[A-Za-z][\w$#]{0,127}$/.test(directory) || !/^[\w.-]+\.dmp$/i.test(request.artifact)) throw new Error('Enter an Oracle DIRECTORY name and a simple .dmp filename without a path.')
    validateName(source, 128)
    const client = await oracledb.getConnection(oracleConnectionOptions(config)); client.callTimeout = 15000
    try {
      const directories = (await client.execute('SELECT directory_path FROM all_directories WHERE directory_name=:name', { name: directory.toUpperCase() })).rows
      if (!directories?.length) throw new Error('The Oracle DIRECTORY is not visible to this login.')
      metadata('Server directory', (directories[0] as string[])[0])
      if (request.action === 'restore') {
        validateName(request.target!, 128)
        if ((await client.execute('SELECT username FROM all_users WHERE username=:name', { name: request.target! })).rows?.length) throw new Error('The target schema already exists. Choose a new name.')
        const dump = await client.execute('DECLARE info SYS.KU$_DUMPFILE_INFO; kind NUMBER; BEGIN DBMS_DATAPUMP.GET_DUMPFILE_INFO(:file,:dir,info,kind); :kind:=kind; END;', { file: request.artifact, dir: directory.toUpperCase(), kind: { dir: oracledb.BIND_OUT, type: oracledb.NUMBER } })
        if ((dump.outBinds as { kind: number }).kind !== 1) throw new Error('Choose an Oracle Data Pump dump file.')
        metadata('Dump format', 'Oracle Data Pump')
      }
      result.checks.push({ label: 'Oracle permissions', status: 'warning', detail: 'DIRECTORY visibility is confirmed. Data Pump, file access and CREATE USER permissions are checked at execution; restoring creates a schema-only account, not a new login.' })
    } finally { await client.close().catch(() => {}) }
  }
}
