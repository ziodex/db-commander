import { expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeSqliteWorker } from '../../scripts/release/startup-diagnostics.mjs'

async function probe(source, timeout) {
  const root = mkdtempSync(join(tmpdir(), 'startup-worker-probe-')), entry = join(root, 'worker with spaces % # é.cjs')
  try { writeFileSync(entry, source); return await probeSqliteWorker(process.execPath, entry, timeout) }
  finally { rmSync(root, { recursive: true, force: true }) }
}

it('diagnoses a real IPC open/close cycle without opening a profile or database file', async () => {
  const result = await probe(`process.on('message', m => {
    if (m.method === 'open') {
      const safe = m.payload.sqliteMode === 'memory' && !m.payload.filePath;
      process.send({ id: m.id, ok: safe });
    } else if (m.method === 'close') { process.send({ id: m.id, ok: true }, () => process.disconnect()); }
  });`)
  expect(result).toMatchObject({ opened: true, closed: true, timedOut: false, exitCode: 0, signal: null })
})

it('retains bounded loader stderr and the actual exit code', async () => {
  const result = await probe(`process.stderr.write('x'.repeat(20000) + 'loader failed', () => process.exit(23));`)
  expect(result).toMatchObject({ opened: false, closed: false, timedOut: false, exitCode: 23 })
  expect(result.stderr).toHaveLength(16000); expect(result.stderr).toMatch(/loader failed$/)
})

it('retains an explicit worker rejection and stops its owned process', async () => {
  const result = await probe(`process.on('message', m => process.send({ id: m.id, ok: false, error: 'Open failed' }));`)
  expect(result).toMatchObject({ opened: false, closed: false, error: 'Open failed', signal: 'SIGKILL' })
})

it('bounds a stalled diagnostic and waits for its owned process to stop', async () => {
  const result = await probe(`setInterval(() => {}, 1000);`, 500)
  expect(result).toMatchObject({ opened: false, closed: false, timedOut: true, signal: 'SIGKILL' })
})
