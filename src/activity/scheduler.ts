import { randomUUID } from 'node:crypto'
import type { ActivityObserver } from './control'
import type { Cell, SessionInfo } from '../shared/contracts'
import { schedulerCaptureLimit, type ApplyScheduleChange, type ScheduleResult, type SchedulerEntry, type SchedulerSnapshot, type ScheduleReview } from '../shared/scheduler'

const limit = schedulerCaptureLimit + 1
const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
const integer = /^\d{1,10}$/
const oracleName = /^[A-Z][A-Z0-9_$#]{0,127}$/
const clean = (value: Cell | undefined, max = 128) => value?.slice(0, max) || null
const oracleLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`

type NativeTarget =
  | { engine: 'sqlserver'; kind: 'job' | 'schedule'; key: string; revision: string; uid: string; attachments: string }
  | { engine: 'oracle'; kind: 'job'; key: string; revision: string; owner: string; objectId: string; type: string }
type Capture = { snapshot: SchedulerSnapshot; targets: Map<string, NativeTarget> }
type Prepared = { review: ScheduleReview; target: NativeTarget; database: string }

function capture(scope: string, note: string, status: SchedulerSnapshot['status'] = 'available'): Capture {
  return { snapshot: { status, scope, note, capturedAt: new Date().toISOString(), truncated: false, entries: [] }, targets: new Map() }
}

function add(out: Capture, row: Omit<SchedulerEntry, 'id' | 'changeAllowed'>, target?: NativeTarget) {
  if (out.snapshot.entries.length >= schedulerCaptureLimit) { out.snapshot.truncated = true; return }
  if (!row.name) return
  const id = randomUUID()
  out.snapshot.entries.push({ id, ...row, changeAllowed: target !== undefined && row.enabled !== null })
  if (target && row.enabled !== null) out.targets.set(id, target)
}

function flag(value: Cell | undefined) {
  if (value === '1' || value === 'TRUE' || value === 'ENABLED') return true
  if (value === '0' || value === 'FALSE' || value === 'DISABLED') return false
  return null
}

const sqlJobs = `SELECT TOP (${limit}) CONVERT(varchar(36),job_id), name, SUSER_SNAME(owner_sid), CONVERT(varchar(12),enabled),
  CONVERT(varchar(12),version_number), CONVERT(varchar(12),originating_server_id),
  (SELECT COUNT_BIG(*) FROM msdb.dbo.sysjobschedules a WHERE a.job_id=j.job_id)
  FROM msdb.dbo.sysjobs j`
const sqlSchedules = `SELECT TOP (${limit}) CONVERT(varchar(12),schedule_id), name, SUSER_SNAME(owner_sid), CONVERT(varchar(12),enabled),
  CONVERT(varchar(12),version_number), CONVERT(varchar(12),originating_server_id), CONVERT(varchar(36),schedule_uid),
  (SELECT COUNT_BIG(*) FROM msdb.dbo.sysjobschedules a WHERE a.schedule_id=s.schedule_id)
  FROM msdb.dbo.sysschedules s`

async function sqlAgent(observer: ActivityObserver) {
  const [[edition] = []] = await observer.query("SELECT CONVERT(varchar(16), SERVERPROPERTY('EngineEdition'))")
  if (edition === '5') return capture('Current logical Azure SQL database', 'Azure SQL Database has no SQL Server Agent. Elastic Jobs is a separate service and is outside this inspector.', 'unsupported')
  if (!edition || !['2', '3', '8'].includes(edition)) return capture('SQL Server Agent', 'The connected engine edition does not expose supported SQL Server Agent controls.', 'unsupported')
  const out = capture('SQL Server Agent · server-wide msdb', 'Shows Agent definitions visible to this login. Enabled definitions do not establish that Agent is running. A shared schedule affects all its attached jobs.')
  const jobs = await observer.query(`${sqlJobs} ORDER BY name,job_id`)
  const schedules = await observer.query(`${sqlSchedules} ORDER BY name,schedule_id`)
  const jobLimit = Math.max(schedulerCaptureLimit - schedules.length, schedulerCaptureLimit / 2)
  const scheduleLimit = schedulerCaptureLimit - Math.min(jobs.length, jobLimit)
  out.snapshot.truncated = jobs.length > jobLimit || schedules.length > scheduleLimit
  for (const row of jobs.slice(0, jobLimit)) {
    const [key, name, owner, enabled, revision, origin, count] = row
    const target = key && guid.test(key) && revision && integer.test(revision) && origin === '0' && count && /^\d{1,19}$/.test(count)
      ? { engine: 'sqlserver', kind: 'job', key, uid: key, revision, attachments: count } as const : undefined
    add(out, { kind: 'job', name: clean(name) ?? '', owner: clean(owner), enabled: flag(enabled), state: 'Agent definition',
      schedule: count === null ? null : `${count} attached schedules`, lastRun: null, nextRun: null }, target)
  }
  for (const row of schedules.slice(0, scheduleLimit)) {
    const [key, name, owner, enabled, revision, origin, uid, count] = row
    const target = key && integer.test(key) && uid && guid.test(uid) && revision && integer.test(revision) && origin === '0' && count && /^\d{1,19}$/.test(count)
      ? { engine: 'sqlserver', kind: 'schedule', key, uid, revision, attachments: count } as const : undefined
    add(out, { kind: 'schedule', name: clean(name) ?? '', owner: clean(owner), enabled: flag(enabled), state: 'Agent definition',
      schedule: count === null ? null : `${count} attached jobs`, lastRun: null, nextRun: null }, target)
  }
  return out
}

const oracleJobs = `SELECT j.job_name,SYS_CONTEXT('USERENV','SESSION_USER'),j.enabled,j.state,
  j.schedule_type,j.schedule_owner,j.schedule_name,TO_CHAR(j.last_start_date,'YYYY-MM-DD HH24:MI:SS TZH:TZM'),
  TO_CHAR(j.next_run_date,'YYYY-MM-DD HH24:MI:SS TZH:TZM'),TO_CHAR(o.object_id),
  TO_CHAR(o.last_ddl_time,'YYYYMMDDHH24MISS'),j.job_type,j.destination,j.credential_name,u.oracle_maintained
  FROM user_scheduler_jobs j LEFT JOIN user_objects o ON o.object_name=j.job_name AND o.object_type='JOB'
  JOIN all_users u ON u.username=SYS_CONTEXT('USERENV','SESSION_USER')`

function oracleTarget(row: Cell[]): NativeTarget | undefined {
  const [key, owner, , state, scheduleType, , , , , objectId, revision, type, destination, credential, maintained] = row
  if (!key || !oracleName.test(key) || !owner || !oracleName.test(owner) || maintained !== 'N' || !objectId || !/^\d{1,20}$/.test(objectId) ||
    !revision || !/^\d{14}$/.test(revision) || destination || credential || !type || !['PLSQL_BLOCK', 'STORED_PROCEDURE'].includes(type) ||
    !scheduleType || !['ONCE', 'CALENDAR', 'NAMED'].includes(scheduleType) || !state || ['RUNNING', 'COMPLETED', 'REMOTE'].includes(state)) return
  return { engine: 'oracle', kind: 'job', key, owner, objectId, revision, type }
}

async function oracleScheduler(observer: ActivityObserver) {
  const out = capture('Oracle Scheduler · jobs owned by this account', 'Local eligible jobs can be enabled or disabled. Running jobs, external jobs and other schemas are outside these controls. Times are reported by Oracle with their offsets.')
  const rows = await observer.query(`${oracleJobs} ORDER BY j.job_name FETCH FIRST ${limit} ROWS ONLY`)
  for (const row of rows) {
    const [name, owner, enabled, state, scheduleType, scheduleOwner, scheduleName, lastRun, nextRun] = row
    add(out, { kind: 'job', name: clean(name) ?? '', owner: clean(owner), enabled: flag(enabled), state: clean(state) ?? 'Unreported',
      schedule: scheduleName ? [scheduleOwner, scheduleName].filter(Boolean).join('.').slice(0, 260) : clean(scheduleType),
      lastRun: clean(lastRun), nextRun: clean(nextRun) }, oracleTarget(row))
  }
  return out
}

async function mysqlScheduler(observer: ActivityObserver) {
  const [[scheduler] = []] = await observer.query('SELECT @@GLOBAL.event_scheduler')
  const runtime = scheduler && ['ON', 'OFF', 'DISABLED'].includes(scheduler) ? scheduler : 'unreported'
  const out = capture('Event Scheduler · current database', `Global scheduler is ${runtime}. Visible events are read-only here because altering one can change its definer. Times are the catalog values with the event’s time zone.`)
  const rows = await observer.query(`SELECT EVENT_NAME,DEFINER,STATUS,EVENT_TYPE,TIME_ZONE,CAST(LAST_EXECUTED AS CHAR),CAST(EXECUTE_AT AS CHAR)
    FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE() ORDER BY EVENT_NAME LIMIT ${limit}`)
  for (const [name, owner, state, type, zone, last, next] of rows) {
    add(out, { kind: 'event', name: clean(name) ?? '', owner: clean(owner, 288), enabled: flag(state), state: clean(state) ?? 'Unreported',
      schedule: [type, zone].filter(Boolean).join(' · ').slice(0, 128) || null,
      lastRun: clean(last), nextRun: type === 'ONE TIME' && flag(state) && !last ? clean(next) : null })
  }
  return out
}

export async function readScheduler(observer: ActivityObserver): Promise<Capture> {
  try {
    switch (observer.engine) {
      case 'sqlserver':
      case 'azure-sql': return await sqlAgent(observer)
      case 'oracle': return await oracleScheduler(observer)
      case 'mysql':
      case 'mariadb': return await mysqlScheduler(observer)
      default: return noScheduler(observer.engine)
    }
  } catch {
    return capture('Native scheduler', 'The scheduler catalog could not be read. Check engine availability and the login’s metadata permissions, then refresh.', 'unavailable')
  }
}

export function noScheduler(engine: SessionInfo['engine']) {
  return capture('Native scheduler', engine === 'postgres'
    ? 'PostgreSQL has no built-in job scheduler. Optional scheduler extensions and external services are outside this inspector.'
    : 'This embedded engine has no server job scheduler.', 'unsupported')
}

async function applySqlAgent(observer: ActivityObserver, target: Extract<NativeTarget, { engine: 'sqlserver' }>, enabled: boolean, dispatch: () => void) {
  const isJob = target.kind === 'job'
  const field = isJob ? 'job_id' : 'schedule_id'
  const value = isJob ? `'${target.key}'` : target.key
  const table = isJob ? 'sysjobs' : 'sysschedules'
  const identity = `${field}=${value}${isJob ? '' : ` AND schedule_uid='${target.uid}'`}`
  const revision = `version_number=${target.revision} AND enabled=${enabled ? 0 : 1}`
  const sql = `SET NOCOUNT ON; IF EXISTS (SELECT 1 FROM msdb.dbo.${table}
    WHERE ${identity} AND originating_server_id=0 AND ${revision}
      AND (SELECT COUNT_BIG(*) FROM msdb.dbo.sysjobschedules WHERE ${field}=${value})=${target.attachments})
    BEGIN
      DECLARE @result int;
      EXEC @result=msdb.dbo.sp_update_${target.kind} @${field}=${value}, @enabled=${enabled ? 1 : 0};
      SELECT CASE WHEN @result=0 THEN 'accepted' ELSE 'uncertain' END;
    END ELSE SELECT 'changed';`
  dispatch()
  const [[status] = []] = await observer.query(sql)
  if (status !== 'accepted') return status === 'changed' ? 'not-applied' : 'unknown'
  const [[actual] = []] = await observer.query(`SELECT CONVERT(varchar(12),enabled) FROM msdb.dbo.${table} WHERE ${identity}`)
  return flag(actual) === enabled ? 'completed' : 'unknown'
}

async function applyOracle(observer: ActivityObserver, target: Extract<NativeTarget, { engine: 'oracle' }>, enabled: boolean, dispatch: () => void) {
  const query = `${oracleJobs} WHERE j.job_name=${oracleLiteral(target.key)}`
  const rows = await observer.query(query), current = rows.length === 1 ? oracleTarget(rows[0]) : undefined
  if (!current || JSON.stringify(current) !== JSON.stringify(target) || flag(rows[0][2]) !== !enabled) return 'not-applied'
  const name = oracleLiteral(`"${target.owner}"."${target.key}"`)
  dispatch()
  await observer.query(enabled
    ? `BEGIN DBMS_SCHEDULER.ENABLE(name => ${name}); END;`
    : `BEGIN DBMS_SCHEDULER.DISABLE(name => ${name}, force => FALSE); END;`)
  const [row] = await observer.query(query)
  return row && row[9] === target.objectId && row[1] === target.owner && flag(row[2]) === enabled ? 'completed' : 'unknown'
}

export async function applySchedule(observer: ActivityObserver, { review, target }: Prepared, beforeDispatch: () => void): Promise<ScheduleResult> {
  let dispatched = false
  const dispatch = () => { beforeDispatch(); dispatched = true }
  let status: ScheduleResult['status']
  try {
    const enabled = review.action === 'enable'
    status = target.engine === 'sqlserver' ? await applySqlAgent(observer, target, enabled, dispatch) : await applyOracle(observer, target, enabled, dispatch)
  } catch (error) {
    if (!dispatched) throw error
    status = 'unknown'
  }
  return { status, message: {
    completed: 'The engine confirmed the new enabled state. Refresh to read the current scheduler definitions.',
    'not-applied': 'The reviewed scheduler definition changed or disappeared. No change was sent. Refresh before reviewing again.',
    unknown: 'The requested change could not be verified. Refresh and check the engine before preparing another change.'
  }[status] }
}

export class SchedulerReviews {
  private captures = new Map<string, { capture: Capture; expires: number; database: string }>()
  private reviews = new Map<string, Prepared>()
  constructor(private now = Date.now) {}

  forget(sessionId: string) {
    this.captures.delete(sessionId)
    this.reviews.delete(sessionId)
  }

  clear() { this.captures.clear(); this.reviews.clear() }

  remember(session: SessionInfo, result: Capture) {
    this.forget(session.id)
    if (result.targets.size) this.captures.set(session.id, { capture: result, expires: this.now() + 120_000, database: session.database })
    return result.snapshot
  }

  prepare(session: SessionInfo, targetId: string): ScheduleReview {
    this.reviews.delete(session.id)
    const remembered = this.captures.get(session.id)
    const target = remembered?.capture.targets.get(targetId)
    const entry = remembered?.capture.snapshot.entries.find(row => row.id === targetId)
    if (!remembered || remembered.database !== session.database || remembered.expires <= this.now() || !target || !entry || entry.enabled === null) throw new Error('Refresh the scheduler and choose an eligible definition.')
    const action = entry.enabled ? 'disable' : 'enable'
    const review: ScheduleReview = {
      id: randomUUID(), sessionId: session.id, engine: session.engine, connection: session.name,
      scope: remembered.capture.snapshot.scope, target: entry, action, confirmation: entry.enabled ? 'DISABLE' : 'ENABLE',
      expiresAt: new Date(this.now() + 60_000).toISOString()
    }
    this.reviews.set(session.id, { review: structuredClone(review), target, database: remembered.database })
    return structuredClone(review)
  }

  consume(request: ApplyScheduleChange) {
    const prepared = this.reviews.get(request.sessionId)
    if (!prepared || prepared.review.id !== request.reviewId) throw new Error('This scheduler review is no longer available. Refresh and review again.')
    this.forget(request.sessionId)
    if (Date.parse(prepared.review.expiresAt) <= this.now()) throw new Error('This scheduler review expired. Refresh and review again.')
    if (request.confirmation !== prepared.review.confirmation || !request.acknowledge) throw new Error('Acknowledge the scope and type the exact confirmation.')
    return prepared
  }
}
