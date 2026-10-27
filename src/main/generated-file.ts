import { constants, type Stats } from 'node:fs'
import { access, link, lstat, mkdtemp, open, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

async function existing(path: string) {
  try { return await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
}
const identity = (value: Stats) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`
const exists = () => Object.assign(new Error('EEXIST: This file already exists. Choose a new filename.'), { code: 'EEXIST' })

/** Publish complete UTF-8 output; replacement is only for native Save dialogs
 * that already permit overwriting a selected regular file. */
export async function writeGeneratedFile(path: string, text: string, options: { replace?: boolean } = {}) {
  if (!isAbsolute(path)) throw new Error('Choose an absolute destination path.')
  const before = await existing(path)
  if (before) {
    if (!options.replace) throw exists()
    if (!before.isFile()) throw new Error('Choose a regular file, not a directory or symbolic link.')
    await access(path, constants.W_OK)
  }
  const directory = await mkdtemp(join(dirname(path), '.dbcommander-save-')), temporary = join(directory, 'content')
  try {
    const file = await open(temporary, 'wx', 0o600)
    try { await file.writeFile(text, 'utf8'); await file.sync(); await file.close() }
    finally { await file.close().catch(() => {}) }
    if (before) {
      const current = await existing(path)
      if (!current?.isFile() || identity(current) !== identity(before)) throw new Error('The destination changed while saving. Review the file and save again.')
      await rename(temporary, path)
    } else {
      try { await link(temporary, path) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw exists(); throw error }
    }
  } finally { await rm(directory, { recursive: true, force: true }).catch(() => {}) }
}
