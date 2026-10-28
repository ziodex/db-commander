import { expect, it } from 'vitest'
import { DEFAULT_PROFILE, type SavedConnectionProfile, type WorkspaceTab, type SessionInfo } from '../../src/shared/contracts'
import { profileConnectionStates } from '../../src/renderer/profile-connections'
import { emptyTabState } from '../../src/renderer/query-tabs'

const profile: SavedConnectionProfile = { id: 'profile', config: { ...DEFAULT_PROFILE } }
const tab: WorkspaceTab = { id: 'tab', title: 'Query', sql: '', profileId: profile.id, profile: profile.config }
const session: SessionInfo = { ...profile.config, id: 'session', tls: true, transaction: 'idle', version: '' }
const connected = { ...emptyTabState(), session }

it('lists physical connections and tab owners separately for navigation', () => {
  const tabs = [tab, { ...tab, id: 'shared' }, { ...tab, id: 'independent' }]
  const result = profileConnectionStates([profile], tabs, { tab: connected, shared: connected, independent: { ...connected, session: { ...session, id: 'other-session' } } }, tab.id).get(profile.id)
  expect(result?.tabIds).toEqual(['tab', 'shared', 'independent'])
  expect(result?.sessionIds).toEqual(['session', 'other-session'])
})

it('distinguishes a connection using previous settings from the current saved profile', () => {
  const edited = { ...profile, config: { ...profile.config, engine: 'sqlite' as const, sqliteMode: 'memory' as const } }
  expect(profileConnectionStates([edited], [tab], { tab: connected }, tab.id).get(profile.id)).toMatchObject({
    connected: false, previousSettings: true, activePreviousSettings: true, busy: false
  })
})

it('reports both current and previous settings when both connections remain live', () => {
  const edited = { ...profile, config: { ...profile.config, host: 'new-host' } }
  const next = { ...tab, id: 'new', profile: edited.config }
  expect(profileConnectionStates([edited], [tab, next], { tab: connected, new: { ...connected, session: { ...session, id: 'new-session' } } }, next.id).get(profile.id)).toMatchObject({
    connected: true, previousSettings: true, activePreviousSettings: false
  })
})

it('keeps cosmetic edits connected but distinguishes changes in session safeguards', () => {
  const renamed = { ...profile, config: { ...profile.config, name: 'Renamed', folder: 'Team', favorite: true } }
  expect(profileConnectionStates([renamed], [tab], { tab: connected }, tab.id).get(profile.id)).toMatchObject({ connected: true, previousSettings: false })
  const protectedProfile = { ...profile, config: { ...profile.config, environment: 'production' as const } }
  expect(profileConnectionStates([protectedProfile], [tab], { tab: connected }, tab.id).get(profile.id)).toMatchObject({ connected: false, previousSettings: true })
  const privateProfile = { ...profile, config: { ...profile.config, recordHistory: false } }
  expect(profileConnectionStates([privateProfile], [tab], { tab: connected }, tab.id).get(profile.id)).toMatchObject({ connected: false, previousSettings: true })
})

it('retains transaction and operation guards on old connections and clears old-state notices on disconnect', () => {
  const edited = { ...profile, config: { ...profile.config, port: 9999 } }
  expect(profileConnectionStates([edited], [tab], { tab: { ...connected, session: { ...session, transaction: 'transaction' } } }, tab.id).get(profile.id)).toMatchObject({
    connected: false, previousSettings: true, disconnectReason: expect.stringContaining('Commit or roll back')
  })
  expect(profileConnectionStates([edited], [tab], { tab: { ...connected, closing: true } }, tab.id).get(profile.id)?.busy).toBe(true)
  expect(profileConnectionStates([edited], [tab], { tab: emptyTabState() }, tab.id).get(profile.id)).toMatchObject({ connected: false, previousSettings: false })
})
