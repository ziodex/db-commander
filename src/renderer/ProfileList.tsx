import { Database, LockKeyhole, MoreHorizontal, Plus, Star } from 'lucide-react'
import { useState } from 'react'
import { engineNames, type SavedConnectionProfile } from '../shared/contracts'
import { protectedProfile } from '../shared/connection-options'
import { ActionMenu } from './ActionMenu'

export function ProfileList({ profiles, full, ready, onNew, onOpen, onEdit, onDelete, onFavorite }: { profiles: SavedConnectionProfile[]; full: boolean; ready: boolean; onNew(): void; onOpen(profile: SavedConnectionProfile): void; onEdit(profile: SavedConnectionProfile): void; onDelete(profile: SavedConnectionProfile): void; onFavorite(id: string, favorite: boolean): void }) {
  const [favorites, setFavorites] = useState(false)
  const visible = profiles.filter(profile => !favorites || profile.config.favorite)
  const folders = [...new Set(visible.map(profile => profile.config.folder || ''))].sort((a,b) => a.localeCompare(b))
  return <><div className="profile-heading"><span>Saved connections <span className="count">{visible.length}</span></span><div>{profiles.length > 0 && <button className="favorites-filter" aria-label="Favorites only" title="Show favorite connections" aria-pressed={favorites} onClick={() => setFavorites(!favorites)}><Star size={13} fill={favorites ? 'currentColor' : 'none'}/></button>}<button aria-label="New saved profile" title="New saved profile" disabled={!ready} onClick={onNew}><Plus size={14}/></button></div></div><div className="profile-list" role="region" aria-label="Saved connections">
    {folders.map(folder => {
      const rows = visible.filter(profile => (profile.config.folder || '') === folder).sort((a,b) => Number(Boolean(b.config.favorite)) - Number(Boolean(a.config.favorite)) || a.config.name.localeCompare(b.config.name)).map(profile => {
        const protectedConnection = protectedProfile(profile.config)
        const description = [engineNames[profile.config.engine], profile.config.environment, protectedConnection && 'Protected connection', profile.config.ssh && 'SSH', profile.config.favorite && 'Favorite'].filter(Boolean).join(' · ')
        return <div className="profile-row" key={profile.id}>
          <button className="profile-open" aria-label={`Open ${profile.config.name} in new tab`} aria-description={description} title={`${profile.config.name}\n${description}\nOpen in a new tab with a separate session`} disabled={full} onClick={() => onOpen(profile)}><Database size={14}/><span><strong>{profile.config.name}</strong><small>{engineNames[profile.config.engine]}{profile.config.ssh ? ' · SSH' : ''}</small>{(profile.config.environment || protectedConnection) && <span className="profile-safety">{profile.config.environment && <span>{profile.config.environment}</span>}{protectedConnection && <span><LockKeyhole size={11}/>Protected</span>}</span>}</span></button>
          <button aria-label={`Favorite ${profile.config.name}`} title={`${profile.config.favorite ? 'Remove favorite' : 'Favorite'} ${profile.config.name}`} aria-pressed={Boolean(profile.config.favorite)} onClick={() => onFavorite(profile.id, !profile.config.favorite)}><Star size={13} fill={profile.config.favorite ? 'currentColor' : 'none'}/></button>
          <ActionMenu label={`Actions for ${profile.config.name}`} items={[
            { label: `Edit profile ${profile.config.name}`, action: () => onEdit(profile) },
            { label: `Delete profile ${profile.config.name}`, title: 'Remove this saved profile; the database is kept.', action: () => onDelete(profile) }
          ]}><MoreHorizontal size={15}/></ActionMenu>
        </div>
      })
      return !folder && folders.length === 1 ? <div key={folder}>{rows}</div> : <details className="profile-folder" key={folder} open><summary>{folder || 'Unfiled'} <small>{rows.length}</small></summary>{rows}</details>
    })}{!visible.length && <p className="sidebar-description">{favorites ? 'No favorite profiles.' : 'No saved connections.'}</p>}
  </div></>
}
