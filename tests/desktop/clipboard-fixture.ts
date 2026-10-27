import type { ElectronApplication } from '@playwright/test'
import { randomUUID } from 'node:crypto'

/** Snapshot all clipboard formats inside main; never serialize user data into traces. */
export async function withClipboard<T>(app: ElectronApplication, action: () => Promise<T>): Promise<T> {
  const token = randomUUID()
  await app.evaluate(async ({ clipboard, ClipboardItem }, token) => {
    const items = await clipboard.read(), saved = []
    for (const item of items) {
      if (!item.types.length) continue
      const data = Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)])))
      saved.push(new ClipboardItem(data))
    }
    ;((globalThis as any).__testClipboards ??= new Map()).set(token, saved)
  }, token)
  let failed = false
  try { return await action() }
  catch (error) { failed = true; throw error }
  finally {
    try {
      await app.evaluate(async ({ clipboard }, token) => {
        const saved = (globalThis as any).__testClipboards
        try {
          const items = saved.get(token)
          if (items.length) await clipboard.write(items); else clipboard.clear()
        } finally { saved.delete(token) }
      }, token)
    } catch (error) { if (!failed) throw error }
  }
}
