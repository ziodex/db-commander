import type { Workspace } from '../shared/contracts'
import type { PasswordVault } from './vault'

interface CredentialWorkspaceStore {
  load(): Promise<Workspace | null>
  save(workspace: Workspace, removals: string[]): Promise<void>
  pendingRemovals(): Promise<string[]>
  completeRemoval(id: string): Promise<void>
}

/** Call under main's credential-operation queue, including password replacement. */
export class CredentialWorkspace {
  constructor(private vault: PasswordVault, private store: CredentialWorkspaceStore) {}

  async save(incoming: Workspace, removePasswordId?: string): Promise<void> {
    const previous = await this.store.load()
    const workspace = this.vault.prepareWorkspace(previous, incoming)
    if (removePasswordId) {
      const profile = workspace.profiles.find(profile => profile.id === removePasswordId)
      if (!profile) throw new Error('Saved profile no longer exists.')
      delete profile.credential
    }
    const removals = (previous?.profiles ?? []).filter(old => old.credential &&
      !workspace.profiles.some(profile => profile.id === old.id && profile.credential)).map(profile => profile.id)
    // Persist the new references and cleanup intent together. A rejected save
    // must never touch the vault; a crash after commit must leave cleanup retryable.
    await this.store.save(workspace, removals)
    await this.cleanup()
  }

  async removePassword(id: string): Promise<void> {
    const workspace = await this.store.load()
    if (!workspace) throw new Error('Saved profile no longer exists.')
    await this.save(workspace, id)
  }

  async cleanup(): Promise<void> {
    try {
      for (const id of await this.store.pendingRemovals()) {
        await this.vault.remove({ id, credential: 'os-store' })
        await this.store.completeRemoval(id)
      }
    } catch {
      throw new Error('Workspace changes are saved, but saved-password cleanup is pending. Unlock the operating system credential store, check free disk space, and retry saving. Cleanup will also be retried when reopening this workspace.')
    }
  }
}
