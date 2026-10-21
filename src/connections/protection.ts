import { protectedProfile, type ConnectionSafety } from '../shared/connection-options'
import type { ConnectionConfig } from '../shared/contracts'

export class SessionProtection {
  private states = new Map<string, { config: ConnectionConfig; until: number }>()
  constructor(private now = Date.now) {}
  add(id: string, config: ConnectionConfig) { this.states.set(id, { config, until: 0 }) }
  forget(id: string) { this.states.delete(id) }
  clear() { this.states.clear() }
  status(id: string): ConnectionSafety {
    const state = this.states.get(id)
    if (!state) throw new Error('This session is disconnected.')
    return { environment: state.config.environment, protected: protectedProfile(state.config), unlockedUntil: state.until > this.now() ? state.until : 0,
      ...(state.config.ssh ? { ssh: { host: state.config.ssh.host, port: state.config.ssh.port, fingerprint: state.config.ssh.fingerprint } } : {}) }
  }
  unlock(id: string, confirmation: string) {
    const state = this.states.get(id)
    if (!state || confirmation !== state.config.name) throw new Error('Type the exact connection name to unlock this tab.')
    state.until = this.now() + 10 * 60_000
    return this.status(id)
  }
  lock(id: string) { const state = this.states.get(id); if (state) state.until = 0; return this.status(id) }
  assert(id: string) { const state = this.status(id); if (state.protected && !state.unlockedUntil) throw new Error('This protected connection is locked. Unlock this tab before executing SQL or changing data.') }
}
