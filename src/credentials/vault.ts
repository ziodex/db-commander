import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { z } from 'zod'
import { credentialBinding, passwordEligible, type PasswordStatus } from '../shared/credentials'
import type { ConnectionProfile, SavedConnectionProfile, Workspace } from '../shared/contracts'

interface CredentialEntry {
  getPassword(): Promise<string | null>
  setPassword(value: string): Promise<void>
  deleteCredential(): Promise<boolean>
}
export type EntryFactory = (service: string, account: string) => Promise<CredentialEntry>
const nativeEntry: EntryFactory = async (service, account) => {
  const { AsyncEntry } = await import('@napi-rs/keyring')
  // Never use the Linux library's automatic, nonpersistent keyutils fallback.
  return new AsyncEntry(service, account, { linux: { store: 'secret-service' } })
}
const recordSchema = z.object({ version: z.literal(1), profileId: z.string().uuid(), binding: z.string(), password: z.string().min(1).max(4096) }).strict()
const unavailable = 'The operating system credential store is unavailable or locked. Unlock it and retry, or use a session-only password. Linux requires a running Secret Service keyring.'
const fingerprint = (profile: ConnectionProfile) => createHash('sha256').update(credentialBinding(profile)).digest('hex')

/** Main-process broker. No method returning a secret is exposed through preload. */
export class PasswordVault {
  readonly service: string
  readonly backend: string
  private readonly legacyService: string
  constructor(directory: string, private entries: EntryFactory = nativeEntry, platform = process.platform) {
    const scope = createHash('sha256').update(resolve(directory)).digest('hex').slice(0, 24)
    this.service = `org.dbcommander.passwords.${scope}`
    this.legacyService = `org.sqlcommander.passwords.${scope}`
    this.backend = platform === 'darwin' ? 'macOS Keychain' : platform === 'win32' ? 'Windows Credential Manager' : 'Linux Secret Service'
  }
  async status(profile?: SavedConnectionProfile): Promise<PasswordStatus> {
    const saved = profile?.credential === 'os-store'
    try {
      await (await this.entries(this.service, 'availability-probe')).getPassword()
      return { available: true, saved, backend: this.backend }
    } catch { return { available: false, saved, backend: this.backend, reason: unavailable } }
  }
  async save(profile: SavedConnectionProfile, password: string): Promise<void> {
    if (!passwordEligible(profile.config) || !password || password.length > 4096) throw new Error('Only nonempty server passwords can be remembered. Access tokens are session-only.')
    const value = JSON.stringify({ version: 1, profileId: profile.id, binding: fingerprint(profile.config), password })
    try { await (await this.entries(this.service, profile.id)).setPassword(value) }
    catch { throw new Error('Password was not saved. ' + unavailable) }
  }
  async remove(profile: Pick<SavedConnectionProfile, 'id' | 'credential'>): Promise<void> {
    if (!profile.credential) return
    try {
      await (await this.entries(this.service, profile.id)).deleteCredential()
      await (await this.entries(this.legacyService, profile.id)).deleteCredential()
    }
    catch { throw new Error('Saved password could not be removed. ' + unavailable) }
  }
  async resolve(profile: SavedConnectionProfile, candidate: ConnectionProfile): Promise<string> {
    if (!profile.credential || !passwordEligible(candidate) || credentialBinding(profile.config) !== credentialBinding(candidate)) {
      throw new Error('Saved password does not match these connection settings. Enter a password explicitly.')
    }
    let value: string | null
    try {
      value = await (await this.entries(this.service, profile.id)).getPassword()
      // Old records retain the same strict profile and connection binding below.
      if (value === null) value = await (await this.entries(this.legacyService, profile.id)).getPassword()
    }
    catch { throw new Error(unavailable) }
    if (value === null) throw new Error('The saved password is missing from the operating system credential store. Enter it again or choose Remove saved password.')
    let record: unknown
    try { record = JSON.parse(value) } catch { throw new Error('Saved password entry is invalid. Remove it and save a replacement.') }
    const parsed = recordSchema.safeParse(record)
    if (!parsed.success || parsed.data.profileId !== profile.id || parsed.data.binding !== fingerprint(candidate)) {
      throw new Error('Saved password does not match this profile. Remove it and save a replacement.')
    }
    return parsed.data.password
  }
  /** Credential references belong to main, not renderer workspace writes. */
  prepareWorkspace(previous: Workspace | null, incoming: Workspace): Workspace {
    const profiles: SavedConnectionProfile[] = incoming.profiles.map(({ credential: _ignored, ...profile }) => profile)
    for (const old of previous?.profiles ?? []) {
      if (!old.credential) continue
      const next = profiles.find(profile => profile.id === old.id)
      if (next && credentialBinding(old.config) === credentialBinding(next.config) && passwordEligible(next.config)) next.credential = old.credential
    }
    return { ...incoming, profiles }
  }
}
