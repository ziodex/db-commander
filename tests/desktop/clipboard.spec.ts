import { waitForWorkspaceReady } from './workspace-ready'
import { _electron as electron, test, expect, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { withClipboard } from './clipboard-fixture'

async function launch() {
  const directory = mkdtempSync(join(tmpdir(), 'dbcommander-clipboard-'))
  const env: Record<string, string | undefined> = { ...process.env, SQLCOMMANDER_USER_DATA: directory }; delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ ...(process.env.SQLCOMMANDER_TEST_EXECUTABLE ? { executablePath: resolve(process.env.SQLCOMMANDER_TEST_EXECUTABLE) } : { args: [resolve('.')] }), env: env as Record<string, string> })
  try { const page = await app.firstWindow(); await waitForWorkspaceReady(page); return { app, page, directory } }
  catch (error) { await close(app, directory); throw error }
}
async function close(app: ElectronApplication, directory: string) {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {})
  rmSync(directory, { recursive: true, force: true })
}

test('clipboard copy waits for native publication and reports write failures', async () => {
  const { app, page, directory } = await launch()
  try {
    await withClipboard(app, async () => {
      await app.evaluate(({ clipboard }) => {
        const original = clipboard.writeText.bind(clipboard)
        const control = { original, started: false, pending: Promise.resolve(), release: () => {} }
        ;(globalThis as any).__clipboardWrite = control
        clipboard.writeText = text => control.pending = new Promise<void>((resolve, reject) => {
          control.started = true; control.release = () => { control.release = () => {}; void original(text).then(resolve, reject) }
        })
      })
      try {
        await page.evaluate(() => {
          ;(window as any).__copyOutcome = 'pending'
          void window.dbCommander.copyDefinition('-- copied fixture').then(() => { (window as any).__copyOutcome = 'completed' }, error => { (window as any).__copyOutcome = error.message })
        })
        await expect.poll(() => app.evaluate(() => (globalThis as any).__clipboardWrite.started)).toBe(true)
        expect(await page.evaluate(() => (window as any).__copyOutcome)).toBe('pending')
        await app.evaluate(() => (globalThis as any).__clipboardWrite.release())
        await expect.poll(() => page.evaluate(() => (window as any).__copyOutcome)).toBe('completed')
        expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('-- copied fixture')
        await app.evaluate(({ clipboard }) => { clipboard.writeText = async () => { throw new Error('Injected native clipboard failure') } })
        const failure = await page.evaluate(() => window.dbCommander.copyDefinition('-- failure fixture').then(() => 'unexpected success', error => error.message))
        expect(failure).toContain('Injected native clipboard failure')
        expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('-- copied fixture')
        await app.evaluate(({ clipboard }) => { clipboard.writeText = (globalThis as any).__clipboardWrite.original })
        await page.evaluate(() => window.dbCommander.copyDefinition('-- explicit retry fixture'))
        expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('-- explicit retry fixture')
      } finally {
        await app.evaluate(async ({ clipboard }) => {
          const control = (globalThis as any).__clipboardWrite
          control.release(); await control.pending.catch(() => {}); clipboard.writeText = control.original
          delete (globalThis as any).__clipboardWrite
        })
      }
    })
  } finally { await close(app, directory) }
})

test('clipboard fixtures preserve text and HTML after successful and failed actions', async () => {
  const { app, directory } = await launch()
  try {
    await withClipboard(app, async () => {
      await app.evaluate(async ({ clipboard, ClipboardItem }) => {
        await clipboard.write([new ClipboardItem({ 'text/plain': 'original fixture', 'text/html': '<b>original fixture</b>' })])
      })
      for (const fail of [false, true]) {
        const changed = withClipboard(app, async () => {
          await app.evaluate(({ clipboard }) => clipboard.writeText('temporary fixture'))
          if (fail) throw new Error('Injected fixture failure')
        })
        if (fail) await expect(changed).rejects.toThrow('Injected fixture failure'); else await changed
        expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('original fixture')
        const html = await app.evaluate(async ({ clipboard }) => {
          const item = (await clipboard.read()).find(item => item.types.includes('text/html'))!
          return (await item.getType('text/html')).text()
        })
        expect(html).toContain('<b>original fixture</b>')
      }
      await app.evaluate(({ clipboard }) => clipboard.clear())
      await withClipboard(app, () => app.evaluate(({ clipboard }) => clipboard.writeText('temporary fixture')))
      expect(await app.evaluate(async ({ clipboard }) => (await clipboard.read()).flatMap(item => item.types).length)).toBe(0)
    })
  } finally { await close(app, directory) }
})
