import { randomUUID } from 'node:crypto'
import { lstat, opendir, realpath } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { z } from 'zod'
import type { SqlProject } from '../shared/sql-files'

export const projectRootSchema = z.object({ path: z.string().min(1).max(4096), device: z.string().regex(/^-?\d+$/), inode: z.string().regex(/^\d+$/) }).strict()
export type ProjectRoot = z.infer<typeof projectRootSchema>
const FILE_LIMIT = 500, ENTRY_LIMIT = 4_000, DEPTH_LIMIT = 12
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const sqlFile = (name: string) => /\.sql$/i.test(name) && !name.startsWith('.')

export async function chooseProjectRoot(path: string): Promise<ProjectRoot> {
  const canonical = await realpath(path), info = await lstat(canonical, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Choose a regular SQL project folder.')
  return projectRootSchema.parse({ path: canonical, device: String(info.dev), inode: String(info.ino) })
}

async function verifyRoot(root: ProjectRoot) {
  const info = await lstat(root.path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || String(info.dev) !== root.device || String(info.ino) !== root.inode ||
      !samePath(await realpath(root.path), root.path)) throw new Error('The project folder changed. Choose it again before opening files.')
}

/** Revalidate each component because a checkout can replace directories or
 * SQL files between listing and opening. The renderer holds only entry IDs. */
export async function verifyProjectPath(root: ProjectRoot, path: string, directory = false) {
  await verifyRoot(root)
  const tail = relative(root.path, path), names = tail ? tail.split(sep) : []
  if (isAbsolute(tail) || names.includes('..') || !directory && !sqlFile(basename(path))) {
    throw new Error('Choose a SQL file from the current project.')
  }
  let current = root.path
  let identity: Stats | undefined
  for (let index = 0; index < names.length; index++) {
    current = join(current, names[index])
    const info = await lstat(current)
    const expectedDirectory = directory || index < names.length - 1
    if (info.isSymbolicLink() || !(expectedDirectory ? info.isDirectory() : info.isFile())) {
      throw new Error('The project entry changed or is a symbolic link. Refresh the project list.')
    }
    identity = info
  }
  if (!samePath(await realpath(path), current)) throw new Error('The project entry resolves outside its listed path. Refresh the project list.')
  return identity
}

export async function listProject(root: ProjectRoot): Promise<{ project: SqlProject; entries: Map<string, string> }> {
  const folders = [{ path: root.path, depth: 0 }]
  const entries = new Map<string, string>()
  const files: SqlProject['files'] = []
  let visited = 0, limited = false, inaccessible = false
  for (let index = 0; index < folders.length; index++) {
    const { path, depth } = folders[index]
    if (visited >= ENTRY_LIMIT || files.length >= FILE_LIMIT) { limited = true; break }
    try {
      await verifyProjectPath(root, path, true)
      const folder = await opendir(path)
      for await (const entry of folder) {
        if (++visited > ENTRY_LIMIT || files.length >= FILE_LIMIT) { limited = true; break }
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
        const file = join(path, entry.name)
        if (entry.isDirectory() && entry.name !== 'node_modules') {
          if (depth >= DEPTH_LIMIT) limited = true
          else folders.push({ path: file, depth: depth + 1 })
        } else if (entry.isFile() && sqlFile(entry.name) && file.length <= 4096) {
          const id = randomUUID()
          entries.set(id, file)
          files.push({ id, relativePath: relative(root.path, file).split(sep).join('/') })
        }
      }
    } catch (error) {
      if (index === 0) throw error
      inaccessible = true
    }
  }
  await verifyRoot(root)
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }))
  return { project: { path: root.path, name: basename(root.path) || root.path, files, limited, inaccessible }, entries }
}
