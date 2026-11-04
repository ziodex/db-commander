import type { ConnectionConfig } from '../shared/contracts'

// Host-owned grants survive internal config spreads and are absent from IPC,
// saved profiles, renderer objects and JSON persistence.
const grant = Symbol('Entra access-token provider')
type NativeConfig = ConnectionConfig & { [grant]?: () => Promise<string> }

export function withEntraToken(config: ConnectionConfig, provider: () => Promise<string>): ConnectionConfig {
  return { ...config, [grant]: provider } as NativeConfig
}

export async function resolveEntraToken(config: ConnectionConfig): Promise<ConnectionConfig> {
  if (config.authentication !== 'entra-interactive') return config
  const provider = (config as NativeConfig)[grant]
  if (!provider) throw new Error('Sign in to Microsoft Entra before opening this connection.')
  const accessToken = await provider()
  return { ...config, accessToken }
}
