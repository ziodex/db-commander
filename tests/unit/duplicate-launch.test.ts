import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { duplicateArguments, observeDuplicate } from '../desktop/duplicate-launch'

it('mirrors only the owner sandbox flag while excluding its debugger and loader arguments', () => {
  expect(duplicateArguments(['electron', '-r', 'debug-loader', '--inspect=0', '--no-sandbox', '--remote-debugging-port=0', '/project'], ['/project'])).toEqual(['--no-sandbox', '/project'])
  expect(duplicateArguments(['packaged-app', '--inspect=0'], [])).toEqual([])
})
it('retains bounded native startup stderr and the actual exit status', async () => {
  const child = spawn(process.execPath, ['-e', "process.stderr.write('x'.repeat(20000)+'native failure');process.exit(3)"], { stdio: ['ignore', 'ignore', 'pipe'] })
  const snapshot = observeDuplicate(child); await once(child, 'close')
  const result = snapshot(); expect(result.exitCode).toBe(3); expect(result.signalCode).toBeNull()
  expect(Buffer.byteLength(result.stderr)).toBe(16384); expect(result.stderr).toMatch(/native failure$/)
})
