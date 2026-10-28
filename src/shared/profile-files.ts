import { z } from 'zod'
import { MAX_PROFILES, profileSchema, type ConnectionProfile, type SavedConnectionProfile } from './contracts'
import { connectionProfile } from './connection-profiles'

export const PROFILE_FILE_LIMIT = 8 * 1024 * 1024
const documentSchema = z.object({ format: z.literal('dbcommander-connections'), version: z.literal(1), profiles: z.array(profileSchema).min(1).max(MAX_PROFILES) }).strict()
export type ProfileDocument = z.infer<typeof documentSchema>
export interface ProfileImport { sourceName: string; document: ProfileDocument }
export function parseProfileDocument(value: unknown): ProfileDocument {
  const parsed = documentSchema.safeParse(value)
  if (!parsed.success) throw new Error('Choose a valid Db Commander connections file with 1–100 profiles and no passwords, tokens or credential references.')
  return parsed.data
}
export function profileDocument(profiles: SavedConnectionProfile[]): ProfileDocument {
  // Parse a fresh credential-free projection. IDs and OS-store references never
  // travel with a profile, including when a caller supplies a runtime config.
  return parseProfileDocument({ format: 'dbcommander-connections', version: 1, profiles: profiles.map(profile => connectionProfile({ ...profile.config, password: '' })) })
}
export function copyProfileName(name: string, existing: readonly ConnectionProfile[]) {
  const names = new Set(existing.map(profile => profile.name.toLocaleLowerCase()))
  for (let index = 1; ; index++) {
    const suffix = index === 1 ? ' copy' : ` copy ${index}`
    const candidate = name.slice(0, 100 - suffix.length) + suffix
    if (!names.has(candidate.toLocaleLowerCase())) return candidate
  }
}
export function planProfileImport(existing: readonly ConnectionProfile[], incoming: readonly ConnectionProfile[], selected: readonly number[], duplicates: 'skip' | 'copy') {
  const chosen = new Set(selected), names = [...existing]
  return incoming.flatMap((config, index) => {
    if (!chosen.has(index)) return []
    const duplicate = names.some(profile => profile.name.toLocaleLowerCase() === config.name.toLocaleLowerCase())
    if (duplicate && duplicates === 'skip') return [{ index, config, skip: true, renamed: false }]
    const next = profileSchema.parse({ ...config, name: duplicate ? copyProfileName(config.name, names) : config.name })
    names.push(next)
    return [{ index, config: next, skip: false, renamed: duplicate }]
  })
}
