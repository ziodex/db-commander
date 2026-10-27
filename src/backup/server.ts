import { randomUUID } from 'node:crypto'
import oracledb from 'oracledb'
import type { ConnectionConfig } from '../shared/contracts'
import type { BackupRequest } from '../shared/backup'
import { openSqlServer, streamSqlServer } from '../driver/sqlserver-transport'
import { oracleConnectionOptions } from '../driver/oracle'
import { check, quoteIdentifier, quoteLiteral as lit, validateName, type BackupContext } from './context'

const bracket = (name: string) => '[' + name.replaceAll(']', ']]') + ']'
export async function sqlServerBackup(config: ConnectionConfig, request: BackupRequest, context: BackupContext) {
  const cloud = config.engine === 'azure-sql'
  const connection = await openSqlServer({ ...config, database: 'master' })
  const query = async (sql: string) => {
    check(context)
    const operation = streamSqlServer(connection, sql), rows: (string | null)[][] = []
    const cancel = () => operation.cancel()
    context.signal.addEventListener('abort', cancel, { once: true })
    try {
      for await (const frame of operation.frames) {
        if (frame.kind === 'error') throw frame.error
        if (frame.kind === 'row') { if (rows.length >= 2000) throw new Error('Backup metadata exceeded its limit.'); rows.push(frame.row) }
        if (frame.kind === 'notice') context.log(frame.message)
      }
      check(context); return rows
    } finally { context.signal.removeEventListener('abort', cancel) }
  }
  try {
    if (cloud) {
      const source = request.action === 'backup' ? config.database : request.artifact
      const target = request.action === 'backup' ? request.artifact : request.target!
      validateName(source, 128); validateName(target, 128)
      if ((await query(`SELECT name FROM sys.databases WHERE name=N${lit(target)}`)).length) throw new Error('The target database already exists. Choose a new name.')
      context.log(`Requesting Azure database copy ${source} → ${target}. This creates a separately billed database.`)
      await query(`CREATE DATABASE ${bracket(target)} AS COPY OF ${bracket(source)}`)
      context.log('Azure accepted the copy. Cancellation stops monitoring; the server copy may continue. Inspect the target in Azure before retrying.')
      while (true) {
        const state = (await query(`SELECT state_desc FROM sys.databases WHERE name=N${lit(target)}`))[0]?.[0]
        if (state === 'ONLINE') break
        if (state && state !== 'COPYING') throw new Error(`Azure copy is ${state}. Inspect the target in Azure.`)
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      return
    }
    if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(request.artifact)) throw new Error('Enter an absolute path on the SQL Server host.')
    if (request.action === 'backup') {
      // NOINIT never destroys media. Refuse files first; an external race can
      // at worst append another backup set, never overwrite existing backups.
      const exists = await query(`DECLARE @e INT; EXEC master.dbo.xp_fileexist N${lit(request.artifact)}, @e OUTPUT; SELECT @e;`)
      if (exists[0]?.[0] !== '0') throw new Error('The server backup file already exists or cannot be checked. Choose a new path.')
      context.log('Writing a COPY_ONLY database backup with checksums on the SQL Server host.')
      await query(`BACKUP DATABASE ${bracket(config.database)} TO DISK=N${lit(request.artifact)} WITH COPY_ONLY, CHECKSUM, NOINIT, STATS=10`)
      await query(`RESTORE VERIFYONLY FROM DISK=N${lit(request.artifact)} WITH CHECKSUM`)
    } else {
      validateName(request.target!, 128)
      if ((await query(`SELECT name FROM sys.databases WHERE name=N${lit(request.target!)}`)).length) throw new Error('The target database already exists. Choose a new name.')
      await query(`RESTORE VERIFYONLY FROM DISK=N${lit(request.artifact)} WITH CHECKSUM`)
      const files = await query(`RESTORE FILELISTONLY FROM DISK=N${lit(request.artifact)}`)
      if (!files.length || files.some(row => !['D', 'L'].includes(row[2] ?? ''))) throw new Error('This restore supports ordinary data and log files. FILESTREAM and special filegroups need server administration tools.')
      const paths = (await query("SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS NVARCHAR(4000)), CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS NVARCHAR(4000))"))[0]
      if (!paths?.[0] || !paths[1]) throw new Error('The server did not provide its default data/log directories.')
      const token = randomUUID().replaceAll('-', '')
      const moves = files.map((row, index) => {
        const base = paths[row[2] === 'L' ? 1 : 0]!, separator = base.includes('\\') ? '\\' : '/'
        const destination = base.replace(/[\\/]$/, '') + separator + `dbcommander_${token}_${index}.${row[2] === 'L' ? 'ldf' : 'mdf'}`
        return `MOVE N${lit(row[0]!)} TO N${lit(destination)}`
      })
      context.log(`Restoring to new database ${request.target}. Failure or cancellation may leave it in RESTORING state; inspect it before retrying.`)
      await query(`RESTORE DATABASE ${bracket(request.target!)} FROM DISK=N${lit(request.artifact)} WITH ${moves.join(', ')}, CHECKSUM, RECOVERY, STATS=10`)
    }
  } finally { connection.close() }
}

/** Data Pump runs on the server; no Oracle executable, wallet or password argv. */
export async function oracleBackup(config: ConnectionConfig, request: BackupRequest, context: BackupContext) {
  const directory = request.directory ?? '', source = request.sourceSchema ?? config.user.toUpperCase()
  if (!/^[A-Za-z][\w$#]{0,127}$/.test(directory) || !/^[\w.-]+\.dmp$/i.test(request.artifact)) throw new Error('Enter an Oracle DIRECTORY name and a simple .dmp filename (no path).')
  validateName(source, 128)
  const connection = await oracledb.getConnection(oracleConnectionOptions(config))
  connection.callTimeout = 15000
  let handle: number | undefined, completed = false
  const numericOut = () => ({ dir: oracledb.BIND_OUT, type: oracledb.NUMBER })
  const stringOut = () => ({ dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 16384 })
  try {
    check(context)
    if (request.action === 'restore') {
      const result = await connection.execute(`DECLARE info SYS.KU$_DUMPFILE_INFO; kind NUMBER; BEGIN DBMS_DATAPUMP.GET_DUMPFILE_INFO(:file, :dir, info, kind); :kind := kind; END;`, { file: request.artifact, dir: directory.toUpperCase(), kind: numericOut() })
      if ((result.outBinds as { kind: number }).kind !== 1) throw new Error('Choose an Oracle Data Pump dump file.')
      validateName(request.target!, 128)
      if ((await connection.execute('SELECT username FROM all_users WHERE username=:name', { name: request.target! })).rows?.length) throw new Error('The target schema already exists. Choose a new name.')
    }
    const jobName = 'SC_' + randomUUID().replaceAll('-', '').slice(0, 24).toUpperCase()
    const opened = await connection.execute(`BEGIN :h := DBMS_DATAPUMP.OPEN(:op, 'SCHEMA', job_name=>:job); END;`, { h: numericOut(), op: request.action === 'backup' ? 'EXPORT' : 'IMPORT', job: jobName })
    handle = (opened.outBinds as { h: number }).h
    context.log(`Oracle Data Pump job ${jobName}; dump and diagnostic log live in DIRECTORY ${directory}.`)
    await connection.execute(`BEGIN
      DBMS_DATAPUMP.ADD_FILE(:h, :file, :dir, filetype=>DBMS_DATAPUMP.KU$_FILE_TYPE_DUMP_FILE, reusefile=>0);
      DBMS_DATAPUMP.ADD_FILE(:h, :logfile, :dir, filetype=>DBMS_DATAPUMP.KU$_FILE_TYPE_LOG_FILE, reusefile=>0);
      DBMS_DATAPUMP.METADATA_FILTER(:h, 'SCHEMA_LIST', :filter);
      END;`, { h: handle, file: request.artifact, dir: directory.toUpperCase(), logfile: `${jobName}.log`, filter: lit(source) })
    if (request.action === 'backup') {
      if (request.content === 'schema') await connection.execute("BEGIN DBMS_DATAPUMP.DATA_FILTER(:h, 'INCLUDE_ROWS', 0); END;", { h: handle })
      else {
        const scn = (await connection.execute('SELECT DBMS_FLASHBACK.GET_SYSTEM_CHANGE_NUMBER FROM dual')).rows?.[0] as number[]
        await connection.execute("BEGIN DBMS_DATAPUMP.SET_PARAMETER(:h, 'FLASHBACK_SCN', :scn); END;", { h: handle, scn: scn[0] })
      }
    } else {
      // No authentication secret is generated or stored for the new schema.
      // Objects use the restoring administrator's default tablespace quota.
      const tablespace = String(((await connection.execute("SELECT property_value FROM database_properties WHERE property_name='DEFAULT_PERMANENT_TABLESPACE'")).rows?.[0] as string[])[0])
      check(context)
      await connection.execute(`CREATE USER ${quoteIdentifier(request.target!)} NO AUTHENTICATION DEFAULT TABLESPACE ${quoteIdentifier(tablespace)} QUOTA UNLIMITED ON ${quoteIdentifier(tablespace)}`)
      context.log(`Created schema-only account ${request.target}. Failed imports may leave partial objects and are never replayed.`)
      await connection.execute(`BEGIN
        DBMS_DATAPUMP.METADATA_REMAP(:h, 'REMAP_SCHEMA', :source, :target);
        DBMS_DATAPUMP.METADATA_TRANSFORM(:h, 'OID', 0);
        DBMS_DATAPUMP.METADATA_FILTER(:h, 'EXCLUDE_PATH_EXPR', 'IN (''USER'')');
        END;`, { h: handle, source, target: request.target! })
    }
    check(context)
    await connection.execute('BEGIN DBMS_DATAPUMP.START_JOB(:h); END;', { h: handle })
    let hasErrors = false
    while (true) {
      check(context)
      const result = await connection.execute(`DECLARE s KU$_STATUS; state VARCHAR2(100); i PLS_INTEGER; msg VARCHAR2(16000); BEGIN
        DBMS_DATAPUMP.GET_STATUS(:h, DBMS_DATAPUMP.KU$_STATUS_JOB_ERROR + DBMS_DATAPUMP.KU$_STATUS_JOB_STATUS, 1, state, s);
        IF BITAND(s.mask, DBMS_DATAPUMP.KU$_STATUS_JOB_ERROR) <> 0 THEN
          i := s.error.FIRST; WHILE i IS NOT NULL LOOP msg := SUBSTR(msg || s.error(i).LogText || CHR(10),1,15000); i := s.error.NEXT(i); END LOOP;
        END IF;
        :state := state; :messages := msg;
        END;`, { h: handle, state: stringOut(), messages: stringOut() })
      const status = result.outBinds as { state: string; messages: string | null }
      if (status.messages) { hasErrors = true; context.log(status.messages) }
      if (status.state === 'COMPLETED') { completed = true; if (hasErrors) throw new Error('Data Pump completed with errors. Inspect the server job log and target before using this backup or restore.'); break }
      if (status.state === 'STOPPED' || status.state === 'NOT RUNNING') throw new Error(`Data Pump job ${status.state}. Inspect the server job log.`)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  } finally {
    let stopError: unknown
    if (handle !== undefined) {
      if (!completed) await connection.execute('BEGIN DBMS_DATAPUMP.STOP_JOB(:h, immediate=>1, keep_master=>1); END;', { h: handle }).catch(error => { stopError = error })
      await connection.execute('BEGIN DBMS_DATAPUMP.DETACH(:h); END;', { h: handle }).catch(() => {})
    }
    await connection.close().catch(() => {})
    if (context.signal.aborted && stopError) throw Object.assign(new Error('Data Pump cancellation could not be confirmed. Inspect the server job and partial target before retrying.'), { outcomeUnknown: true })
  }
}
