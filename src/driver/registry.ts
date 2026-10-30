import { SessionQueryIndex } from './result-cache'
import { BackupJobs } from '../backup/jobs'
import { TransferJobs } from '../transfer/jobs'
import type { SessionAccess } from './session-access'
import { rollbackRequestSchema, type RollbackRequest } from '../shared/rollback'
import { RollbackInspections } from '../activity/rollback'
import { activityRequestSchema, type ActivityRequest, type ActivitySnapshot } from '../shared/activity'
import { localActivity } from '../activity/read'
import { ActivityReviews, readTarget, dispatchAction } from '../activity/control'
import { prepareActivityActionSchema, applyActivityActionSchema, activityControlLimit, type PrepareActivityAction, type ApplyActivityAction } from '../shared/activity-control'
import { dataCompareSchema, type DataCompareRequest, type DataComparison } from '../shared/data-compare'
import { compareData } from '../data/compare'
import { compareSchemaSchema, type CompareSchemaRequest } from '../shared/schema-compare'
import { compareSchemas } from '../schema/compare'
import { diagramRequestSchema, type DiagramRequest } from '../shared/diagram'
import { explainRequestSchema, planFormat, separatePlanConnection, type ExplainRequest, type ExplainResult } from '../shared/explain'
import { explainSql, explainStatement } from '../explain/sql'
import { isolatedPlan, PlanCollector, rawPlan } from '../explain/execution'
import { inspectObjectSchema, type InspectObjectRequest } from '../shared/catalog'
import { MAX_TABS, type ConnectionConfig, type RunRequest, type GridRequest, gridRequestSchema, connectionSchema, switchDatabaseSchema, type SwitchDatabaseRequest, type DatabaseCatalog } from '../shared/contracts'
import { type Completion, type DatabaseDriver, type Emit } from './driver'
import { OracleDriver } from './oracle'
import { PostgresDriver } from './postgres'
import { MysqlDriver } from './mysql'
import { SqlServerDriver } from './sqlserver'
import { SqliteDriver, type SqliteDriverOptions } from './sqlite'
import type { BackupJob, BackupRequest } from '../shared/backup'
import type { BackupOptions } from '../backup/tools'
import { randomUUID } from 'node:crypto'
import { importSourceSchema, type ImportSource, type TransferRequest, type TransferJob } from '../shared/transfer'
import { bindRequest } from './parameters'
import { SchemaChanges } from '../schema/changes'
import { MigrationExports } from '../schema/migrations'
import { prepareBuilderSchema, type PrepareBuilder } from '../shared/query-builder'
import { builderSql } from '../query-builder/sql'
import type { PrepareMigration, SaveMigration } from '../shared/migrations'
import { openTunnel, type Tunnel } from '../connections/ssh'
import { routed } from '../connections/transport'
import { SessionProtection } from '../connections/protection'
import { prepareSchemaChangeSchema, applySchemaChangeSchema, type PrepareSchemaChange, type ApplySchemaChange } from '../shared/schema-changes'

/** Routes opaque session/query IDs inside the utility process. */
export class DriverRegistry {
  private activityReads = new Map<string,Promise<ActivitySnapshot>>()
  private activityTargets = new Map<string,{ids:Set<string>;at:number}>()
  private activityReviews = new ActivityReviews()
  private activityActionPending = false
  private rollbackInspections = new RollbackInspections()
  private rollbackReads = new Set<string>()
  private drivers: Record<Exclude<ConnectionConfig['engine'], 'duckdb'>, DatabaseDriver> & { duckdb?: DatabaseDriver }
  private loadDuckdb: () => Promise<DatabaseDriver>
  private sessions = new Map<string, DatabaseDriver>()
  private queries = new Map<string, DatabaseDriver>()
  private latest = new SessionQueryIndex()
  private editing = new Map<string, Promise<unknown>>()
  private operations = new Map<string, Promise<unknown>>()
  private running = new Set<string>()
  private configs = new Map<string, ConnectionConfig>()
  private connecting = 0
  private explainControllers = new Map<string, AbortController>()
  private schemaChanges = new SchemaChanges()
  private migrations = new MigrationExports()
  private tunnels = new Map<string, Tunnel>()
  private protection = new SessionProtection()
  private emit: Emit
  private executionConsumers = new Map<string, Emit>()
  private backups: BackupJobs
  private transfers: TransferJobs
  constructor(emit: Emit, sqliteOptions?: SqliteDriverOptions, backupOptions: BackupOptions = {}, onBackup: (job: BackupJob) => void = () => {}, onTransfer: (job: TransferJob) => void = () => {}) {
    const originalEmit = emit
    this.emit = originalEmit
    const access: SessionAccess = {
      driver: id => this.driver(id),
      decorate: session => this.decorate(session),
      consume: (id, receive) => { this.executionConsumers.set(id, receive); return () => { this.executionConsumers.delete(id) } },
      config: id => this.configs.get(id)!,
      running: id => this.running.has(id),
      protect: id => this.protection.assert(id),
      operation: (id, action) => this.operation(id, action),
      wait: id => this.operations.get(id)
    }
    this.backups = new BackupJobs(access, backupOptions, onBackup)
    this.transfers = new TransferJobs(access, onTransfer)
    emit = event => 'queryId' in event && this.executionConsumers.has(event.queryId) ? this.executionConsumers.get(event.queryId)!(event) : originalEmit(event)
    this.drivers = { oracle: new OracleDriver(emit), postgres: new PostgresDriver(emit), mysql: new MysqlDriver(emit, 'mysql'), mariadb: new MysqlDriver(emit, 'mariadb'), sqlserver: new SqlServerDriver(emit), 'azure-sql': new SqlServerDriver(emit, 'azure-sql'), sqlite: new SqliteDriver(emit, sqliteOptions) }
    // A missing DLL/addon must not prevent workspace recovery or other engines.
    // Keep native loading inside an explicit DuckDB connection request.
    this.loadDuckdb = async () => {
      try {
        const { DuckDBDriver } = await import('./duckdb')
        return this.drivers.duckdb ??= new DuckDBDriver(emit)
      } catch (cause) {
        throw new Error('The DuckDB native library could not be loaded. Check that Db Commander is installed for this operating system and architecture, then restart the application.', { cause })
      }
    }
  }
  async inspectImport(input: ImportSource) {
    const request = importSourceSchema.parse(input), driver = this.driver(request.sessionId)
    if (this.running.has(request.sessionId)) throw new Error('Stop the running query before inspecting an import.')
    return this.operation(request.sessionId, async () => {
      const response = await driver.editGrid({ ...request, action: 'inspect-import' })
      if (response.error || !response.importPreview) throw new Error(response.error ?? 'Could not preview this import.')
      return response.importPreview
    })
  }
  startTransfer(input: TransferRequest) { return this.transfers.start(input) }
  listTransferJobs() { return this.transfers.list() }
  cancelTransfer(id: string) { return this.transfers.cancel(id) }
  discardTransferCapture(id: string) { return this.transfers.discardCapture(id) }
  waitTransfer(id: string) { return this.transfers.wait(id) }
  async connect(config: ConnectionConfig) {
    config = connectionSchema.parse(config)
    if (this.sessions.size + this.connecting >= MAX_TABS) throw new Error(`Up to ${MAX_TABS} database sessions can be open at once.`)
    this.connecting++
    try {
      const driver = this.drivers[config.engine] ?? (config.engine === 'duckdb' ? await this.loadDuckdb() : undefined)
      if (!driver) throw new Error('Unsupported database engine.')
      return await this.open(driver, config)
    } finally { this.connecting-- }
  }
  private async open(driver: DatabaseDriver, config: ConnectionConfig) {
    let id: string | undefined, tunnel: Tunnel | undefined
    try {
      if (config.ssh) {
        if (config.engine === 'oracle' && config.tls !== 'verify-full') throw new Error('Oracle SSH connections require verified TLS.')
        tunnel = await openTunnel(config, () => { if (id) void this.emit({ type: 'session-lost', sessionId: id, message: 'The SSH tunnel was lost. In-flight work may have an unknown outcome. Reconnect explicitly; nothing is replayed.' }) })
      }
      const active = tunnel ? routed(config, tunnel.address) : config
      const session = await driver.connect(active); id = session.id
      this.sessions.set(id, driver); this.configs.set(id, active); this.protection.add(id, config)
      if (tunnel) this.tunnels.set(id, tunnel)
      return this.decorate(session)
    } catch (error) { tunnel?.close(); throw error }
  }
  private decorate(session: import('../shared/contracts').SessionInfo) { return { ...session, safety: this.protection.status(session.id) } }
  sessionSafety(id: string) { this.driver(id, true).getSession(id); return this.protection.status(id) }
  unlockSession(id: string, confirmation: string) { this.driver(id).getSession(id); return this.protection.unlock(id, confirmation) }
  lockSession(id: string) { this.driver(id, true).getSession(id); return this.protection.lock(id) }
  private forgetConnection(id: string) { this.rollbackInspections.forget(id); this.activityTargets.delete(id);this.activityReviews.forget(id);this.tunnels.get(id)?.close(); this.tunnels.delete(id); this.protection.forget(id); this.sessions.delete(id); this.configs.delete(id); this.schemaChanges.forget(id); this.migrations.forget(id) }
  private driver(id: string, allowOperation = false) {
    if (!allowOperation && this.operations.has(id)) throw new Error('Wait for the database operation to finish.')
    if (this.editing.has(id)) throw new Error('Wait for the table edit operation to finish.')
    const driver = this.sessions.get(id)
    if (!driver) throw new Error('This session is disconnected. Reconnect to create a new session.')
    return driver
  }
  startBackup(input: BackupRequest) { return this.backups.start(input) }
  inspectBackup(input: BackupRequest) { return this.backups.inspect(input) }
  listBackupJobs() { return this.backups.list() }
  cancelBackup(id: string) { return this.backups.cancel(id) }
  waitBackup(id: string) { return this.backups.wait(id) }
  async disconnect(id: string) {
    if (this.operations.has(id)) throw new Error('Wait for the database operation to finish.')
    if (this.editing.has(id)) throw new Error('Wait for the table edit operation to finish.')
    const driver = this.sessions.get(id)
    if (!driver) return
    await this.operation(id, async () => { await this.activityReads.get(id)?.catch(()=>{}); await driver.disconnect(id) }); this.forgetConnection(id)
    for (const previous of this.latest.forget(id)) this.queries.delete(previous)
  }
  historyContext(id:string) {const session=this.getSession(id);return {connection:session.name,engine:session.engine,database:session.database,enabled:this.configs.get(id)?.recordHistory!==false}}
  start(request: RunRequest, completed?: (event: Completion) => void) {
    const driver = this.driver(request.sessionId)
    // Exact transaction settlement remains available after the unlock expires.
    if (!/^\s*(?:COMMIT|ROLLBACK)\s*;?\s*$/i.test(request.sql)) this.protection.assert(request.sessionId)
    if (this.running.has(request.sessionId)) throw new Error('Stop the running query first.')
    if (request.queryId && this.queries.has(request.queryId)) throw new Error('This execution ID is already in use.')
    this.running.add(request.sessionId)
    let queryId: string
    try { queryId = driver.start(request, event => { this.running.delete(request.sessionId); completed?.(event) }) }
    catch (error) { this.running.delete(request.sessionId); throw error }
    for (const previous of this.latest.replace(request.sessionId, queryId, request.viewId)) this.queries.delete(previous)
    this.queries.set(queryId, driver)
    return queryId
  }
  async editGrid(input: GridRequest) {
    const request = gridRequestSchema.parse(input), driver = this.driver(request.sessionId)
    if (this.running.has(request.sessionId)) throw new Error('Wait for the running query before using table data.')
    if (request.action === 'apply') this.protection.assert(request.sessionId)
    if (request.action === 'release') for (const previous of this.latest.forget(request.sessionId, request.viewId)) this.queries.delete(previous)
    const pending = driver.editGrid(request)
    this.editing.set(request.sessionId, pending)
    try { const result = await pending; return { ...result, session: this.decorate(result.session) } } finally { this.editing.delete(request.sessionId) }
  }
  private operation<T>(id: string, action: () => Promise<T>): Promise<T> {
    const pending = Promise.resolve().then(action)
    this.operations.set(id, pending)
    return pending.finally(() => { this.operations.delete(id) })
  }
  explain(input: ExplainRequest): Promise<ExplainResult> {
    const request = explainRequestSchema.parse(input), driver = this.driver(request.sessionId), session = driver.getSession(request.sessionId)
    this.protection.assert(session.id)
    if (this.running.has(session.id)) throw new Error('Stop the running query before explaining SQL.')
    if (['failed', 'unknown'].includes(session.transaction)) throw new Error('Resolve the transaction or reconnect before explaining SQL.')
    const sql = explainSql(request.sql, session.engine, session.mysqlSqlMode?.noBackslashEscapes, session.mysqlSqlMode?.ansiQuotes)
    // Compile the user's statement before adding trusted plan commands. The
    // public request never accepts native SQL/binds or generated execution flags.
    const { bound } = bindRequest({ sessionId: session.id, sql, parameters: request.parameters, maxRows: 2000 }, session.engine, session.mysqlSqlMode?.noBackslashEscapes, session.mysqlSqlMode?.ansiQuotes)
    if (request.mode === 'analyze' && session.engine !== 'postgres') throw new Error('Execution statistics are currently available only for PostgreSQL.')
    if (request.mode === 'analyze' && !request.executionConfirmed) throw new Error('Confirm that EXPLAIN ANALYZE executes SQL and can change data.')
    const controller = new AbortController(), signal = controller.signal, separate = separatePlanConnection(session.engine)
    this.explainControllers.set(session.id, controller)
    return this.operation(session.id, async () => {
      const started = performance.now(), submittedSql: string[] = [], config = { ...this.configs.get(session.id)!, database: session.database }
      const result: ExplainResult = { capturedAt: new Date().toISOString(), engine: session.engine, mode: request.mode, sql: request.sql, submittedSql, status: 'completed', message: '', durationMs: 0,
        session: this.decorate(session), source: separate ? 'separate-connection' : 'session', format: planFormat(session.engine), raw: '', output: { columns: [], rows: [] } }
      const timer = setTimeout(() => controller.abort(new Error('Plan exceeded 60 seconds; cancellation requested.')), 60000)
      try {
        signal.throwIfAborted()
        if (separate) result.output = await isolatedPlan(config, bound?.sql ?? sql, signal, submittedSql, bound?.values)
        else {
          const collector = new PlanCollector(), queryId = randomUUID()
          let completion: Completion | undefined, failure: unknown
          const cancel = () => { void driver.cancel(session.id).catch(() => {}) }
          this.executionConsumers.set(queryId, event => {
            if (failure) return
            try {
              if (event.type === 'result') { if (event.result.truncated) throw new Error('The database returned an incomplete plan.'); collector.columns(event.result.columns.map(column => column.name)) }
              if (event.type === 'rows') for (const row of event.rows) collector.row(row)
            } catch (error) { failure = error; cancel() }
          })
          signal.addEventListener('abort', cancel, { once: true })
          try {
            signal.throwIfAborted()
            const statement = explainStatement(bound?.sql ?? sql, session.engine, request.mode)
            submittedSql.push(statement)
            driver.start({ sessionId: session.id, queryId, sql: statement, bound: bound ? { sql: statement, values: bound.values } : undefined, maxRows: 2000, fullExport: true }, event => { completion = event })
            await driver.wait(session.id)
            if (failure) throw failure
            if (!completion || completion.status !== 'completed') throw Object.assign(new Error(completion?.error ?? 'Plan outcome unknown.'), { status: completion?.status ?? 'unknown' })
            result.output = collector.output
          } finally { this.executionConsumers.delete(queryId); signal.removeEventListener('abort', cancel) }
        }
        signal.throwIfAborted()
        result.raw = rawPlan(config, result.output)
        result.message = request.mode === 'analyze' ? 'SQL executed with profiling. Changes follow this tab’s transaction mode; no automatic rollback was performed.' : 'Estimated plan captured. The server planned the statement without running its normal execution path.'
      } catch (error) {
        const failure = error as Error & { status?: ExplainResult['status'] }
        result.status = failure.status === 'unknown' || /outcome unknown|disconnected|connection.*(?:closed|lost)|worker.*closed/i.test(failure.message) ? 'unknown' : signal.aborted || failure.status === 'cancelled' ? 'cancelled' : 'failed'
        result.message = signal.aborted ? String(signal.reason?.message ?? 'Plan cancelled. Inspect transaction state before continuing.') : bound ? `Parameterized plan ${result.status === 'unknown' ? 'outcome is unknown' : result.status}. Database diagnostics are hidden because they may contain parameter values. Check the SQL and parameter types, then inspect the transaction state before retrying.` : failure.message
        result.output = { columns: [], rows: [] }; result.raw = ''
      } finally {
        clearTimeout(timer); this.explainControllers.delete(session.id)
        result.durationMs = Math.round(performance.now() - started)
        try { result.session = this.decorate(driver.getSession(session.id)) } catch { result.session = { ...result.session, transaction: 'unknown' } }
      }
      return result
    })
  }
  cancelExplain(id: string) { const controller = this.explainControllers.get(id); controller?.abort(new Error('Plan cancellation requested. Inspect transaction state before continuing.')); return { requested: Boolean(controller) } }
  prepareSchemaChange(input: PrepareSchemaChange) {
    const request = prepareSchemaChangeSchema.parse(input), driver = this.driver(request.sessionId)
    if (this.running.has(request.sessionId)) throw new Error('Stop the running query before reviewing schema changes.')
    return this.operation(request.sessionId, async () => {
      const plan = await this.schemaChanges.prepare(request, driver)
      const session = driver.getSession(request.sessionId)
      // Migration exports retain host-generated SQL only. Authored source is
      // reviewed and executed here, but is not a generated migration source.
      if (request.change.action !== 'edit-source') plan.migrationSourceId = this.migrations.retainChange(plan, this.schemaChanges.migrationStatements(plan.id), `${session.name} / ${session.host}${session.port ? ':' + session.port : ''} / ${session.database}`)
      return plan
    })
  }
  prepareMigration(request: PrepareMigration) { return this.migrations.prepare(request) }
  inspectActivity(input:ActivityRequest):Promise<ActivitySnapshot> {
    const {sessionId,includeSql}=activityRequestSchema.parse(input), driver=this.driver(sessionId), selected=driver.getSession(sessionId)
    if(this.activityReads.has(sessionId)||this.activityReads.size+this.rollbackReads.size>=2) throw new Error('Wait for the current session inspection to finish (at most two inspections at once).')
    this.activityReviews.forget(sessionId);this.activityTargets.delete(sessionId)
    // Observers never use the query connection or own its execution slot. Stop,
    // transaction settlement and other tabs remain usable during catalog reads.
    const pending=Promise.resolve().then(async()=>{
      if(['sqlite','duckdb'].includes(selected.engine)) {
        const connections=[]
        for(const [id,adapter] of this.sessions) { try { const info=adapter.getSession(id);if(info.engine===selected.engine)connections.push({info,busy:this.running.has(id)||this.operations.has(id)||this.editing.has(id)}) } catch{} }
        return localActivity(selected.engine,selected,connections,includeSql)
      }
      if(!driver.activity)throw new Error('Session inspection is unavailable for this engine.')
      return driver.activity(sessionId,includeSql)
    }).then(snapshot=>{this.activityTargets.set(sessionId,{ids:new Set(snapshot.sessions.rows.map(r=>r.id)),at:Date.now()});return snapshot}).finally(()=>this.activityReads.delete(sessionId))
    this.activityReads.set(sessionId,pending);return pending
  }
  inspectRollback(input:RollbackRequest) {
    const request=rollbackRequestSchema.parse(input),driver=this.driver(request.sessionId),session=driver.getSession(request.sessionId)
    if(this.activityReads.has(session.id)||this.activityReads.size+this.rollbackReads.size>=2||this.activityActionPending)throw new Error('Wait for the current inspection or session action to finish.')
    if('targetId' in request) {
      const captured=this.activityTargets.get(session.id)
      if(!captured||Date.now()-captured.at>60000||!captured.ids.has(request.targetId))throw new Error('Refresh the inspector and select a visible session before inspecting rollback.')
    }
    this.rollbackReads.add(session.id)
    return this.operation(session.id,async()=>{
      const inspect=(observer:import('../activity/control').ActivityObserver)=>'targetId' in request?this.rollbackInspections.capture(observer,session,request.targetId):this.rollbackInspections.inspect(observer,session,request.inspectionId)
      if(['sqlite','duckdb'].includes(session.engine))return inspect({engine:session.engine,database:session.database,currentSessionId:session.id,query:async()=>{throw new Error('No embedded rollback diagnostics.')}})
      if(!driver.withActivity)throw new Error('Rollback inspection is unavailable.')
      return driver.withActivity(session.id,inspect)
    }).finally(()=>this.rollbackReads.delete(session.id))
  }
  prepareActivityAction(input:PrepareActivityAction) {
    const request=prepareActivityActionSchema.parse(input),driver=this.driver(request.sessionId),session=driver.getSession(request.sessionId)
    const unsupported=activityControlLimit(session.engine,request.action);if(unsupported)throw new Error(unsupported)
    const captured=this.activityTargets.get(session.id)
    if(!captured||Date.now()-captured.at>60000||!captured.ids.has(request.targetId))throw new Error('Refresh the inspector and select a visible session before reviewing an action.')
    if(this.activityReads.has(session.id)||this.activityActionPending)throw new Error('Wait for the current inspection or session action to finish.')
    if(!driver.withActivity)throw new Error('Session administration is unavailable.')
    return this.operation(session.id,()=>driver.withActivity!(session.id,async observer=>this.activityReviews.prepare(session,await readTarget(observer,request.targetId),request.action)))
  }
  private activityOwners(sourceId:string,targetId:string) {
    const source=this.configs.get(sourceId)!,family=(engine:string)=>engine==='azure-sql'?'sqlserver':engine
    const sourceDatabase=this.sessions.get(sourceId)!.getSession(sourceId).database
    const owners:string[]=[]
    for(const [id,driver] of this.sessions) {
      const config=this.configs.get(id)!
      if(family(config.engine)!==family(source.engine)||config.host!==source.host||config.port!==source.port||JSON.stringify(config.ssh)!==JSON.stringify(source.ssh))continue
      try{
        // Azure session IDs are database-scoped; an Oracle listener can serve
        // multiple instances/services with the same instance:SID combination.
        if((source.engine==='oracle'||source.engine==='azure-sql'||config.engine==='azure-sql')&&driver.getSession(id).database!==sourceDatabase)continue
        if(driver.activityId?.(id)===targetId)owners.push(id)
      }catch{}
    }
    return owners
  }
  applyActivityAction(input:ApplyActivityAction) {
    const request=applyActivityActionSchema.parse(input),retained=this.activityReviews.consume(request),driver=this.driver(request.sessionId)
    if(this.activityActionPending||this.activityReads.has(request.sessionId))throw new Error('Wait for the current inspection or session action to finish, then review again.')
    if(!driver.withActivity)throw new Error('Session administration is unavailable.')
    const ownedTargets=new Set<string>()
    const check=()=>{
      if(Date.now()>=Date.parse(retained.preview.expiresAt))throw new Error('This review expired during revalidation. No action was sent. Prepare a new review.')
      const session=driver.getSession(request.sessionId)
      if(session.database!==retained.preview.database)throw new Error('The issuing database changed. Prepare a new review.')
      this.protection.assert(request.sessionId)
      ownedTargets.clear()
      for(const id of this.activityOwners(request.sessionId,retained.target.id)) {
        if(id===request.sessionId)throw new Error('Use the owning tab’s controls for this session.')
        if(this.operations.has(id)||this.editing.has(id))throw new Error('The target has an active table, transfer or database operation. Use its owning tab to settle it first.')
        this.protection.assert(id)
        ownedTargets.add(id)
      }
    }
    check();this.activityActionPending=true
    return this.operation(request.sessionId,async()=>{
      const result=await driver.withActivity!(request.sessionId,async o=>{
        // Capture before dispatch, then let dispatchAction revalidate again. An
        // unavailable diagnostic must not prevent a separately authorized action.
        const rollback=await this.rollbackInspections.capture(o,driver.getSession(request.sessionId),retained.target.id,retained.target)
        const result=await dispatchAction(o,retained.preview.action,retained.target,check)
        return {...result,...(['requested','unknown'].includes(result.status)?{rollback:{...rollback,notices:[...rollback.notices,'These initial readings were captured before the reviewed command. Refresh rollback progress to read the current state.']}}:{})}
      })
      // Retire only application IDs recognized before dispatch. A newly opened
      // connection must never be matched to a recycled native ID afterward.
      if(retained.preview.action==='terminate'&&['requested','unknown'].includes(result.status))for(const id of ownedTargets)this.sessions.get(id)?.invalidateActivity?.(id)
      return result
    }).finally(()=>{this.activityActionPending=false;this.activityTargets.delete(request.sessionId)})
  }
  prepareQueryBuilder(input: PrepareBuilder) {
    const request = prepareBuilderSchema.parse(input), driver = this.driver(request.sessionId)
    if (this.running.has(request.sessionId)) throw new Error('Wait for the running query before reviewing builder SQL.')
    return this.operation(request.sessionId, async () => {
      const session = driver.getSession(request.sessionId)
      if (!session.database || session.transaction !== 'idle' || session.engine !== 'oracle' && session.autocommit === false) throw new Error('Select a database, commit or roll back and enable autocommit before reviewing builder SQL.')
      const snapshot = await driver.schema(request.sessionId)
      return builderSql(request.query, session.engine, snapshot)
    })
  }
  reviewedMigration(request: SaveMigration) { return this.migrations.reviewed(request) }
  applySchemaChange(input: ApplySchemaChange) {
    const request = applySchemaChangeSchema.parse(input), driver = this.driver(request.sessionId)
    this.protection.assert(request.sessionId)
    if (this.running.has(request.sessionId)) throw new Error('Stop the running query before applying schema changes.')
    return this.operation(request.sessionId, () => this.schemaChanges.apply(request, driver, async (sql, signal, singleUnit) => {
      const queryId = randomUUID()
      let completion: Completion | undefined, timedOut = false
      // Host-only streaming mode preserves the user's fetched result cache.
      // Generated DDL/control statements produce no result rows for the renderer.
      this.executionConsumers.set(queryId, async () => {})
      const cancel = () => { void driver.cancel(request.sessionId).catch(() => {}) }
      const timer = setTimeout(() => { timedOut = true; cancel() }, 60000)
      signal?.addEventListener('abort', cancel, { once: true })
      try {
        signal?.throwIfAborted()
        driver.start({ sessionId: request.sessionId, queryId, sql, maxRows: 1, fullExport: true, singleUnit }, event => { completion = event })
        await driver.wait(request.sessionId)
        if (!completion) throw Object.assign(new Error('Schema execution ended without a confirmed outcome.'), { status: 'unknown' })
        if (timedOut) { completion.error = 'The schema statement exceeded 60 seconds; cancellation was requested.'; if (completion.status === 'completed') completion.status = 'cancelled' }
        return completion
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); this.executionConsumers.delete(queryId) }
    }).then(result => ({ ...result, session: this.decorate(result.session) })))
  }
  cancelSchemaChange(id: string) { return this.schemaChanges.cancel(id) }
  databases(id: string): Promise<DatabaseCatalog> {
    const driver = this.driver(id), session = driver.getSession(id)
    return this.operation(id, () => driver.listDatabases ? driver.listDatabases(id) : Promise.resolve({
      databases: [session.database], current: session.database, switchable: false,
      notice: session.engine === 'oracle' ? 'Oracle requires a service/PDB endpoint. Open another connection to use a different service.' : 'Local databases use files and attached catalogs. Open another file in a new tab.'
    }))
  }
  async switchDatabase(input: SwitchDatabaseRequest) {
    const { sessionId: id, database } = switchDatabaseSchema.parse(input), driver = this.driver(id)
    const current = driver.getSession(id)
    if (!driver.listDatabases) throw new Error('Open a separate connection for this engine.')
    if (this.running.has(id)) throw new Error('Stop the running query before switching databases.')
    if (current.transaction !== 'idle' || current.autocommit === false) throw new Error('Commit or roll back and enable autocommit before switching databases.')
    if (database === current.database) return this.decorate(current)
    const config = { ...this.configs.get(id)!, database }
    return this.operation(id, async () => {
      await this.activityReads.get(id)?.catch(()=>{})
      // Keep the original session and its results until the target is usable.
      // The replacement temporarily needs one extra physical connection.
      const candidate = await this.open(driver, config)
      try {
        if (candidate.database !== database) throw new Error('The server opened a different database than requested.')
        if (!input.retainSource) await driver.disconnect(id)
      } catch (error) { await driver.disconnect(candidate.id).catch(() => {}); this.forgetConnection(candidate.id); throw error }
      if (!input.retainSource) {
        this.forgetConnection(id)
        for (const previous of this.latest.forget(id)) this.queries.delete(previous)
      }
      return candidate
    })
  }
  tables(id: string) { const driver = this.driver(id); return this.operation(id, () => driver.tables(id)) }
  schema(id: string) {
    const driver = this.driver(id)
    return this.operation(id, async () => {
      const schema = await driver.schema(id)
      try { schema.catalog = (await driver.explore(id)).catalog }
      catch (error) { schema.catalog = { objects: [], truncated: false, notice: `Extended catalog unavailable: ${(error as Error).message}. Refresh schema to retry.` } }
      return schema
    })
  }
  compareData(input: DataCompareRequest) {
    const request = dataCompareSchema.parse(input), ids = [...new Set([request.source.sessionId, request.target.sessionId])]
    const drivers = ids.map(id => {
      const driver = this.driver(id)
      if (this.running.has(id)) throw new Error('Wait for both queries to finish before comparing data.')
      return driver
    })
    const compare = () => compareData(request, drivers[0], drivers[ids.indexOf(request.target.sessionId)])
    let second: Promise<DataComparison> | undefined
    const first = this.operation(ids[0], () => second ?? compare())
    if (ids.length > 1) second = this.operation(ids[1], compare)
    return first
  }
  compareSchemas(input: CompareSchemaRequest) {
    const request = compareSchemaSchema.parse(input), ids = [...new Set([request.source.sessionId,request.target.sessionId])]
    const drivers = ids.map(id => {
      const driver = this.driver(id)
      if (this.running.has(id)) throw new Error('Wait for both queries to finish before comparing schemas.')
      return driver
    })
    const compare = async () => {
      const result = await compareSchemas(request, drivers[0], drivers[ids.indexOf(request.target.sessionId)])
      result.migrationSourceId = this.migrations.retainComparison(result)
      return result
    }
    // Claim both sessions synchronously, before any metadata awaits.
    let second: Promise<import('../shared/schema-compare').SchemaComparison> | undefined
    const first = this.operation(ids[0], () => second ?? compare())
    if (ids.length > 1) second = this.operation(ids[1], compare)
    return first
  }
  diagram(input: DiagramRequest) {
    const {sessionId,...scope}=diagramRequestSchema.parse(input),driver=this.driver(sessionId)
    if(this.running.has(sessionId))throw new Error('Wait for the query to finish before reading a diagram.')
    if(['failed','unknown'].includes(driver.getSession(sessionId).transaction))throw new Error('Resolve the transaction before reading a diagram.')
    return this.operation(sessionId,async()=>{const result=(await driver.explore(sessionId,undefined,scope)).diagram;if(!result)throw new Error('Diagram metadata is unavailable.');return result})
  }
  inspectObject(input: InspectObjectRequest) {
    const request = inspectObjectSchema.parse(input), driver = this.driver(request.sessionId)
    if (this.running.has(request.sessionId)) throw new Error('Wait for the query to finish before inspecting objects.')
    return this.operation(request.sessionId, async () => {
      const detail = (await driver.explore(request.sessionId, request.object)).detail
      if (!detail) throw new Error('The object definition is unavailable.')
      return detail
    })
  }
  cancel(id: string) { return this.driver(id, true).cancel(id) }
  getSession(id: string) { return this.decorate(this.driver(id).getSession(id)) }
  wait(id: string) { return this.driver(id, true).wait(id) }
  exportCsv(id: string, index: number, path: string) {
    const driver = this.queries.get(id)
    if (!driver) throw new Error('This result is no longer available. Execute the query again explicitly.')
    return driver.exportCsv(id, index, path)
  }
  async close() { await Promise.allSettled(this.activityReads.values()); await Promise.allSettled(this.operations.values()); await Promise.allSettled(this.editing.values()); await Promise.allSettled([this.transfers.close()]); await Promise.allSettled(Object.values(this.drivers).map(driver => driver.close())); for (const tunnel of this.tunnels.values()) tunnel.close(); this.tunnels.clear(); this.protection.clear(); this.activityTargets.clear(); this.activityReviews.clear(); this.rollbackInspections.clear(); this.migrations.clear(); this.sessions.clear(); this.queries.clear(); this.latest.clear(); this.configs.clear(); this.running.clear() }
}
