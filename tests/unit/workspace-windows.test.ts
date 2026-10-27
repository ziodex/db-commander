import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceWindowsStore } from '../../src/main/workspace-windows'
import { MAX_SAVED_WINDOWS } from '../../src/shared/workspace-windows'

it('saves isolated window identities, serializes creation and preserves primary paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dbcommander-windows-'))
  try {
    const store = new WorkspaceWindowsStore(root); await store.load()
    expect(store.directory('primary')).toBe(root)
    const [first, second] = await Promise.all([store.create(' Work '), store.create('Scratch')])
    expect(first.name).toBe('Work'); expect(first.id).not.toBe(second.id)
    expect(store.directory(first.id)).toBe(join(root, 'windows', first.id))
    for (const id of ['../../elsewhere', '/tmp/workspace', 'not-saved']) expect(() => store.directory(id)).toThrow()
    const reopened = new WorkspaceWindowsStore(root); await reopened.load()
    expect(reopened.list()).toEqual(store.list())
    reopened.list()[0].name = 'Cannot mutate owned records'
    expect(reopened.get('primary').name).toBe('Primary')
    await Promise.all(Array.from({ length: MAX_SAVED_WINDOWS - 3 }, (_, index) => store.create(`Window ${index}`)))
    await expect(store.create('Too many')).rejects.toThrow('At most')
    expect(store.list()).toHaveLength(MAX_SAVED_WINDOWS)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not overwrite a damaged registry or accept arbitrary directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dbcommander-windows-'))
  try {
    const file = join(root, 'windows.json'), malformed = '[{"id":"primary","name":"Primary","directory":"/tmp/unsafe"}]'
    await writeFile(file, malformed)
    const store = new WorkspaceWindowsStore(root)
    await expect(store.load()).rejects.toThrow('saved workspaces have been kept')
    await expect(store.create('Must not overwrite')).rejects.toThrow('saved workspaces have been kept')
    expect(await readFile(file, 'utf8')).toBe(malformed)
    expect(() => store.create('\n')).toThrow()
  } finally { await rm(root, { recursive: true, force: true }) }
})
