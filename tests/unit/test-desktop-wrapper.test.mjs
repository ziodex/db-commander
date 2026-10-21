import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, rm, realpath, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { managedDesktop, withTestDesktop } from '../../scripts/with-test-desktop.mjs'

const directories = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dbcommander-private-display-')); directories.push(directory)
  const script = join(directory, 'children.cjs'), ready = join(directory, 'ready.json'), command = join(directory, 'command.json')
  await writeFile(script, `const fs=require('node:fs');
if(process.argv[2]==='wm') { fs.writeFileSync(process.env.FAKE_READY,JSON.stringify({pid:process.pid,display:process.env.DISPLAY})); if(process.env.FAKE_WM_FAIL==='1')setTimeout(()=>process.exit(3),50); setInterval(()=>{},1000); }
else if(process.argv[2]==='xprop') {console.log(fs.existsSync(process.env.FAKE_READY)?'_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x1234':'_NET_SUPPORTING_WM_CHECK: no such atom');}
else if(process.argv[2]==='bystander') {setInterval(()=>{},1000);}
else if(process.argv[2]==='helper') {process.on('SIGTERM',()=>{});fs.writeFileSync(process.env.FAKE_HELPER,JSON.stringify({pid:process.pid,script:__filename}));setInterval(()=>{},1000);}
else if(process.argv[2]==='runner-with-helper') {require('node:child_process').spawn(process.execPath,[__filename,'helper'],{stdio:'ignore'}); const ready=setInterval(()=>{if(fs.existsSync(process.env.FAKE_HELPER)){clearInterval(ready);if(process.env.FAKE_PARENT_EXIT==='1')process.exit(7);}},5);setInterval(()=>{},1000);}
else {fs.writeFileSync(process.env.FAKE_COMMAND,JSON.stringify({ready:fs.existsSync(process.env.FAKE_READY),display:process.env.DISPLAY})); if(process.env.FAKE_WAIT==='1')setInterval(()=>{},1000);else process.exit(7);}`)
  const token = randomUUID(), children = []
  const options = { token, env: { ...process.env, SQLCOMMANDER_PRIVATE_DISPLAY_TOKEN: token, SQLCOMMANDER_PRIVATE_TEST_BUS: '1', DISPLAY: ':1999', FAKE_READY: ready, FAKE_COMMAND: command },
    commands: { wm: [process.execPath, script, 'wm'], xprop: [process.execPath, script, 'xprop'] }, observe: child => children.push(child) }
  return { directory, script, ready, command, children, options }
}
function stopped(children) { for (const child of children) expect(child.exitCode !== null || child.signalCode !== null).toBe(true) }

it('waits for a ready private window manager, propagates command failure and stops its owned children', async () => {
  const f = await fixture()
  expect(await managedDesktop([process.execPath, f.script, 'command'], f.options)).toBe(7)
  expect(JSON.parse(await readFile(f.command, 'utf8'))).toEqual({ ready: true, display: ':1999' })
  stopped(f.children)
})

function alive(pid) { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
async function stopFixtureHelper(helper, script) {
  if (!helper || !alive(helper.pid)) return
  expect(await realpath(helper.script)).toBe(await realpath(script))
  const { stdout } = await promisify(execFile)('ps', ['-p', String(helper.pid), '-o', 'command='])
  if (!stdout.includes(helper.script)) throw new Error('Refusing to stop a helper whose fixture identity changed.')
  process.kill(helper.pid, 'SIGKILL')
  await vi.waitFor(() => expect(alive(helper.pid)).toBe(false), { timeout: 2000, interval: 20 })
}
for (const mode of ['exited', 'cancelled']) it.skipIf(process.platform === 'win32')(`reaps the owned process group after its parent ${mode} without stopping a bystander`, async () => {
  const f = await fixture(), controller = new AbortController(), helperFile = join(f.directory, 'helper.json')
  f.options.env.FAKE_HELPER = helperFile; f.options.env.FAKE_PARENT_EXIT = mode === 'exited' ? '1' : '0'
  const bystander = spawn(process.execPath, [f.script, 'bystander'], { env: f.options.env, stdio: 'ignore' })
  const bystanderClosed = new Promise(resolve => bystander.once('close', resolve))
  const operation = managedDesktop([process.execPath, f.script, 'runner-with-helper'], { ...f.options, signal: controller.signal })
  void operation.catch(() => {})
  let helper
  try {
    await vi.waitFor(async () => { helper = JSON.parse(await readFile(helperFile, 'utf8')); expect(await realpath(helper.script)).toBe(await realpath(f.script)); expect(alive(helper.pid)).toBe(true) }, { timeout: 3000, interval: 20 })
    if (mode === 'cancelled') { controller.abort(new Error('Fixture process-group cancellation')); await expect(operation).rejects.toThrow('Fixture process-group cancellation') }
    else expect(await operation).toBe(7)
    expect(alive(helper.pid)).toBe(false)
    expect(alive(bystander.pid)).toBe(true)
    stopped(f.children)
  } finally {
    controller.abort(new Error('Fixture cleanup'))
    // The failing-regression path must also leave no helper behind. Verify
    // the receipt's unique script path before signalling its exact PID.
    try { await operation.catch(() => {}); await stopFixtureHelper(helper, f.script) }
    finally { if (bystander.exitCode === null && bystander.signalCode === null) bystander.kill('SIGKILL'); await bystanderClosed }
  }
})

it.skipIf(process.platform === 'win32')('lets the nested Linux wrapper finish owned-group cleanup before outer escalation', async () => {
  const f = await fixture(), controller = new AbortController(), helperFile = join(f.directory, 'helper.json')
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`
  // CLI stand-ins only: no X server, window manager or desktop is started.
  for (const [name, body] of [
    ['xvfb-run', 'shift 3\nexport DISPLAY=:1999\nexec "$@"'],
    ['openbox', `exec ${quote(process.execPath)} ${quote(f.script)} wm "$@"`],
    ['xprop', `exec ${quote(process.execPath)} ${quote(f.script)} xprop "$@"`]
  ]) { const path = join(f.directory, name); await writeFile(path, `#!/bin/sh\n${body}\n`); await chmod(path, 0o700) }
  const operation = withTestDesktop([process.execPath, f.script, 'runner-with-helper'], { platform: 'linux', signal: controller.signal,
    env: { ...f.options.env, FAKE_HELPER: helperFile, PATH: `${f.directory}:${process.env.PATH}` } })
  void operation.catch(() => {})
  let helper
  try {
    await vi.waitFor(async () => { helper = JSON.parse(await readFile(helperFile, 'utf8')); expect(await realpath(helper.script)).toBe(await realpath(f.script)) }, { timeout: 3000, interval: 20 })
    controller.abort(new Error('Fixture outer interruption'))
    await expect(operation).rejects.toThrow('Fixture outer interruption')
    expect(alive(helper.pid)).toBe(false)
  } finally { controller.abort(new Error('Fixture cleanup')); await operation.catch(() => {}); await stopFixtureHelper(helper, f.script) }
})
it('refuses a foreign display and an already managed display before launching a test command', async () => {
  const f = await fixture()
  await expect(managedDesktop([process.execPath], { ...f.options, token: 'wrong owner' })).rejects.toThrow('owned private Xvfb')
  await writeFile(f.ready, '{}')
  await expect(managedDesktop([process.execPath], f.options)).rejects.toThrow('Refusing to replace')
  expect(f.children).toEqual([])
})
it('fails when the manager exits and cleans up without leaving its command alive', async () => {
  const f = await fixture(); f.options.env.FAKE_WM_FAIL = '1'; f.options.env.FAKE_WAIT = '1'
  await expect(managedDesktop([process.execPath, f.script, 'command'], f.options)).rejects.toThrow('window manager exited')
  stopped(f.children)
})
it('cancels only its owned CLI children and passes through on other platforms', async () => {
  const f = await fixture(), controller = new AbortController(); f.options.env.FAKE_WAIT = '1'
  const run = managedDesktop([process.execPath, f.script, 'command'], { ...f.options, signal: controller.signal })
  void run.catch(() => {})
  try { await vi.waitFor(() => expect(f.children).toHaveLength(2), { timeout: 3000, interval: 10 }) }
  finally { controller.abort(new Error('synthetic runner interruption')) }
  await expect(run).rejects.toThrow('synthetic runner interruption'); stopped(f.children)
  expect(await withTestDesktop([process.execPath, '-e', 'process.exit(9)'], { platform: 'darwin' })).toBe(9)
})
