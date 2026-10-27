import { fork } from 'node:child_process'

/** Probe only a test-owned in-memory SQLite worker after a startup failure.
 * Unlike the app's intentionally drained worker stderr, this retains bounded
 * loader diagnostics. It never opens the application's workspace/database. */
export function probeSqliteWorker(executable, entry, timeout = 10000) {
  return new Promise(resolve => {
    let stderr = '', opened = false, closed = false, timedOut = false, error, timer, deadline
    const child = fork(entry, [], { execPath: executable, execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    const finish = (exitCode, signal) => {
      clearTimeout(timer); clearTimeout(deadline)
      resolve({ entry, opened, closed, timedOut, error, exitCode, signal, stderr })
    }
    child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16000) })
    child.on('error', failure => { error = failure.message })
    child.on('message', message => {
      if (message.id === 'probe-open') {
        if (!message.ok) { error = message.error; child.kill('SIGKILL'); return }
        opened = true
        child.send({ id: 'probe-close', method: 'close' }, failure => { if (failure) { error = failure.message; child.kill('SIGKILL') } })
      } else if (message.id === 'probe-close') {
        closed = Boolean(message.ok)
        if (!closed) { error = message.error; child.kill('SIGKILL') }
      }
    })
    child.once('spawn', () => child.send({ id: 'probe-open', method: 'open', payload: { engine: 'sqlite', name: 'Startup diagnostic', sqliteMode: 'memory' } }, failure => { if (failure) { error = failure.message; child.kill('SIGKILL') } }))
    // close drains the stderr pipe before returning the retained result.
    child.once('close', finish)
    timer = setTimeout(() => {
      timedOut = true; child.kill('SIGKILL')
      deadline = setTimeout(() => finish(null, 'unconfirmed'), 2000)
    }, timeout)
  })
}

/** Test-only, bounded startup output; call collect only after a failed launch. */
export function captureStartupDiagnostics(app, directory) {
  let stderr = ''
  app.process().stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16000) })
  return async () => ({ stderr, probe: await app.evaluate(async ({ app, utilityProcess }, directory) => {
    const path = process.getBuiltinModule('path')
    const entry = path.join(app.getAppPath(), 'out/main/database-host.cjs')
    return new Promise(resolve => {
      const child = utilityProcess.fork(entry, [directory], { stdio: 'pipe' })
      let stderr = '', settled = false
      const finish = result => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); resolve({ entry, stderr, ...result }) }
      const timer = setTimeout(() => finish({ timeout: true }), 10000)
      child.stdout?.resume(); child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16000) })
      child.on('message', message => { if (message.ready) finish({ ready: true }) })
      // Let the pipe deliver output written immediately before the exit event.
      child.on('exit', code => setTimeout(() => finish({ exitCode: code }), 50))
    })
  }, directory).catch(error => ({ error: error.message })) })
}
