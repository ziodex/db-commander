import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { check, type BackupContext } from './context'

export interface ToolCommand { executable: string; args: string[]; env?: NodeJS.ProcessEnv; input?: string; output?: string; prefix?: string }
type ToolRunner = (command: ToolCommand, context: BackupContext) => Promise<string>
export interface BackupOptions { runTool?: ToolRunner; temporaryRoot?: string }
async function stopGroup(pid: number) {
  const signal = async (value: NodeJS.Signals | 0) => {
    const reapingDeadline = performance.now() + 100
    for (;;) {
      try { process.kill(-pid, value); return true }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
        // Darwin can report EPERM for a group containing only an unreaped
        // zombie. Yield for reaping, but retain genuine permission failures.
        if (process.platform !== 'darwin' || (error as NodeJS.ErrnoException).code !== 'EPERM' || performance.now() >= reapingDeadline) throw error
        await delay(25)
      }
    }
  }
  if (!await signal('SIGTERM')) return
  const deadline = performance.now() + 3000
  while (await signal(0)) {
    if (performance.now() >= deadline) { await signal('SIGKILL'); return }
    await delay(25)
  }
}
/** No shell, bounded diagnostics, streaming files, and no passwords in argv. */
export const runTool: ToolRunner = async (command, context) => {
  check(context)
  // POSIX helpers inherit this private process group. Never signal the app's
  // own group, or assume that the tool's exit also closed its helpers' pipes.
  const grouped = process.platform !== 'win32'
  const child = spawn(command.executable, command.args, { env: command.env ?? process.env, detached: grouped, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', killTimer: NodeJS.Timeout | undefined
  let stopping = false, exited = false, processError: Error | undefined, launchError: Error | undefined
  let helpersStopped = Promise.resolve()
  const stop = () => {
    if (!stopping) {
      stopping = true
      if (grouped && child.pid) {
        helpersStopped = stopGroup(child.pid)
        helpersStopped.catch(() => {})
      } else if (!exited) {
        child.kill()
        killTimer = setTimeout(() => { if (!exited) child.kill('SIGKILL') }, 3000); killTimer.unref()
      }
    }
    // Settle both pipelines even if the tool never consumes stdin or no longer
    // produces stdout. Keep stderr available for the native failure diagnostic.
    child.stdin.destroy(); child.stdout.destroy()
  }
  child.once('exit', () => { exited = true; clearTimeout(killTimer) })
  context.signal.addEventListener('abort', stop, { once: true })
  const ended = new Promise<void>((resolve, reject) => {
    child.once('error', error => { launchError = new Error(`Could not start ${command.executable}: ${(error as NodeJS.ErrnoException).code ?? 'tool unavailable'}. Install the native client tools or choose their directory.`) })
    child.once('close', (code, signal) => {
      processError = launchError ?? (code === 0 ? undefined : new Error(stderr.trim() || `Native tool ${signal ? `stopped by ${signal}` : `exited with code ${code}`}.`))
      if (processError) reject(processError); else resolve()
    })
  })
  ended.catch(() => {})
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16384) })
  const streams: Promise<unknown>[] = []
  if (command.input) streams.push(pipeline(createReadStream(command.input), child.stdin))
  else child.stdin.end()
  if (command.output) {
    const output = createWriteStream(command.output, { flags: 'wx', mode: 0o600 })
    if (command.prefix) output.write(command.prefix)
    streams.push(pipeline(child.stdout, output))
  } else child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(0, 65536) })
  const streamed = Promise.all(streams)
  try {
    await Promise.all([ended, streamed]); check(context)
    if (stderr.trim()) context.log(stderr.trim())
    return stdout.trim()
  } catch (error) {
    stop()
    // Do not remove partial output or temporary credentials while the owned
    // process is still running. Stream failures use the same escalation as cancel.
    // Group escalation must finish even if the parent has already closed all
    // its pipes. Otherwise an ignored-stdio helper can survive cancellation.
    const settled = await Promise.allSettled([ended, streamed, helpersStopped])
    if (settled[2].status === 'rejected') throw new Error('Could not stop the native tool process group. Check for running client tools before retrying.')
    check(context)
    if (launchError) throw launchError
    const code = (error as NodeJS.ErrnoException).code
    // A native failure can close stdin early. Prefer its useful diagnostic to
    // the consequential broken pipe; real file I/O failures retain their cause.
    if ((code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE') && processError) throw processError
    throw error
  } finally {
    context.signal.removeEventListener('abort', stop); clearTimeout(killTimer)
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
    await streamed.catch(() => {})
  }
}
