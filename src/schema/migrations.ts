import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseEngine } from '../shared/contracts'
import type { SchemaChangePlan } from '../shared/schema-changes'
import { transactionalDdl } from '../shared/schema-changes'
import { sqlComment, type SchemaComparison } from '../shared/schema-compare'
import { prepareMigrationSchema, saveMigrationSchema, type PrepareMigration, type SaveMigration, type MigrationPreview } from '../shared/migrations'

interface Unit { key: string; title: string; statements: string[]; destructive: string[]; notes: string[] }
interface Source { engine: DatabaseEngine; sessions: string[]; target: string; captured: string; expires: number; units: Unit[]; notes: string[]; requiresAutocommit?: boolean }
const ttl = 10 * 60_000, fileLimit = 1_000_000

/** Retain host-generated statements, never renderer-supplied SQL or filesystem paths. */
export class MigrationExports {
  private sources = new Map<string, Source>()
  private drafts = new Map<string, { preview: MigrationPreview; sourceId: string }>()
  private prune() {
    for (const [id, source] of this.sources) if (source.expires <= Date.now()) this.sources.delete(id)
    for (const [id, draft] of this.drafts) if (!this.sources.has(draft.sourceId) || Date.parse(draft.preview.expiresAt) <= Date.now()) this.drafts.delete(id)
  }
  forget(sessionId: string) {
    for (const [id, source] of this.sources) if (source.sessions.includes(sessionId)) this.sources.delete(id)
    this.prune()
  }
  clear() { this.sources.clear(); this.drafts.clear() }
  private retain(id: string, source: Source) {
    this.prune()
    const bytes = (s: Source) => Buffer.byteLength(JSON.stringify(s))
    if (bytes(source) > 8_000_000) return undefined
    while (this.sources.size >= 20 || [...this.sources.values()].reduce((n,s) => n + bytes(s), 0) + bytes(source) > 16_000_000) this.sources.delete(this.sources.keys().next().value!)
    this.sources.set(id, structuredClone(source)); this.prune(); return id
  }
  retainChange(plan: SchemaChangePlan, commands: string[], target = `${plan.connection} / ${plan.database}`) {
    return this.retain(plan.id, { engine: plan.engine, sessions: [plan.sessionId], target, captured: new Date().toISOString(), expires: Date.parse(plan.expiresAt), requiresAutocommit: plan.transaction === 'nontransactional',
      units: [{ key: 'change', title: 'Guided schema change', statements: plan.destructive ? [] : commands, destructive: plan.destructive ? commands : [], notes: [] }],
      // The interactive review's automatic rollback/leave-open promises do not apply to an external runner.
      notes: plan.warnings.slice(1) })
  }
  retainComparison(result: SchemaComparison) {
    return this.retain(randomUUID(), { engine: result.engine, sessions: [result.source.sessionId, result.target.sessionId], target: result.targetLabel, captured: result.fetchedAt, expires: Date.now() + ttl,
      units: result.objects.filter(o => !['matching','unknown'].includes(o.status)).map(o => ({ key: o.key, title: `${o.status}: ${o.kind} ${o.name}`, statements: o.sql, destructive: o.destructiveSql, notes: o.notices })),
      notes: [`Source: ${result.sourceLabel}`, 'Partial schema-comparison suggestions only. This file does not reproduce the complete source schema; unsupported differences and dependencies need manual SQL.', ...result.notices] })
  }
  prepare(input: PrepareMigration): MigrationPreview {
    const request = prepareMigrationSchema.parse(input); this.prune()
    const source = this.sources.get(request.sourceId)
    if (!source) throw new Error('This schema review expired or its connection closed. Review the schema again.')
    if (request.transaction === 'transaction' && source.requiresAutocommit) throw new Error('This change must run outside a transaction. Use an autocommit migration runner.')
    if (request.transaction === 'transaction' && !transactionalDdl(source.engine)) throw new Error('This engine commits DDL implicitly; a transaction wrapper cannot make it atomic.')
    const units = source.units.filter(unit => request.selected.includes(unit.key))
    if (units.length !== request.selected.length) throw new Error('The selection is not part of this schema review. Review the schema again.')
    const statements = units.flatMap(unit => [...unit.statements, ...(request.includeDestructive ? unit.destructive : [])])
    for (const unit of units) if (!unit.statements.length && !(request.includeDestructive && unit.destructive.length)) throw new Error(`No included executable SQL for ${unit.title}. Deselect this object or explicitly include its destructive SQL; reference definitions cannot be exported as migrations.`)
    const destructive = request.includeDestructive && units.some(u => u.destructive.length > 0)
    const warnings = [
      'Export only: no SQL has been executed. This is a captured review, not a fresh schema check. Verify the target, permissions, dependencies and backups before running it.',
      'Forward migration only; no rollback script, migration ledger, idempotency or automatic retries are provided. Do not run it twice.',
      source.requiresAutocommit ? 'This change requires an idle autocommit connection. Do not wrap it in a transaction; a failed concurrent index build can leave an invalid index.' : !transactionalDdl(source.engine) ? 'DDL commits implicitly and can partially succeed. A failure does not undo earlier changes.' : request.transaction === 'transaction' ? 'Run in an idle connection using a runner that stops on the first error. BEGIN and COMMIT are included; on error stop and explicitly ROLLBACK. The file has no automatic error handler.' : 'No transaction commands are included. Configure transaction and error handling in your migration runner; statements may commit individually.',
      'Connect to the stated database and establish required namespaces/attachments yourself. The file does not switch databases or include credentials.',
      ...(destructive ? ['DESTRUCTIVE SQL INCLUDED: running this file can remove data or database safeguards.'] : []), ...source.notes
    ]
    const at = new Date(), filename = `${at.toISOString().replace(/[-:TZ.]/g, '')}_${request.name.toLowerCase().replace(/[ _-]+/g, '_')}.sql`
    const body = units.map(unit => [sqlComment(`${unit.title}\n${unit.notes.join('\n')}`), ...[...unit.statements, ...(request.includeDestructive ? unit.destructive : [])].map(sql => sql.trimEnd().endsWith(';') ? sql : sql + ';')].join('\n\n')).join('\n\n')
    const begin = ['sqlserver','azure-sql'].includes(source.engine) ? 'BEGIN TRANSACTION;' : source.engine === 'sqlite' ? 'BEGIN IMMEDIATE;' : 'BEGIN;'
    const sql = [sqlComment(`Db Commander forward migration: ${request.name}\nEngine: ${source.engine}\nTarget: ${source.target}\nReview captured: ${source.captured}\nFile generated: ${at.toISOString()}\n\n${warnings.join('\n')}`), ...(request.transaction === 'transaction' ? [begin] : []), body, ...(request.transaction === 'transaction' ? ['COMMIT;'] : [])].join('\n\n') + '\n'
    if (Buffer.byteLength(sql, 'utf8') > fileLimit) throw new Error('Migration exceeds 1,000,000 UTF-8 bytes. Select fewer changes.')
    const preview: MigrationPreview = { id: randomUUID(), filename, sql, sha256: createHash('sha256').update(sql, 'utf8').digest('hex'), engine: source.engine, statements: statements.length, destructive, warnings, expiresAt: new Date(Math.min(source.expires, Date.now() + ttl)).toISOString() }
    while (this.drafts.size >= 20) this.drafts.delete(this.drafts.keys().next().value!)
    this.drafts.set(preview.id, { sourceId: request.sourceId, preview }); return structuredClone(preview)
  }
  reviewed(input: SaveMigration): MigrationPreview {
    const request = saveMigrationSchema.parse(input); this.prune()
    const draft = this.drafts.get(request.id)
    if (!draft) throw new Error('This migration preview expired or its connection closed. Prepare and review it again.')
    if (draft.preview.destructive && !request.destructiveApproved) throw new Error('Acknowledge destructive SQL before exporting this migration.')
    return structuredClone(draft.preview)
  }
}
