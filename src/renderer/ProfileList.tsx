import { LockKeyhole, Plus, Search, Settings2, Star } from './WorkbenchIcons'
import { ActionMenu } from './ActionMenu'
import { MaterialFolderIcon, MaterialIcon } from './MaterialIcon'
import { useState } from 'react'
import { engineNames, type SavedConnectionProfile } from '../shared/contracts'
import { protectedProfile } from '../shared/connection-options'
import { ConnectionContextMenu } from './ConnectionContextMenu'
import type { ProfileConnectionState } from './profile-connections'

export function ProfileList({ profiles, connections, activeProfileId, full, ready, onNew, onOpen, onSwitch, onDuplicate, onImport, onExport, onDisconnect, onEdit, onDelete, onFavorite }: {
  profiles: SavedConnectionProfile[]; connections: ReadonlyMap<string, ProfileConnectionState>; activeProfileId?: string; full: boolean; ready: boolean
  onNew(): void; onOpen(profile: SavedConnectionProfile, independent?: boolean): void; onSwitch(profile: SavedConnectionProfile): void
  onDuplicate(profile: SavedConnectionProfile): void; onImport(): void; onExport(profile?: SavedConnectionProfile): void
  onDisconnect(profile: SavedConnectionProfile): void; onEdit(profile: SavedConnectionProfile): void; onDelete(profile: SavedConnectionProfile): void; onFavorite(id: string, favorite: boolean): void
}) {
  const [favorites, setFavorites] = useState(false)
  const [search, setSearch] = useState('')
  const words = search.trim().toLocaleLowerCase().split(/\s+/)
  const visible = profiles.filter(profile => (!favorites || profile.config.favorite) && words.every(word => [profile.config.name, profile.config.folder, engineNames[profile.config.engine], profile.config.host, profile.config.database, profile.config.user, profile.config.filePath].join(' ').toLocaleLowerCase().includes(word)))
  const folders = [...new Set(visible.map(profile => profile.config.folder || ''))].sort((a,b) => a.localeCompare(b))
  return <><div className="profile-heading"><span>Saved connections <span className="count">{visible.length}</span></span><div>{profiles.length > 0 && <button className="favorites-filter" aria-label="Favorites only" title="Show favorite connections" aria-pressed={favorites} onClick={() => setFavorites(!favorites)}><Star size={13} fill={favorites ? 'currentColor' : 'none'}/></button>}<ActionMenu label="Saved connection actions" items={[
    { label: 'Import connections', disabled: !ready, action: onImport },
    { label: 'Export connections without credentials', disabled: !ready || !profiles.length, action: () => onExport() }
  ]}><Settings2 size={13}/></ActionMenu><button aria-label="New saved profile" title="New saved profile" disabled={!ready} onClick={onNew}><Plus size={14}/></button></div></div>
  <label className="profile-search"><Search size={13}/><input aria-label="Search connections" placeholder="Search connections…" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setSearch('') } }}/></label>
  <div className="profile-list" role="region" aria-label="Saved connections">
    {folders.map(folder => {
      const rows = visible.filter(profile => (profile.config.folder || '') === folder).sort((a,b) => Number(Boolean(b.config.favorite)) - Number(Boolean(a.config.favorite)) || a.config.name.localeCompare(b.config.name)).map(profile => {
        const protectedConnection = protectedProfile(profile.config)
        const connection = connections.get(profile.id), connected = Boolean(connection?.connected), active = profile.id === activeProfileId
        const description = [engineNames[profile.config.engine], connected ? 'Connected' : 'Not connected', connection?.previousSettings && 'Open tabs use previous settings', active && (connection?.activePreviousSettings ? 'Active tab uses previous settings' : 'Used by the active tab'), profile.config.environment, protectedConnection && 'Protected connection', profile.config.ssh && 'SSH', profile.config.favorite && 'Favorite'].filter(Boolean).join(' · ')
        return <ConnectionContextMenu className={`profile-row${active ? ' active-profile' : ''}`} key={profile.id} name={profile.config.name} items={[
          { label: 'Connect', disabled: !ready || full || connected || connection?.busy, title: 'Open in a new query tab.', action: () => onOpen(profile) },
          { label: 'New shared query tab', disabled: !ready || full || !connected || connection?.busy, title: 'Share an open connection, including its transaction and temporary objects.', action: () => onOpen(profile) },
          { label: 'New independent connection', disabled: !ready || full || connection?.busy, title: 'Open a separate connection. Transactions and temporary objects are not shared; in-memory databases start empty.', action: () => onOpen(profile, true) },
          { label: 'Switch to open tab', disabled: !ready || !connection?.tabIds.length, action: () => onSwitch(profile) },
          { label: 'Disconnect', disabled: !ready || !(connected || connection?.previousSettings) || connection?.busy || Boolean(connection?.disconnectReason), title: connection?.disconnectReason ?? 'Disconnect all tabs using this saved connection, including previous settings; keep their SQL.', action: () => onDisconnect(profile) },
          { label: 'Edit connection', action: () => onEdit(profile) },
          { label: 'Duplicate connection', disabled: !ready, title: 'Review a new saved profile without copying credentials.', action: () => onDuplicate(profile) },
          { label: 'Export connection without credentials', disabled: !ready, action: () => onExport(profile) },
          { label: 'Delete connection', title: 'Remove this saved connection; the database is kept.', action: () => onDelete(profile) }
        ]}>
          <button className="profile-open" aria-current={active ? 'true' : undefined} aria-label={`Open ${profile.config.name} in new tab`} aria-description={description} title={`${profile.config.name}\n${description}\nOpen in a new tab using this connection
Right-click or press Shift+F10 for connection actions`} aria-disabled={full || !ready} aria-keyshortcuts="Shift+F10" onClick={() => { if (ready && !full) onOpen(profile) }}><MaterialIcon name="database"/><span><span className="profile-name"><strong>{profile.config.name}</strong>{connected && <i className="online-dot" title="Connected" aria-hidden="true"/>}</span><small>{engineNames[profile.config.engine]}{profile.config.ssh ? ' · SSH' : ''}</small>{connection?.previousSettings && <small>Open tabs use previous settings</small>}{(profile.config.environment || protectedConnection) && <span className="profile-safety">{profile.config.environment && <span>{profile.config.environment}</span>}{protectedConnection && <span><LockKeyhole size={11}/>Protected</span>}</span>}</span></button>
          <button aria-label={`Favorite ${profile.config.name}`} title={`${profile.config.favorite ? 'Remove favorite' : 'Favorite'} ${profile.config.name}`} aria-pressed={Boolean(profile.config.favorite)} onClick={() => onFavorite(profile.id, !profile.config.favorite)}><Star size={13} fill={profile.config.favorite ? 'currentColor' : 'none'}/></button>
        </ConnectionContextMenu>
      })
      return !folder && folders.length === 1 ? <div key={folder}>{rows}</div> : <details className="profile-folder" key={folder} open><summary><MaterialFolderIcon/>{folder || 'Unfiled'} <small>{rows.length}</small></summary>{rows}</details>
    })}{!visible.length && <p className="sidebar-description">{search.trim() ? 'No matching connections.' : favorites ? 'No favorite profiles.' : 'No saved connections.'}</p>}
  </div></>
}
