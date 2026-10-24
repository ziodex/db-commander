import { LockKeyhole, Plus, Star } from './WorkbenchIcons'
import { MaterialFolderIcon, MaterialIcon } from './MaterialIcon'
import { useState } from 'react'
import { engineNames, type SavedConnectionProfile } from '../shared/contracts'
import { protectedProfile } from '../shared/connection-options'
import { ConnectionContextMenu } from './ConnectionContextMenu'

export interface ProfileConnectionState { connected: boolean; busy: boolean; disconnectReason?: string }

export function ProfileList({ profiles, connections, activeProfileId, full, ready, onNew, onOpen, onDisconnect, onEdit, onDelete, onFavorite }: { profiles: SavedConnectionProfile[]; connections: ReadonlyMap<string, ProfileConnectionState>; activeProfileId?: string; full: boolean; ready: boolean; onNew(): void; onOpen(profile: SavedConnectionProfile): void; onDisconnect(profile: SavedConnectionProfile): void; onEdit(profile: SavedConnectionProfile): void; onDelete(profile: SavedConnectionProfile): void; onFavorite(id: string, favorite: boolean): void }) {
  const [favorites, setFavorites] = useState(false)
  const visible = profiles.filter(profile => !favorites || profile.config.favorite)
  const folders = [...new Set(visible.map(profile => profile.config.folder || ''))].sort((a,b) => a.localeCompare(b))
  return <><div className="profile-heading"><span>Saved connections <span className="count">{visible.length}</span></span><div>{profiles.length > 0 && <button className="favorites-filter" aria-label="Favorites only" title="Show favorite connections" aria-pressed={favorites} onClick={() => setFavorites(!favorites)}><Star size={13} fill={favorites ? 'currentColor' : 'none'}/></button>}<button aria-label="New saved profile" title="New saved profile" disabled={!ready} onClick={onNew}><Plus size={14}/></button></div></div><div className="profile-list" role="region" aria-label="Saved connections">
    {folders.map(folder => {
      const rows = visible.filter(profile => (profile.config.folder || '') === folder).sort((a,b) => Number(Boolean(b.config.favorite)) - Number(Boolean(a.config.favorite)) || a.config.name.localeCompare(b.config.name)).map(profile => {
        const protectedConnection = protectedProfile(profile.config)
        const connection = connections.get(profile.id), connected = Boolean(connection?.connected), active = profile.id === activeProfileId
        const description = [engineNames[profile.config.engine], connected ? 'Connected' : 'Not connected', active && 'Used by the active tab', profile.config.environment, protectedConnection && 'Protected connection', profile.config.ssh && 'SSH', profile.config.favorite && 'Favorite'].filter(Boolean).join(' · ')
        return <ConnectionContextMenu className={`profile-row${active ? ' active-profile' : ''}`} key={profile.id} name={profile.config.name} items={[
          { label: 'Connect', disabled: !ready || full || connected || connection?.busy, title: 'Open in a new query tab.', action: () => onOpen(profile) },
          { label: 'Disconnect', disabled: !ready || !connected || connection?.busy || Boolean(connection?.disconnectReason), title: connection?.disconnectReason ?? 'Disconnect all tabs using this saved connection; keep their SQL.', action: () => onDisconnect(profile) },
          { label: 'Edit connection', action: () => onEdit(profile) },
          { label: 'Delete connection', title: 'Remove this saved connection; the database is kept.', action: () => onDelete(profile) }
        ]}>
          <button className="profile-open" aria-current={active ? 'true' : undefined} aria-label={`Open ${profile.config.name} in new tab`} aria-description={description} title={`${profile.config.name}\n${description}\nOpen in a new tab using this connection
Right-click or press Shift+F10 for connection actions`} aria-disabled={full} aria-keyshortcuts="Shift+F10" onClick={() => { if (!full) onOpen(profile) }}><MaterialIcon name="database"/><span><span className="profile-name"><strong>{profile.config.name}</strong>{connected && <i className="online-dot" title="Connected" aria-hidden="true"/>}</span><small>{engineNames[profile.config.engine]}{profile.config.ssh ? ' · SSH' : ''}</small>{(profile.config.environment || protectedConnection) && <span className="profile-safety">{profile.config.environment && <span>{profile.config.environment}</span>}{protectedConnection && <span><LockKeyhole size={11}/>Protected</span>}</span>}</span></button>
          <button aria-label={`Favorite ${profile.config.name}`} title={`${profile.config.favorite ? 'Remove favorite' : 'Favorite'} ${profile.config.name}`} aria-pressed={Boolean(profile.config.favorite)} onClick={() => onFavorite(profile.id, !profile.config.favorite)}><Star size={13} fill={profile.config.favorite ? 'currentColor' : 'none'}/></button>
        </ConnectionContextMenu>
      })
      return !folder && folders.length === 1 ? <div key={folder}>{rows}</div> : <details className="profile-folder" key={folder} open><summary><MaterialFolderIcon/>{folder || 'Unfiled'} <small>{rows.length}</small></summary>{rows}</details>
    })}{!visible.length && <p className="sidebar-description">{favorites ? 'No favorite profiles.' : 'No saved connections.'}</p>}
  </div></>
}
