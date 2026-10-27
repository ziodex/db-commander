import { constants } from 'node:fs'
import { open, link, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { parseSnippetDocument, SNIPPET_FILE_LIMIT, type SnippetDocument } from '../shared/snippet-files'

export async function readSnippetFile(path: string): Promise<SnippetDocument> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('Choose a regular JSON file.')
    if (stat.size > SNIPPET_FILE_LIMIT) throw new Error('Snippet files may be at most 32 MiB.')
    // Read from the opened descriptor, bounded even if the file grows meanwhile.
    const data = Buffer.alloc(Math.min(stat.size + 1, SNIPPET_FILE_LIMIT + 1))
    let length = 0
    while (length < data.length) { const { bytesRead } = await file.read(data, length, data.length - length, null); if (!bytesRead) break; length += bytesRead }
    const after = await file.stat()
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new Error('The snippet file changed while reading. Choose it again.')
    }
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length))) }
    catch { throw new Error('Choose a valid UTF-8 JSON snippet file.') }
    return parseSnippetDocument(value)
  } finally { await file.close() }
}

/** Publish only a complete file. Existing files and symlinks are never replaced. */
export async function writeSnippetFile(path: string, document: SnippetDocument) {
  if (!path.toLowerCase().endsWith('.json')) throw new Error('Choose a new filename ending in .json.')
  const text = JSON.stringify(parseSnippetDocument(document), null, 2) + '\n'
  if (Buffer.byteLength(text) > SNIPPET_FILE_LIMIT) throw new Error('Snippet files may be at most 32 MiB.')
  const temporary = join(dirname(path), `.dbcommander-snippets-${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(text, 'utf8'); await file.sync(); await file.close()
    try { await link(temporary, path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('This file already exists. Choose a new snippet filename.'); throw error }
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}) }
}
