import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'

const execute = promisify(execFile), script = fileURLToPath(import.meta.url)
const marker = 'SQLCOMMANDER_PRIVATE_DISPLAY_TOKEN'
function launch(argv, env, stdio, observe) {
  const child = spawn(argv[0], argv.slice(1), { env, stdio, detached: process.platform !== 'win32' })
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
  // A readiness failure can precede the wait for an owned child's exit.
  void exited.catch(() => {})
  observe?.(child)
  return { child, exited }
}
async function signalGroup(pid, name) {
  const reapingDeadline = performance.now() + 100
  for (;;) {
    try { process.kill(-pid, name); return true }
    catch (error) {
      if (error.code === 'ESRCH') return false
      // Darwin briefly reports EPERM for a group of unreaped zombies. Yield
      // for reaping; a persistent permission error remains a cleanup failure.
      if (process.platform !== 'darwin' || error.code !== 'EPERM' || performance.now() >= reapingDeadline) throw error
      await pause(25)
    }
  }
}
async function stopOwned(owned, graceMs = 2000) {
  if (!owned?.child.pid) return
  if (process.platform !== 'win32') {
    // The group is private to this captured detached child. Its helpers can
    // survive the parent's exit and can ignore TERM, including with no pipes.
    if (!await signalGroup(owned.child.pid, 'SIGTERM')) return
    for (const [timeout, force] of [[graceMs, false], [5000, true]]) {
      if (force && !await signalGroup(owned.child.pid, 'SIGKILL')) return
      const deadline = performance.now() + timeout
      for (;;) {
        if (!await signalGroup(owned.child.pid, 0)) return
        if (performance.now() >= deadline) break
        await pause(25)
      }
    }
    throw new Error('An owned desktop process group did not stop.')
  }
  if (owned.child.exitCode !== null || owned.child.signalCode !== null) return
  function signal(name) {
    if (owned.child.exitCode !== null || owned.child.signalCode !== null) return
    try {
      owned.child.kill(name)
    } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  signal('SIGTERM')
  if (!await Promise.race([owned.exited.then(() => true, () => true), pause(2000, undefined, { ref: false }).then(() => false)])) {
    signal('SIGKILL')
    if (!await Promise.race([owned.exited.then(() => true, () => true), pause(5000, undefined, { ref: false }).then(() => false)])) throw new Error('An owned desktop child did not stop.')
  }
}
const wmWindow = text => /window id #\s*0x[0-9a-f]*[1-9a-f][0-9a-f]*/i.test(text)
function cancellation(signal) {
  let abort
  const promise = new Promise((_, reject) => {
    abort = () => reject(signal.reason ?? new Error('Desktop test command interrupted.'))
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
  void promise.catch(() => {})
  return { promise, dispose: () => signal?.removeEventListener('abort', abort) }
}

// Called only inside the new Xvfb server owned by withTestDesktop. Command
// overrides let unit fixtures use real CLI children without starting any GUI.
export async function managedDesktop(argv, { token, env = process.env, commands = { wm: ['openbox', '--sm-disable'], xprop: ['xprop'] }, observe, readinessMs = 10000, signal } = {}) {
  if (!argv.length || !token || env[marker] !== token || env.SQLCOMMANDER_PRIVATE_TEST_BUS !== '1' || !/^:\d+(?:\.\d+)?$/.test(env.DISPLAY || '')) throw new Error('Desktop tests require the owned private Xvfb display and test bus.')
  const property = async () => (await execute(commands.xprop[0], [...commands.xprop.slice(1), '-root', '_NET_SUPPORTING_WM_CHECK'], { env, timeout: 1000, maxBuffer: 16384 })).stdout
  if (wmWindow(await property())) throw new Error('Refusing to replace an existing window manager.')
  let wm, command, stderr = Buffer.alloc(0)
  const cancelled = cancellation(signal)
  try {
    wm = launch(commands.wm, env, ['ignore', 'ignore', 'pipe'], observe)
    wm.child.stderr.on('data', chunk => { stderr = Buffer.concat([stderr, Buffer.from(chunk)]).subarray(-16384) })
    const deadline = performance.now() + readinessMs
    for (;;) {
      signal?.throwIfAborted()
      if (wm.child.exitCode !== null || wm.child.signalCode !== null || wm.child.pid === undefined) throw new Error('The private window manager exited before becoming ready.')
      if (wmWindow(await property())) {
        if (wm.child.exitCode !== null || wm.child.signalCode !== null) throw new Error('The private window manager exited before becoming ready.')
        break
      }
      if (performance.now() >= deadline) throw new Error('The private window manager did not become ready.')
      await pause(50)
    }
    command = launch(argv, env, 'inherit', observe)
    const result = await Promise.race([command.exited, wm.exited.then(() => { throw new Error('The private window manager exited during desktop tests.') }), cancelled.promise])
    if (result.signal) throw new Error(`Desktop test command ended by ${result.signal}.`)
    return result.code
  } catch (error) {
    throw new Error(`${error.message}${stderr.length ? '\nWindow manager: ' + stderr.toString('utf8') : ''}`, { cause: error })
  } finally {
    cancelled.dispose()
    try { await stopOwned(command) } finally { await stopOwned(wm) }
  }
}

export async function withTestDesktop(argv, { platform = process.platform, env = process.env, signal } = {}) {
  if (!argv.length) throw new Error('Supply the desktop test command.')
  const token = randomUUID()
  const command = platform === 'linux'
    ? ['xvfb-run', '-a', '-s', '-screen 0 1920x1080x24', process.execPath, script, '--managed', token, ...argv]
    : argv
  const owned = launch(command, { ...env, [marker]: token }, 'inherit')
  const cancelled = cancellation(signal)
  try {
    const result = await Promise.race([owned.exited, cancelled.promise])
    if (result.signal) throw new Error(`Desktop wrapper ended by ${result.signal}.`)
    return result.code
  // The inner wrapper has bounded command/manager cleanup of its own. Let it
  // finish before escalating the outer Xvfb group, whose children include it.
  } finally { cancelled.dispose(); await stopOwned(owned, platform === 'linux' ? 20000 : 2000) }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const controller = new AbortController()
  const interrupted = () => controller.abort(new Error('Desktop tests interrupted by the runner.'))
  process.once('SIGTERM', interrupted); process.once('SIGINT', interrupted)
  try {
    const args = process.argv.slice(2)
    process.exitCode = args[0] === '--managed'
      ? await managedDesktop(args.slice(2), { token: args[1], signal: controller.signal })
      : await withTestDesktop(args, { signal: controller.signal })
  } catch (error) { console.error(error.message); process.exitCode = 1 }
  finally { process.removeListener('SIGTERM', interrupted); process.removeListener('SIGINT', interrupted) }
}
