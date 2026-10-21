import { constants } from 'node:fs'
import { open, link, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { EDITOR_SETTINGS_FILE_LIMIT, parseEditorSettingsDocument, type EditorSettingsDocument } from '../shared/editor-settings-files'

export async function readEditorSettingsFile(path: string): Promise<EditorSettingsDocument> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile()) throw new Error('Choose a regular JSON file.')
    if (before.size > EDITOR_SETTINGS_FILE_LIMIT) throw new Error('Editor settings files may be at most 64 KiB.')
    // Bound the descriptor read even if another application grows the file.
    const data = Buffer.alloc(EDITOR_SETTINGS_FILE_LIMIT + 1)
    let length = 0
    while (length < data.length) {
      const { bytesRead } = await file.read(data, length, data.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > EDITOR_SETTINGS_FILE_LIMIT) throw new Error('Editor settings files may be at most 64 KiB.')
    const after = await file.stat()
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('The editor settings file changed while reading. Choose it again.')
    }
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length))) }
    catch { throw new Error('Choose a valid UTF-8 JSON editor settings file.') }
    return parseEditorSettingsDocument(value)
  } finally { await file.close() }
}

/** Export only a complete document to a new destination, never over another file. */
export async function writeEditorSettingsFile(path: string, document: EditorSettingsDocument): Promise<void> {
  if (!path.toLowerCase().endsWith('.json')) throw new Error('Choose a new filename ending in .json.')
  const text = JSON.stringify(parseEditorSettingsDocument(document), null, 2) + '\n'
  if (Buffer.byteLength(text) > EDITOR_SETTINGS_FILE_LIMIT) throw new Error('Editor settings files may be at most 64 KiB.')
  const temporary = join(dirname(path), `.dbcommander-editor-settings-${randomUUID()}.tmp`)
  const file = await open(temporary, 'wx', 0o600)
  try {
    await file.writeFile(text, 'utf8'); await file.sync(); await file.close()
    try { await link(temporary, path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('This file already exists. Choose a new editor settings filename.')
      throw error
    }
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}) }
}
