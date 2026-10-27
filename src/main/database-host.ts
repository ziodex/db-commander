import { snippetExportSchema, snippetImportSchema } from '../shared/snippet-files'
import { watchWindowsOwner } from './owner-watchdog'
import type { HostInput, HostMessage, HostHandlers } from '../shared/host-rpc'
import { rollbackRequestSchema } from '../shared/rollback'
import { prepareActivityActionSchema, applyActivityActionSchema } from '../shared/activity-control'
import { activityRequestSchema } from '../shared/activity'
import { dataCompareSchema } from '../shared/data-compare'
import { prepareBuilderSchema } from '../shared/query-builder'
import { prepareMigrationSchema, saveMigrationSchema } from '../shared/migrations'
import { compareSchemaSchema } from '../shared/schema-compare'
import { diagramRequestSchema } from '../shared/diagram'
import { historySearchSchema, historySettingsSchema, snippetSchema, snippetSearchSchema } from '../shared/query-library'
import { explainRequestSchema } from '../shared/explain'
import { inspectObjectSchema } from '../shared/catalog'
import { prepareSchemaChangeSchema, applySchemaChangeSchema } from '../shared/schema-changes'
import { join } from 'node:path'
import { statfsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DriverRegistry } from '../driver/registry'
import { WorkspaceStore } from '../storage/store'
import { workspaceStartupError } from '../storage/startup-error'
import { SnippetExchange } from '../storage/snippet-exchange'
import { backupRequestSchema } from '../shared/backup'
import { importSourceSchema, transferRequestSchema } from '../shared/transfer'
import { switchDatabaseSchema, gridRequestSchema, connectionSchema, idSchema, runSchema, workspaceSchema, type DatabaseEvent } from '../shared/contracts'

const port = (process as unknown as { parentPort: { postMessage(value: HostMessage): void; on(event: string, listener: (event: { data: HostInput }) => void): void } }).parentPort
function initialize(): void {
  const store = new WorkspaceStore(join(process.argv[2], 'workspace.sqlite'))
  const snippetExchange = new SnippetExchange(store)
  const acknowledgements = new Map<string, () => void>()
  const driver = new DriverRegistry(async (event: DatabaseEvent) => {
    if (event.type !== 'rows') { port.postMessage({ event }); return }
    const token = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { acknowledgements.delete(token); reject(new Error('The results view stopped responding. Execution stopped; inspect transaction state before continuing.')) }, 15000)
      acknowledgements.set(token, () => { clearTimeout(timer); acknowledgements.delete(token); resolve() })
      port.postMessage({ event, token })
    })
  }, undefined, {}, job => port.postMessage({ backupJob: job }), job => port.postMessage({ transferJob: job }))
  // Enabling recording later must not capture work started while it was disabled.
  function historyContext(sessionId:string) {const context=driver.historyContext(sessionId);return {...context,enabled:context.enabled&&store.historySettings().enabled}}
  const handlers = {
    cancelExplain: payload => driver.cancelExplain(idSchema.parse(payload)),
    explain: async payload => {
      const request = explainRequestSchema.parse(payload), context = historyContext(request.sessionId), startedAt = new Date().toISOString()
      const result = await driver.explain(request)
      if (result.submittedSql.length) {
        try { context.enabled && store.addHistory({ ...context, parameters: request.parameters?.map(({ name, type }) => ({ name, type })), id: randomUUID(), sql: result.submittedSql.join('\n\n'), status: result.status, startedAt, durationMs: result.durationMs }) }
        catch { result.message += ' Query history could not be saved.' }
      }
      return result;
    },
    sessionSafety: payload => driver.sessionSafety(idSchema.parse(payload)),
    lockSession: payload => driver.lockSession(idSchema.parse(payload)),
    unlockSession: async payload => {
      const request = z.object({ sessionId: idSchema, confirmation: z.string().max(100) }).strict().parse(payload)
      return driver.unlockSession(request.sessionId, request.confirmation);
    },
    prepareSchemaChange: payload => driver.prepareSchemaChange(prepareSchemaChangeSchema.parse(payload)),
    cancelSchemaChange: payload => driver.cancelSchemaChange(idSchema.parse(payload)),
    applySchemaChange: async payload => {
      const request = applySchemaChangeSchema.parse(payload), context = historyContext(request.sessionId), startedAt = new Date().toISOString()
      const result = await driver.applySchemaChange(request)
      if (result.executedSql) {
        try { context.enabled && store.addHistory({ ...context, id: randomUUID(), sql: result.executedSql, status: result.status, startedAt, durationMs: result.durationMs }) }
        catch { result.message += ' Query history could not be saved.' }
      }
      return result;
    },
    inspectImport: payload => driver.inspectImport(importSourceSchema.parse(payload)),
    startTransfer: payload => driver.startTransfer(transferRequestSchema.parse(payload)),
    cancelTransfer: payload => driver.cancelTransfer(idSchema.parse(payload)),
    startBackup: payload => driver.startBackup(backupRequestSchema.parse(payload)),
    cancelBackup: payload => driver.cancelBackup(idSchema.parse(payload)),
    connect: payload => driver.connect(connectionSchema.parse(payload)),
    disconnect: payload => driver.disconnect(idSchema.parse(payload)),
    databases: payload => driver.databases(idSchema.parse(payload)),
    switchDatabase: payload => driver.switchDatabase(switchDatabaseSchema.parse(payload)),
    tables: payload => driver.tables(idSchema.parse(payload)),
    editGrid: payload => driver.editGrid(gridRequestSchema.parse(payload)),
    compareData: payload => driver.compareData(dataCompareSchema.parse(payload)),
    compareSchemas: payload => driver.compareSchemas(compareSchemaSchema.parse(payload)),
    prepareMigration: payload => driver.prepareMigration(prepareMigrationSchema.parse(payload)),
    prepareActivityAction: payload => driver.prepareActivityAction(prepareActivityActionSchema.parse(payload)),
    applyActivityAction: payload => driver.applyActivityAction(applyActivityActionSchema.parse(payload)),
    inspectRollback: payload => driver.inspectRollback(rollbackRequestSchema.parse(payload)),
    inspectActivity: payload => driver.inspectActivity(activityRequestSchema.parse(payload)),
    prepareQueryBuilder: payload => driver.prepareQueryBuilder(prepareBuilderSchema.parse(payload)),
    reviewedMigration: payload => driver.reviewedMigration(saveMigrationSchema.parse(payload)),
    diagram: payload => driver.diagram(diagramRequestSchema.parse(payload)),
    inspectObject: payload => driver.inspectObject(inspectObjectSchema.parse(payload)),
    schema: payload => driver.schema(idSchema.parse(payload)),
    run: async payload => {
      const request = runSchema.parse(payload)
      const startedAt = new Date().toISOString()
      const context = historyContext(request.sessionId)
      const queryId = driver.start(request, event => {
        try { context.enabled && store.addHistory({ ...context, parameters: request.parameters?.map(({name,type})=>({name,type})), id: event.queryId, sql: request.sql, status: event.status, startedAt, durationMs: event.durationMs }) }
        catch { port.postMessage({ event: { type: 'notice', sessionId: request.sessionId, queryId: event.queryId, message: 'The query finished, but local history could not be saved. Check available disk space.' } }) }
      })
      return { queryId };
    },
    cancel: payload => driver.cancel(idSchema.parse(payload)),
    loadWorkspace: async () => {
      return store.load(); // Recovery metadata is for the renderer, never a persisted workspace field.
    },
    loadWorkspaceRecovery: async () => {
      const workspace = store.load(); return workspace ? { ...workspace, recoveryNotice: store.recoveryNotice } : null;
    },
    saveWorkspace: payload => store.save(workspaceSchema.parse(payload)),
    saveWorkspaceCredentials: payload => {
      const input = z.object({ workspace: workspaceSchema, removals: z.array(idSchema).max(100) }).strict().parse(payload)
      store.saveWithCredentialRemovals(input.workspace, input.removals)
    },
    credentialRemovals: () => store.pendingCredentialRemovals(),
    completeCredentialRemoval: payload => store.completeCredentialRemoval(idSchema.parse(payload)),
    history: () => store.history(),
    clearHistory: payload => store.clearHistory(z.boolean().optional().parse(payload)),
    searchHistory: payload => store.searchHistory(historySearchSchema.parse(payload)),
    historySettings: () => store.historySettings(),
    saveHistorySettings: payload => store.saveHistorySettings(historySettingsSchema.parse(payload)),
    favoriteHistory: async payload => {
      const r=z.object({id:idSchema,favorite:z.boolean()}).strict().parse(payload);return store.favoriteHistory(r.id,r.favorite);
    },
    deleteHistory: payload => store.deleteHistory(idSchema.parse(payload)),
    snippets: payload => store.snippets(snippetSearchSchema.parse(payload??{})),
    saveSnippet: payload => store.saveSnippet(snippetSchema.parse(payload)),
    deleteSnippet: payload => store.deleteSnippet(idSchema.parse(payload)),
    exportSnippets: payload => snippetExchange.export(snippetExportSchema.parse(payload)),
    reviewSnippetImport: payload => snippetExchange.review(payload),
    applySnippetImport: payload => snippetExchange.apply(snippetImportSchema.parse(payload)),
    discardSnippetImport: async payload => {
      snippetExchange.discard(idSchema.parse(payload));
    },
    exportCsv: async payload => {
      const parsed = z.object({ queryId: idSchema, index: z.number().int().min(0).max(199), path: z.string().min(1) }).strict().parse(payload)
      return await driver.exportCsv(parsed.queryId, parsed.index, parsed.path);
    }
  } satisfies HostHandlers
  port.on('message', async ({ data }) => {
    if ('ack' in data) { acknowledgements.get(data.ack)?.(); return }
    const { id, method, payload } = data
    try {
      if (!Object.hasOwn(handlers, method)) throw new Error('Unsupported database operation.')
      const value = await handlers[method](payload)
      port.postMessage({ id, ok: true, value })
    } catch (error) { port.postMessage({ id, ok: false, error: error instanceof Error ? error.message : 'Database operation failed.' }) }
  })
  port.postMessage({ ready: true })
}
async function start() {
  try {
    if (process.platform === 'win32') await watchWindowsOwner(__dirname, Number(process.argv[3]), Number(process.argv[4]))
    initialize()
  } catch (error) {
    // statfs follows the workspace file when it lives on a separate volume.
    let availableBytes: number | undefined
    for (const path of [join(process.argv[2], 'workspace.sqlite'), process.argv[2]]) {
      try { const stats = statfsSync(path); availableBytes = stats.bavail * stats.bsize; break } catch {}
    }
    port.postMessage({ startupError: workspaceStartupError(error, availableBytes) })
    // The parent owns shutdown; keep the channel alive until it receives the error.
    port.on('message', () => {})
  }
}
void start()
