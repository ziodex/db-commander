import { prepareFixtureImages } from './fixture-images.mjs'
import { assertDesktopReady } from './desktop-readiness.mjs'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'node:net'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const supported = ['postgres', 'mysql', 'mariadb', 'sqlserver', 'sqlite', 'oracle', 'duckdb']
const args = process.argv.slice(2).filter(arg => arg !== '--')
const selection = args.indexOf('--driver')
const selected = selection === -1 ? supported : [...new Set((args[selection + 1] ?? '').split(','))]
const filterArgument = flag => {
  const index = args.indexOf(flag)
  if (index === -1) return []
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`${flag} requires a test-name pattern.`)
  return [flag === '--integration-filter' ? '--testNamePattern' : '--grep', args[index + 1]]
}
const integrationFilter = filterArgument('--integration-filter'), desktopFilter = filterArgument('--desktop-filter')
if (selected.some(engine => !supported.includes(engine))) throw new Error('Use --driver postgres, mysql, mariadb, sqlserver, sqlite, oracle or duckdb.')
if (args.includes('--desktop')) assertDesktopReady()
const networkEngines = selected.filter(engine => !['sqlite', 'duckdb'].includes(engine))
const project = `dbcommander-test-${process.pid}`
const artifacts = resolve('.test-artifacts', project)
mkdirSync(artifacts, { recursive: true })
// Keep CI reports outside Playwright's output directory and the disposable
// fixture directory; both are removed during normal test execution/cleanup.
const reports = process.env.SQLCOMMANDER_TEST_REPORT_DIR ? resolve(process.env.SQLCOMMANDER_TEST_REPORT_DIR) : undefined
if (reports) mkdirSync(reports, { recursive: true })
const reporters = file => ['--reporter=verbose', '--reporter=junit', `--outputFile.junit=${file}`]
const env = { ...process.env, SQLCOMMANDER_TEST_DRIVERS: selected.join(','), SQLCOMMANDER_TEST_PROJECT: project }
delete env.ELECTRON_RUN_AS_NODE
const servers = []
// Reserve distinct free loopback ports together before handing them to Docker.
for (const engine of [...networkEngines, ...(networkEngines.length ? ['ssh'] : []), ...(selected.includes('oracle') ? ['oracle_tcp'] : [])]) {
  const server = createServer()
  await new Promise((accept, reject) => server.once('error', reject).listen(0, '127.0.0.1', accept))
  servers.push(server)
  const prefix = engine === 'postgres' ? 'PG' : engine.toUpperCase()
  env[`SQLCOMMANDER_${prefix}_PORT`] = String(server.address().port)
  env[`SQLCOMMANDER_${prefix}_CA`] = resolve(artifacts, `${engine}.crt`)
}
await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
const run = (cmd, args, options = {}) => spawnSync(cmd, args, { stdio: 'inherit', env, shell: false, ...options })
const fixtureFile=resolve(artifacts,'images.compose.json')
const runCompose=(args,options={})=>run('docker',['compose','-f',resolve('compose.yaml'),'-f',fixtureFile,'-p',project,...args],options)
// Patterns may contain pipes. Invoke Node CLIs directly so cmd.exe cannot
// reinterpret a filter as a shell pipeline on Windows.
const runTests = (kind, args) => run(process.execPath, [kind === 'vitest'
  ? resolve(fileURLToPath(import.meta.resolve('vitest/package.json')), '..', 'vitest.mjs')
  : fileURLToPath(import.meta.resolve('@playwright/test/cli')), ...args], { shell: false })
let status = 1
try {
  prepareFixtureImages({engines:[...selected,...(networkEngines.length?['ssh']:[])],root:resolve('.'),overrideFile:fixtureFile,run,compose:runCompose,refresh:args.includes('--refresh-images')})
  if (networkEngines.length) {
    const up = runCompose([ 'up', '--no-build', '--pull', 'never', '-d', '--wait', '--wait-timeout', '360', ...networkEngines, 'ssh'])
    if (up.status !== 0) throw new Error('Docker database fixtures did not become healthy.')
    const hostKey = runCompose([ 'exec', '-T', 'ssh', 'cat', '/fixture/host_key.pub'], { encoding: 'utf8', stdio: 'pipe' })
    const clientKey = runCompose([ 'exec', '-T', 'ssh', 'cat', '/fixture/client_key'], { encoding: 'utf8', stdio: 'pipe' })
    if (hostKey.status !== 0 || clientKey.status !== 0) throw new Error('Could not load disposable SSH fixture keys.')
    env.SQLCOMMANDER_SSH_FINGERPRINT = `SHA256:${createHash('sha256').update(Buffer.from(hostKey.stdout.trim().split(/\s+/)[1], 'base64')).digest('base64').replace(/=+$/, '')}`
    env.SQLCOMMANDER_SSH_KEY = resolve(artifacts, 'ssh-client-key')
    writeFileSync(env.SQLCOMMANDER_SSH_KEY, clientKey.stdout, { mode: 0o600 })
    for (const engine of networkEngines) {
      const prefix = engine === 'postgres' ? 'PG' : engine.toUpperCase()
      const path = engine === 'postgres' ? '/etc/postgresql/tls/server.crt' : '/etc/dbcommander/tls/server.crt'
      const cert = runCompose([ 'exec', '-T', engine, 'cat', path], { encoding: 'utf8', stdio: 'pipe' })
      if (cert.status !== 0) throw new Error(`Could not read ${engine}'s test TLS certificate.`)
      writeFileSync(env[`SQLCOMMANDER_${prefix}_CA`], cert.stdout, { mode: 0o600 })
      if (args.includes('--desktop') && ['postgres', 'mysql', 'mariadb'].includes(engine) && process.platform !== 'win32') {
        const container = runCompose([ 'ps', '-q', engine], { encoding: 'utf8', stdio: 'pipe' }).stdout.trim()
        const image = run('docker', ['inspect', '--format', '{{.Image}}', container], { encoding: 'utf8', stdio: 'pipe' }).stdout.trim()
        const toolDirectory = resolve(artifacts, engine + '-tools'); mkdirSync(toolDirectory)
        for (const tool of engine === 'postgres' ? ['pg_dump', 'pg_restore'] : engine === 'mysql' ? ['mysqldump', 'mysql'] : ['mariadb-dump', 'mariadb']) {
          writeFileSync(resolve(toolDirectory, tool), `#!/usr/bin/env node\nrequire(${JSON.stringify(resolve('tests/docker/native-tool.cjs'))})(${JSON.stringify({ engine, container, image, tool })})\n`, { mode: 0o700 })
        }
        env[`SQLCOMMANDER_${prefix}_TOOLS`] = toolDirectory
      }
    }
    if (selected.includes('sqlserver')) {
      const init = runCompose([ 'exec', '-T', 'sqlserver', '/opt/mssql-tools18/bin/sqlcmd', '-S', 'localhost', '-U', 'sa', '-P', 'Local-SA-Only!2026', '-C', '-b', '-i', '/tmp/dbcommander-init.sql'])
      if (init.status !== 0) throw new Error('SQL Server fixture initialization failed.')
    }
  }
  if (selected.includes('oracle')) {
    // Thin-mode Oracle uses Node's trust roots; keep this fixture CA scoped to
    // child test processes, never the developer's operating-system trust store.
    env.NODE_EXTRA_CA_CERTS = env.SQLCOMMANDER_ORACLE_CA
  }
  if (reports && networkEngines.length && env.SQLCOMMANDER_CATALOG_PERFORMANCE === '1') {
    const ids = runCompose(['ps','-q'], {encoding:'utf8',stdio:'pipe'})
    if(ids.status!==0 || !ids.stdout.trim()) throw new Error('Cannot retain performance fixture identities.')
    const inspected=run('docker',['inspect','--format','{{.Id}} {{.Image}} {{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}}',...ids.stdout.trim().split(/\s+/)],{encoding:'utf8',stdio:'pipe'})
    if(inspected.status!==0) throw new Error('Cannot inspect performance fixtures.')
    const containers=inspected.stdout.trim().split('\n').map(line=>{const [id,image,owner,service]=line.split(/\s+/);if(owner!==project)throw new Error('Performance fixture ownership changed.');return {id,image,project:owner,service}})
    writeFileSync(resolve(reports,'fixtures.json'),JSON.stringify({project,images:JSON.parse(readFileSync(fixtureFile,'utf8')),containers},null,2))
  }
  for (const engine of selected.filter(engine => ['sqlite', 'duckdb'].includes(engine))) {
    const embedded = runCompose([ 'run', '--rm', '--no-deps', '--pull', 'never',
      ...(reports ? ['--volume', `${reports}:/test-results`] : []), engine,
      ...(reports || integrationFilter.length ? ['pnpm', 'exec', 'vitest', 'run', `tests/integration/${engine}.test.ts`, ...integrationFilter, ...(reports ? reporters(`/test-results/${engine}.xml`) : [])] : [])])
    if (embedded.status !== 0) throw new Error(`${engine} Docker contracts failed.`)
  }
  const files = [selected.includes('postgres') && 'tests/integration/postgres.test.ts', selected.some(engine => ['mysql', 'mariadb'].includes(engine)) && 'tests/integration/mysql.test.ts', selected.includes('sqlserver') && 'tests/integration/sqlserver.test.ts', selected.includes('oracle') && 'tests/integration/oracle.test.ts'].filter(Boolean)
  status = files.length ? runTests('vitest', ['run', ...files, ...integrationFilter, ...(reports ? reporters(resolve(reports, 'integration.xml')) : [])]).status ?? 1 : 0
  if (status === 0 && args.includes('--desktop')) {
    const output=reports&&env.SQLCOMMANDER_CATALOG_PERFORMANCE==='1'?resolve(reports,'desktop'):'test-results'
    status = runTests('playwright', ['test', ...desktopFilter,...(output==='test-results'?[]:['--output',output])]).status ?? 1
    if (status !== 0) {
      // The assertion stack alone often hides a connection dialog's actual
      // error. Keep bounded Playwright context in the job log too, so diagnosing
      // startup failures does not depend on artifact-download authorization.
      const contexts = existsSync(output)?readdirSync(output, { recursive: true }).filter(file => String(file).endsWith('error-context.md')).slice(0, 20):[]
      for (const file of contexts) console.error(`Desktop failure context: ${file}\n${readFileSync(resolve(output, String(file)), 'utf8').slice(0, 16384)}`)
    }
  }
} catch (error) { console.error(error.message) }
finally {
  if (status !== 0 && existsSync(fixtureFile)) runCompose([ 'logs', '--tail', '60'])
  const down = existsSync(fixtureFile) ? runCompose([ 'down', '--volumes', '--remove-orphans']) : {status:0}
  if (down.status !== 0) { console.error(`Cleanup failed: run docker compose -p ${project} down --volumes`); status = 1 }
  rmSync(artifacts, { recursive: true, force: true })
}
process.exitCode = status
