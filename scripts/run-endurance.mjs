import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, renameSync, closeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { arch, cpus, platform, release, totalmem } from 'node:os'

const { values } = parseArgs({ options: {
  seconds: { type: 'string', default: '28800' }, interval: { type: 'string', default: '30' }, rows: { type: 'string', default: '100000' },
  output: { type: 'string' }, executable: { type: 'string' }, detach: { type: 'boolean', default: false }
} })
for (const [name, min, max] of [['seconds', 30, 86400], ['interval', 1, 60], ['rows', 10000, 10000000]]) {
  const value = Number(values[name]); if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${name} must be an integer from ${min} to ${max}.`)
}
const root = resolve(values.output ?? `.test-artifacts/endurance-${new Date().toISOString().replace(/[:.]/g, '-')}`)
const script = fileURLToPath(import.meta.url), repository = resolve(dirname(script), '..')
const executable = resolve(values.executable ?? (platform() === 'darwin' ? `release/${arch() === 'arm64' ? 'mac-arm64' : 'mac'}/DbCommander.app/Contents/MacOS/DbCommander` : platform() === 'win32' ? 'release/win-unpacked/DbCommander.exe' : 'release/linux-unpacked/dbcommander'))
if (!existsSync(executable)) throw new Error('Build the package first, or pass --executable.')
if (existsSync(join(root, 'run.json')) || values.detach && existsSync(join(root, 'launch.json'))) throw new Error('Choose a new output directory; a run already exists here.')
mkdirSync(root, { recursive: true, mode: 0o700 })
const args = ['--output', root, '--seconds', values.seconds, '--interval', values.interval, '--rows', values.rows, '--executable', executable]
if (values.detach) {
  const log = openSync(join(root, 'runner.log'), 'a', 0o600)
  const child = spawn(process.execPath, [script, ...args], { cwd: repository, detached: true, stdio: ['ignore', log, log] })
  child.unref(); closeSync(log)
  // Separate receipt avoids racing the child runner's status publication.
  writeFileSync(join(root, 'launch.json'), JSON.stringify({ pid: child.pid, launchedAt: new Date().toISOString(), output: root }, null, 2))
  console.log(JSON.stringify({ pid: child.pid, output: root, seconds: Number(values.seconds) }));
} else {
  const began = new Date(), status = { state: 'preparing', pid: process.pid, startedAt: began.toISOString(), expectedEndAt: new Date(+began + Number(values.seconds) * 1000).toISOString(), seconds: Number(values.seconds), interval: Number(values.interval), exportRows: Number(values.rows), platform: platform(), arch: arch(), osRelease: release(), memoryBytes: totalmem(), cpus: cpus().length, sourceExecutable: executable }
  function checkpoint(patch) { Object.assign(status, patch); const temporary = join(root, 'run.json.tmp'); writeFileSync(temporary, JSON.stringify(status, null, 2), { mode: 0o600 }); renameSync(temporary, join(root, 'run.json')) }
  let keepAwake
  try {
    checkpoint({ sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim() })
    // Freeze the package so later development builds cannot change the running app.
    const source = platform() === 'darwin' ? resolve(executable, '../../..') : dirname(executable)
    const snapshot = join(root, 'app', platform() === 'darwin' ? 'DbCommander.app' : 'unpacked')
    mkdirSync(dirname(snapshot), { recursive: true }); cpSync(source, snapshot, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
    const target = platform() === 'darwin' ? join(snapshot, 'Contents/MacOS/DbCommander') : join(snapshot, executable.slice(dirname(executable).length + 1))
    const asar = platform() === 'darwin' ? join(snapshot, 'Contents/Resources/app.asar') : join(snapshot, 'resources/app.asar')
    if (platform() === 'darwin') keepAwake = spawn('caffeinate', ['-dims', '-w', String(process.pid)], { stdio: 'ignore' })
    const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve('@playwright/test/cli')), 'test', 'tests/desktop/endurance.spec.ts', '--output', join(root, 'results'), '--workers', '1'], {
      cwd: repository, stdio: 'inherit', env: { ...process.env, SQLCOMMANDER_TEST_EXECUTABLE: target, SQLCOMMANDER_ENDURANCE_SECONDS: values.seconds, SQLCOMMANDER_ENDURANCE_INTERVAL_SECONDS: values.interval, SQLCOMMANDER_ENDURANCE_EXPORT_ROWS: values.rows, SQLCOMMANDER_ENDURANCE_PROGRESS: join(root, 'progress.json'), PLAYWRIGHT_JUNIT_OUTPUT_FILE: join(root, 'junit.xml') }
    })
    checkpoint({ state: 'running', workerPid: child.pid, executable: target, packageSha256: createHash('sha256').update(readFileSync(asar)).digest('hex') })
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal))
    child.once('error', error => { keepAwake?.kill(); checkpoint({ state: 'failed', error: error.stack, finishedAt: new Date().toISOString() }); process.exitCode = 1 })
    child.once('exit', (code, signal) => {
      keepAwake?.kill(); checkpoint({ state: code === 0 ? 'passed' : 'failed', exitCode: code, signal, finishedAt: new Date().toISOString() }); process.exitCode = code === 0 ? 0 : 1
    })
  } catch (error) { keepAwake?.kill(); checkpoint({ state: 'failed', error: error.stack, finishedAt: new Date().toISOString() }); throw error }
}
