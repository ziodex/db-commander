import { constants, type Stats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { absoluteFile } from '../backup/files'
import type { Cell } from '../shared/contracts'

const identityOf = (stat: Stats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`

/** Keep one descriptor for the preview/import, and detect edits and path replacement. */
export async function openRecords(file: string, parse: (chunks: AsyncIterable<string>) => AsyncGenerator<Cell[]>) {
  absoluteFile(file)
  const before = await lstat(file)
  if (!before.isFile()) throw new Error('Choose a regular UTF-8 data file, not a directory or symbolic link.')
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat(), identity = identityOf(stat)
    if (!stat.isFile() || identity !== identityOf(before)) throw new Error('The source file changed while opening it. Preview the import again.')
    async function* chunks() {
      const decoder = new TextDecoder('utf-8', { fatal: true }), buffer = Buffer.alloc(64 * 1024)
      for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; yield decoder.decode(buffer.subarray(0, bytesRead), { stream: true }) }
      yield decoder.decode()
    }
    const records = parse(chunks()), first = await records.next()
    if (first.done || !first.value.length || first.value.some(value => !value) || new Set(first.value).size !== first.value.length) throw new Error('The first record must contain nonempty, unique column headers.')
    const headers = first.value as string[]
    return { headers, records, identity, async unchanged() {
      try { const current = await lstat(file); return current.isFile() && identityOf(current) === identity && identityOf(await handle.stat()) === identity } catch { return false }
    }, async close() { try { await records.return(undefined) } finally { await handle.close() } } }
  } catch (error) { await handle.close(); throw error }
}
