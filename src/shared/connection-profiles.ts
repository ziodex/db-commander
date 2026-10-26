import { DEFAULT_PROFILE, profileSchema, type ConnectionConfig, type ConnectionProfile, type SessionInfo, type WorkspaceTab } from './contracts'

export function connectionProfile(config: ConnectionConfig): ConnectionProfile {
  const { password: _password, accessToken: _accessToken, sshSecrets: _sshSecrets, ...profile } = config
  return profile
}

/** Default form values do not imply that a local database server exists. */
export function hasConfiguredConnection(tab: Pick<WorkspaceTab, 'profile' | 'profileId'>, session?: SessionInfo | null): boolean {
  return Boolean(session || tab.profileId || !sameConnectionProfile(tab.profile, DEFAULT_PROFILE))
}

/** Reconnecting may reuse a profile; changing settings must not overwrite it.
 * Schema order and explicit defaults make equivalent recovered/form values
 * comparable without depending on object insertion order or secret values. */
export function sameConnectionProfile(left: ConnectionProfile, right: ConnectionProfile): boolean {
  const normalize = (profile: ConnectionProfile) => profileSchema.safeParse({ ...profile,
    ca: profile.ca ?? '', authentication: profile.authentication ?? 'sql-password',
    folder: profile.folder ?? '', favorite: profile.favorite ?? false, protected: profile.protected ?? false, recordHistory: profile.recordHistory ?? true,
    sqliteMode: profile.engine === 'sqlite' ? profile.sqliteMode === 'create' ? 'read-write' : profile.sqliteMode ?? 'read-write' : profile.sqliteMode,
    duckdbMode: profile.engine === 'duckdb' ? profile.duckdbMode === 'create' ? 'read-write' : profile.duckdbMode ?? 'read-write' : profile.duckdbMode
  })
  const a = normalize(left), b = normalize(right)
  return a.success && b.success && JSON.stringify(a.data) === JSON.stringify(b.data)
}

/** Display organization does not change the endpoint or its session safeguards. */
export function sameConnectionSettings(left: ConnectionProfile, right: ConnectionProfile): boolean {
  return sameConnectionProfile({ ...left, name: right.name, folder: right.folder, favorite: right.favorite }, right)
}
