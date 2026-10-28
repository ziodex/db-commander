import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { writeGeneratedFile } from './generated-file'
import { PROFILE_FILE_LIMIT, parseProfileDocument, type ProfileDocument } from '../shared/profile-files'

export async function readProfileFile(path: string): Promise<ProfileDocument> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile()) throw new Error('Choose a regular JSON file.')
    if (before.size > PROFILE_FILE_LIMIT) throw new Error('Connections files may be at most 8 MiB.')
    const data = Buffer.alloc(Math.min(before.size + 1, PROFILE_FILE_LIMIT + 1))
    let length = 0
    while (length < data.length) {
      const { bytesRead } = await file.read(data, length, data.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    const after = await file.stat()
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('The connections file changed while reading. Choose it again.')
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(0, length))) }
    catch { throw new Error('Choose a valid UTF-8 JSON connections file.') }
    return parseProfileDocument(value)
  } finally { await file.close() }
}
export async function writeProfileFile(path: string, document: ProfileDocument) {
  if (!path.toLowerCase().endsWith('.json')) throw new Error('Choose a new filename ending in .json.')
  const text = JSON.stringify(parseProfileDocument(document), null, 2) + '\n'
  if (Buffer.byteLength(text) > PROFILE_FILE_LIMIT) throw new Error('Connections files may be at most 8 MiB.')
  await writeGeneratedFile(path, text)
}
