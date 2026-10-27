import { _electron as electron } from '@playwright/test'
import { cpSync, existsSync, mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { captureStartupDiagnostics } from './release/startup-diagnostics.mjs'
import { assertDesktopReady } from './desktop-readiness.mjs'
const candidates = process.platform === 'darwin' ? [`release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/DbCommander.app/Contents/MacOS/DbCommander`] : process.platform === 'win32' ? ['release/win-unpacked/DbCommander.exe'] : ['release/linux-unpacked/dbcommander', 'release/linux-unpacked/DbCommander']
const executable = process.argv[2] ?? candidates.find(existsSync)
if (!executable) throw new Error('Build the packaged app first, or pass its executable path.')
assertDesktopReady()
const directory = mkdtempSync(join(tmpdir(), 'dbcommander-package-'))
// Exercise the same short Windows TEMP path and space-containing directory as
// the installer before spending time on the complete desktop/lifecycle suites.
let startupExecutable = resolve(executable)
if (process.platform === 'win32') {
  const relocated = join(directory, 'Application with spaces')
  cpSync(dirname(startupExecutable), relocated, { recursive: true })
  startupExecutable = join(relocated, basename(startupExecutable))
}
const env = { ...process.env, SQLCOMMANDER_USER_DATA: directory }
delete env.ELECTRON_RUN_AS_NODE
let app
let diagnostics, failed = false
try {
  app = await electron.launch({ executablePath: startupExecutable, env })
  diagnostics = captureStartupDiagnostics(app, directory)
  const page = await app.firstWindow()
  await page.getByText('Saved locally', { exact: true }).waitFor()
  await page.locator('.monaco-editor').first().waitFor()
  if (await page.evaluate(() => typeof window.require) !== 'undefined') throw new Error('Renderer has unexpected Node access.')
  for (const engine of ['sqlite', 'duckdb']) {
    const checked = await page.evaluate(async ({ path, engine }) => {
      const api = window.dbCommander
      const session = await api.connect({ engine, name: `Packaged ${engine}`, host: 'local', port: 1, user: 'local', database: engine === 'sqlite' ? 'SQLite' : 'DuckDB', password: '', tls: 'disable', sqliteMode: engine === 'sqlite' ? 'create' : undefined, duckdbMode: engine === 'duckdb' ? 'create' : undefined, filePath: path })
      const rows = []
      const completion = new Promise(resolve => {
        const off = api.onEvent(event => {
          if ('sessionId' in event && event.sessionId !== session.id) return
          if (event.type === 'rows') rows.push(...event.rows)
          if (event.type === 'complete') { off(); resolve(event) }
        })
      })
      await api.run({ sessionId: session.id, sql: 'CREATE TABLE checked(value BIGINT); INSERT INTO checked VALUES(9223372036854775807); SELECT value FROM checked;', maxRows: 1 })
      const result = await completion
      await api.disconnect(session.id)
      return { result, rows, version: session.version }
    }, { path: join(directory, `packaged.${engine}`), engine })
    if (checked.result.status !== 'completed' || checked.rows[0]?.[0] !== '9223372036854775807') throw new Error(`Packaged ${engine} failed its exact-integer/file contract: ${checked.result.error ?? ''}`)
    console.log(`Packaged ${engine} ${checked.version}: native engine, exact integer and persistent file passed.`)
  }
  console.log('Packaged application: Monaco, isolated preload and workspace storage passed.')
} catch (error) {
  failed = true
  console.error('Packaged startup diagnostics:', await diagnostics?.())
  throw error
} finally {
  if (failed) await app?.evaluate(({ app }) => app.exit(1)).catch(() => {})
  // Use asynchronous removal: Node 25's synchronous Windows removal can
  // reject a removable fixture with EPERM. Also allow brief native-handle lag.
  await app?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}

// Pass the filter directly to Node: cmd.exe treats its pipes and spaces as
// command syntax when pnpm is launched with shell:true on Windows.
// Run startup fault isolation and host recovery in focused Windows diagnostics.
const startupEnv = { ...env, SQLCOMMANDER_TEST_EXECUTABLE: resolve(executable) }
if (env.PLAYWRIGHT_JUNIT_OUTPUT_FILE) startupEnv.PLAYWRIGHT_JUNIT_OUTPUT_FILE = join(dirname(resolve(env.PLAYWRIGHT_JUNIT_OUTPUT_FILE)), 'packaged-startup.xml')
const startup = spawnSync(process.execPath, [fileURLToPath(import.meta.resolve('@playwright/test/cli')), 'test', 'tests/desktop/startup.spec.ts', '--output', 'test-results/packaged-startup'], {
  stdio: 'inherit', env: startupEnv
})
if (startup.error) throw startup.error
if (startup.status !== 0) throw new Error('Packaged startup failed its native-library, installation-alias or database-host recovery regression.')

if (!/^true$/i.test(process.env.SQLCOMMANDER_STARTUP_ONLY || '')) {
const tabs = spawnSync(process.execPath, [fileURLToPath(import.meta.resolve('@playwright/test/cli')), 'test', 'tests/desktop/connection-navigation.spec.ts', 'tests/desktop/about.spec.ts', 'tests/desktop/windows-auth.spec.ts', 'tests/desktop/icon.spec.ts', 'tests/desktop/system-tray.spec.ts', 'tests/desktop/workspace-ui.spec.ts', 'tests/desktop/profile-ownership.spec.ts', 'tests/desktop/accessibility.spec.ts', 'tests/desktop/design-polish.spec.ts', 'tests/desktop/screen-reader.spec.ts', 'tests/desktop/export-faults.spec.ts', 'tests/desktop/generated-files.spec.ts', 'tests/desktop/soak.spec.ts', 'tests/desktop/editor-retention.spec.ts', 'tests/desktop/sql-files.spec.ts', 'tests/desktop/sql-reload.spec.ts', 'tests/desktop/execution.spec.ts', 'tests/desktop/parameter-export.spec.ts', 'tests/desktop/parameter-explain.spec.ts', 'tests/desktop/typed-parameters.spec.ts', 'tests/desktop/timezone-parameters.spec.ts', 'tests/desktop/array-parameters.spec.ts', 'tests/desktop/snippet-files.spec.ts', 'tests/desktop/tabs.spec.ts', 'tests/desktop/tab-pinning.spec.ts', 'tests/desktop/language.spec.ts', 'tests/desktop/grid.spec.ts', 'tests/desktop/browsing.spec.ts', 'tests/desktop/catalog.spec.ts', 'tests/desktop/large-catalog.spec.ts', 'tests/desktop/diagram.spec.ts', 'tests/desktop/schema-compare.spec.ts', 'tests/desktop/data-compare.spec.ts', 'tests/desktop/query-builder.spec.ts', 'tests/desktop/activity.spec.ts', 'tests/desktop/activity-control.spec.ts', 'tests/desktop/rollback.spec.ts', 'tests/desktop/explain.spec.ts', 'tests/desktop/inspection.spec.ts', 'tests/desktop/column-sizing.spec.ts', 'tests/desktop/table-layouts.spec.ts', 'tests/desktop/library.spec.ts', 'tests/desktop/profiles.spec.ts', 'tests/desktop/saved-connections.spec.ts', 'tests/desktop/connection-test.spec.ts', 'tests/desktop/schema-changes.spec.ts', 'tests/desktop/transfer.spec.ts', 'tests/desktop/json-import.spec.ts', 'tests/desktop/layout.spec.ts', 'tests/desktop/editor-settings.spec.ts', 'tests/desktop/editor-views.spec.ts', 'tests/desktop/workspace-editor.spec.ts', 'tests/desktop/workspace-recovery.spec.ts', 'tests/desktop/workspace-registry.spec.ts', 'tests/desktop/host-recovery.spec.ts', 'tests/desktop/workspace-disk-full.spec.ts', 'tests/desktop/workspace-capacity.spec.ts', 'tests/desktop/clipboard.spec.ts', 'tests/desktop/credentials.spec.ts', 'tests/desktop/backup.spec.ts', 'tests/desktop/backup-recovery.spec.ts', '--grep', 'connection navigation|Help About|Windows Authentication|connection test|large catalog|design polish|result keyboard navigation|application icon|system tray|saved connections|profile ownership|application crash|host recovery|workspace disk full|workspace large buffer|workspace capacity|clipboard |generated files|export safety|export disk full|keyboard focus|screen reader|local soak|closed scratch tabs|native input DOM retention|SQL files|SQL reload recovery|query tab pinning|saved table layouts|duckdb|backup sqlite|backup recovery|layout|editor settings|split editor views|workspace windows|workspace editor appearance|workspace recovery|workspace registry recovery|credentials native|credentials unavailable', '--output', 'test-results/packaged-tabs'], {
  stdio: 'inherit',
  env: { ...env, SQLCOMMANDER_TEST_EXECUTABLE: resolve(executable), SQLCOMMANDER_TEST_DRIVERS: 'duckdb' }
})
if (tabs.error) throw tabs.error
if (tabs.status !== 0) throw new Error('Packaged query tabs, SQL language tools, editable grids, table browsing, panel layout or credential storage failed.')
}
