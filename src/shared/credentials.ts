import type { ConnectionProfile } from './contracts'

export interface PasswordStatus { available: boolean; saved: boolean; backend: string; reason?: string }
export interface PasswordChoice { remember: boolean; useSaved: boolean }
export function passwordEligible(profile: ConnectionProfile): boolean {
  return !['sqlite', 'duckdb'].includes(profile.engine) && (!profile.authentication || profile.authentication === 'sql-password')
}
/** A saved secret is never silently reused for a different endpoint or trust policy. */
export function credentialBinding(profile: ConnectionProfile): string {
  return JSON.stringify([profile.engine, profile.host.trim(), profile.port, profile.database, profile.user,
    profile.authentication ?? 'sql-password', profile.tls, profile.ca?.trim() ?? '',
    ...(profile.ssh ? [[profile.ssh.host, profile.ssh.port, profile.ssh.user, profile.ssh.fingerprint, profile.ssh.authentication, profile.ssh.privateKeyPath ?? '', profile.ssh.destinationHost ?? '']] : [])])
}
