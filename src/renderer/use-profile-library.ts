import { useRef, useState, type RefObject } from 'react'
import { MAX_PROFILES, type ConnectionProfile, type DesktopApi, type SavedConnectionProfile, type Workspace } from '../shared/contracts'
import { copyProfileName, planProfileImport, profileDocument, type ProfileImport } from '../shared/profile-files'

export function useProfileLibrary({ api, workspaceRef, changeWorkspace, persist, report, notice, onDraft }: {
  api: DesktopApi; workspaceRef: RefObject<Workspace>; changeWorkspace(update: (workspace: Workspace) => Workspace): void
  persist(): Promise<void>; report(error: unknown): void; notice(text: string): void; onDraft(config: ConnectionProfile): void
}) {
  const [preview, setPreview] = useState<ProfileImport | null>(null), [busy, setBusy] = useState(false)
  const operation = useRef(false)
  async function fileAction(action: () => Promise<void>) {
    if (operation.current) return
    operation.current = true; setBusy(true)
    try { await action() } catch (error) { report(error) }
    finally { operation.current = false; setBusy(false) }
  }
  function duplicate(profile: SavedConnectionProfile) {
    if (workspaceRef.current.profiles.length >= MAX_PROFILES) { report(new Error('Delete an unused saved connection before duplicating one.')); return }
    const config = profileDocument([profile]).profiles[0]
    onDraft({ ...config, name: copyProfileName(config.name, workspaceRef.current.profiles.map(profile => profile.config)) })
  }
  async function apply(selected: number[], duplicates: 'skip' | 'copy') {
    if (!preview || operation.current) return
    const profiles = planProfileImport(workspaceRef.current.profiles.map(profile => profile.config), preview.document.profiles, selected, duplicates).filter(item => !item.skip)
    if (!profiles.length) throw new Error('Select a new connection or choose to keep duplicate names as copies.')
    if (workspaceRef.current.profiles.length + profiles.length > MAX_PROFILES) throw new Error(`Only ${MAX_PROFILES - workspaceRef.current.profiles.length} saved connection slots remain. Select fewer profiles or delete unused connections.`)
    operation.current = true; setBusy(true)
    try {
      const additions = profiles.map(({ config }) => ({ id: crypto.randomUUID(), config }))
      changeWorkspace(workspace => ({ ...workspace, profiles: [...workspace.profiles, ...additions] }))
      setPreview(null)
      try { await persist(); notice(`${additions.length} ${additions.length === 1 ? 'connection' : 'connections'} imported`) }
      catch { report(new Error('Connections were added to this workspace but could not be saved. Use Retry workspace save before closing.')) }
    } finally { operation.current = false; setBusy(false) }
  }
  return { preview, busy, duplicate, apply, close: () => { if (!operation.current) setPreview(null) },
    importProfiles: () => fileAction(async () => { const imported = await api.importConnectionProfiles(); if (imported) setPreview(imported) }),
    exportProfiles: (profile?: SavedConnectionProfile) => fileAction(async () => { await persist(); if (await api.exportConnectionProfiles(profile ? [profile.id] : undefined)) notice('Connections exported without credentials') }) }
}
