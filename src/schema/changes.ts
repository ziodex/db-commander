import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseDriver, Completion } from '../driver/driver'
import { objectKey, type CatalogObject, type ObjectDetail } from '../shared/catalog'
import type { SessionInfo } from '../shared/contracts'
import { applySchemaChangeSchema, prepareSchemaChangeSchema, type ApplySchemaChange, type PrepareSchemaChange, type SchemaChange, type SchemaChangePlan, type SchemaChangeResult } from '../shared/schema-changes'
import { schemaSql } from './sql'

interface RetainedPlan { request: PrepareSchemaChange; review: SchemaChangePlan; generated: ReturnType<typeof schemaSql>; fingerprint?: string; referenceFingerprints: Record<string, string> }
type Execute = (sql: string, signal?: AbortSignal) => Promise<Completion>
type CatalogSession = Pick<DatabaseDriver, 'getSession' | 'explore'>
function ready(session: SessionInfo) {
  if (session.transaction !== 'idle' || session.engine !== 'oracle' && session.autocommit === false) throw new Error('Commit or roll back and enable autocommit before reviewing or applying schema changes.')
  if (!session.database) throw new Error('Select a database before changing its schema.')
}
function fingerprint(detail: ObjectDetail) {
  if (detail.definition.truncated || detail.sections.some(section => section.truncated)) throw new Error('This object’s metadata is incomplete. Use explicit SQL after reviewing the complete schema.')
  return createHash('sha256').update(JSON.stringify([detail.object, detail.sections, detail.definition.sql])).digest('hex')
}
function referencedTables(change: SchemaChange): CatalogObject[] {
  const constraints = change.action === 'create-table' ? change.constraints ?? [] : change.action === 'add-constraint' || change.action === 'replace-constraint' ? [change.constraint] : []
  const references = new Map<string, CatalogObject>()
  for (const constraint of constraints) if (constraint.kind === 'foreign' && constraint.reference.kind === 'table') {
    if (constraint.reference.table.kind !== 'table') throw new Error('A foreign key must reference a visible base table.')
    references.set(objectKey(constraint.reference.table), constraint.reference.table)
  }
  return [...references.values()]
}
export class SchemaChanges {
  private plans = new Map<string, RetainedPlan>()
  private controllers = new Map<string, AbortController>()
  migrationStatements(planId: string) { return [...this.plans.get(planId)!.generated.commands] }
  forget(sessionId: string) { for (const [id, plan] of this.plans) if (plan.review.sessionId === sessionId) this.plans.delete(id) }
  async prepare(input: PrepareSchemaChange, driver: CatalogSession): Promise<SchemaChangePlan> {
    const request = prepareSchemaChangeSchema.parse(input), session = driver.getSession(request.sessionId)
    ready(session)
    const detail = 'target' in request.change ? (await driver.explore(session.id, request.change.target)).detail : undefined
    if ('target' in request.change && !detail) throw new Error('The target is no longer available. Refresh the schema.')
    const references = new Map<string, ObjectDetail>(), referenceFingerprints: Record<string, string> = {}
    for (const table of referencedTables(request.change)) {
      const reference = (await driver.explore(session.id, table)).detail
      if (!reference) throw new Error('A referenced table is no longer available. Refresh the schema.')
      const key = objectKey(table); references.set(key, reference); referenceFingerprints[key] = fingerprint(reference)
    }
    const signature = detail ? fingerprint(detail) : undefined, generated = schemaSql(request.change, session, detail, references)
    const review: SchemaChangePlan = { id: randomUUID(), sessionId: session.id, engine: session.engine, database: session.database, connection: session.name, sql: generated.sql, transaction: generated.transaction, destructive: generated.destructive, warnings: generated.warnings, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }
    this.forget(session.id)
    for (const [id, plan] of this.plans) if (Date.parse(plan.review.expiresAt) < Date.now()) this.plans.delete(id)
    // At most one bounded plan per connected tab; defensive cap for direct callers.
    while (this.plans.size >= 20) this.plans.delete(this.plans.keys().next().value!)
    this.plans.set(review.id, { request, review, generated, fingerprint: signature, referenceFingerprints })
    return structuredClone(review)
  }
  cancel(sessionId: string) {
    const controller = this.controllers.get(sessionId)
    if (!controller) return { requested: false }
    controller.abort(new Error('Cancellation requested.'))
    return { requested: true }
  }
  async apply(input: ApplySchemaChange, driver: CatalogSession, execute: Execute): Promise<SchemaChangeResult> {
    const request = applySchemaChangeSchema.parse(input), session = driver.getSession(request.sessionId), plan = this.plans.get(request.planId)
    ready(session)
    if (!plan || plan.review.sessionId !== session.id || plan.review.database !== session.database || Date.parse(plan.review.expiresAt) <= Date.now()) throw new Error('This review expired or belongs to another session. Review the SQL again.')
    if (plan.review.destructive && !request.destructiveApproved) throw new Error('Acknowledge the destructive change before applying it.')
    if (plan.review.transaction === 'implicit-commit' && !request.implicitCommitApproved) throw new Error('Acknowledge the implicit commit before applying this change.')
    this.plans.delete(request.planId) // A consumed plan is never replayed, including after failure.
    const controller = new AbortController(), started = performance.now(), executed: string[] = []
    this.controllers.set(session.id, controller)
    let begun = false, dispatched = false, schemaDispatched = false
    const response = (status: SchemaChangeResult['status'], message: string): SchemaChangeResult => {
      let current: SessionInfo
      try { current = driver.getSession(session.id) } catch { current = { ...session, transaction: 'unknown' } }
      return { status, message, session: current, executedSql: executed.map(sql => sql + ';').join('\n\n'), durationMs: Math.round(performance.now() - started) }
    }
    async function run(sql: string, rollback = false) {
      if (!rollback) controller.signal.throwIfAborted()
      executed.push(sql); dispatched = true
      const event = await execute(sql, rollback ? undefined : controller.signal)
      if (event.status !== 'completed') throw Object.assign(new Error(event.error ?? `Schema statement ${event.status}.`), { status: event.status })
    }
    try {
      if ('target' in plan.request.change) {
        const current = (await driver.explore(session.id, plan.request.change.target)).detail
        if (!current || fingerprint(current) !== plan.fingerprint) throw new Error('The object changed after review. Refresh the schema and review the SQL again.')
      }
      for (const table of referencedTables(plan.request.change)) {
        const current = (await driver.explore(session.id, table)).detail
        if (!current || fingerprint(current) !== plan.referenceFingerprints[objectKey(table)]) throw new Error('A referenced table changed after review. Refresh the schema and review the SQL again.')
      }
      controller.signal.throwIfAborted(); ready(driver.getSession(session.id))
      if (plan.generated.begin) { begun = true; await run(plan.generated.begin) }
      for (const sql of plan.generated.commands) { controller.signal.throwIfAborted(); schemaDispatched = true; await run(sql) }
      if (begun) {
        controller.signal.throwIfAborted()
        if (driver.getSession(session.id).transaction !== 'transaction') return response('unknown', 'The transaction ended unexpectedly. Inspect the database before retrying; nothing will be replayed.')
        return response('completed', 'Schema change applied in this tab’s transaction. Close this dialog, then Commit or Rollback. Other connections see it after commit.')
      }
      return response('completed', 'Schema change completed and committed by the database. It cannot be rolled back.')
    } catch (error) {
      const failure = error as Error & { status?: string }, cancelled = controller.signal.aborted || failure.status === 'cancelled'
      let unknown = failure.status === 'unknown'
      try { unknown ||= driver.getSession(session.id).transaction === 'unknown' } catch { unknown = true }
      if (begun && !unknown) {
        try {
          // DDL triggers or server settings can end a transaction themselves.
          // An idle session alone does not prove that the failed DDL rolled back.
          if (schemaDispatched && driver.getSession(session.id).transaction === 'idle') throw new Error('The transaction ended before rollback could be confirmed.')
          if (driver.getSession(session.id).transaction !== 'idle') await run('ROLLBACK', true)
          if (driver.getSession(session.id).transaction !== 'idle') throw new Error('Rollback was not confirmed.')
          return response(cancelled ? 'cancelled' : 'failed', `${failure.message} The schema-change transaction was rolled back.`)
        } catch { unknown = true }
      }
      if (!dispatched) return response(cancelled ? 'cancelled' : 'failed', `${failure.message} No schema SQL was executed.`)
      if (unknown || !plan.generated.begin && cancelled) return response('unknown', `${failure.message} The outcome is unknown. Reconnect if needed and inspect the target before retrying; nothing will be replayed.`)
      return response(cancelled ? 'cancelled' : 'failed', `${failure.message}${plan.generated.begin ? '' : ' DDL can commit implicitly even on error. Inspect the target before retrying.'}`)
    } finally { this.controllers.delete(session.id) }
  }
}
