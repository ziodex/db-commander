import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_PROFILE, MAX_PROFILES, type SavedConnectionProfile } from '../../src/shared/contracts'
import { copyProfileName, parseProfileDocument, planProfileImport, PROFILE_FILE_LIMIT, profileDocument } from '../../src/shared/profile-files'
import { readProfileFile, writeProfileFile } from '../../src/main/profile-files'

const directories: string[] = []
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })
async function directory() { const path = await mkdtemp(join(tmpdir(), 'dbcommander-profiles-')); directories.push(path); return path }
const saved: SavedConnectionProfile = { id: '00000000-0000-4000-8000-000000000001', credential: 'os-store', config: { ...DEFAULT_PROFILE, name: 'Reporting', folder: 'Team', favorite: true, environment: 'production', protected: true } }

it('exports portable configuration without IDs, passwords, tokens, SSH secrets or credential references', () => {
  const input = { ...saved, config: { ...saved.config, password: 'password-secret', accessToken: 'token-secret', sshSecrets: { password: 'ssh-secret', passphrase: 'phrase-secret' } } }
  const output = profileDocument([input])
  expect(output.profiles).toEqual([saved.config])
  for (const text of ['secret', 'credential', saved.id, 'password', 'accessToken', 'sshSecrets']) expect(JSON.stringify(output)).not.toContain(text)
  expect(input.config.password).toBe('password-secret')
  expect(output.profiles[0]).not.toBe(saved.config)
})
it('rejects unknown fields, credentials, invalid engines/endpoints and excessive profile counts without echoing data', () => {
  const base = profileDocument([saved])
  for (const patch of [{ password: 'private-password' }, { accessToken: 'private-token' }, { credential: 'os-store' }, { id: saved.id }, { sshSecrets: { password: 'private-ssh' } }, { engine: 'invalid' }, { port: 0 }]) {
    expect(() => parseProfileDocument({ ...base, profiles: [{ ...saved.config, ...patch }] })).toThrow('valid Db Commander connections file')
    try { parseProfileDocument({ ...base, profiles: [{ ...saved.config, ...patch }] }) } catch (error) { expect((error as Error).message).not.toContain('private-') }
  }
  for (const document of [{ ...base, version: 2 }, { ...base, format: 'other' }, { ...base, extra: true }, { ...base, profiles: [] }, { ...base, profiles: Array(MAX_PROFILES + 1).fill(saved.config) }]) expect(() => parseProfileDocument(document)).toThrow()
})
it('plans reviewed imports without replacing existing profiles and handles collisions within the incoming file', () => {
  const incoming = [saved.config, { ...DEFAULT_PROFILE, name: 'New server' }, { ...DEFAULT_PROFILE, name: 'new SERVER' }]
  const skipped = planProfileImport([saved.config], incoming, [0, 1, 2], 'skip')
  expect(skipped.map(item => item.skip)).toEqual([true, false, true])
  const copied = planProfileImport([saved.config], incoming, [0, 1, 2], 'copy')
  expect(copied.map(item => item.config.name)).toEqual(['Reporting copy', 'New server', 'new SERVER copy'])
  expect(planProfileImport([saved.config], incoming, [1, 1], 'copy')).toHaveLength(1)
  expect(planProfileImport([saved.config], incoming, [], 'copy')).toEqual([])
  expect(saved.config.name).toBe('Reporting')
  const long = { ...DEFAULT_PROFILE, name: 'A'.repeat(100) }
  expect(copyProfileName(long.name, [long])).toHaveLength(100)
  expect(copyProfileName('Reporting', [saved.config, { ...saved.config, name: 'Reporting copy' }])).toBe('Reporting copy 2')
})
it('round-trips a complete JSON file and refuses replacement, malformed UTF-8 and oversized inputs', async () => {
  const root = await directory(), path = join(root, 'connections.json'), document = profileDocument([saved])
  await writeProfileFile(path, document)
  expect(await readProfileFile(path)).toEqual(document)
  await expect(writeProfileFile(path, document)).rejects.toThrow('already exists')
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(document)
  await expect(writeProfileFile(join(root, 'connections.txt'), document)).rejects.toThrow('.json')
  const bad = join(root, 'bad.json'); await writeFile(bad, Buffer.from([0xff]))
  await expect(readProfileFile(bad)).rejects.toThrow('UTF-8 JSON')
  await writeFile(bad, Buffer.alloc(PROFILE_FILE_LIMIT + 1))
  await expect(readProfileFile(bad)).rejects.toThrow('8 MiB')
})
