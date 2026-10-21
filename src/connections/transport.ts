import type { ConnectionConfig } from '../shared/contracts'

// A symbol cannot cross IPC or be supplied in a saved profile. Object spreads
// inside native adapters retain it for metadata and cancellation connections.
const transport = Symbol('host-owned SSH transport')
export interface Endpoint { host: string; port: number }
type RoutedConfig = ConnectionConfig & { [transport]?: Endpoint }
export function endpoint(config: ConnectionConfig): Endpoint { return (config as RoutedConfig)[transport] ?? { host: config.host, port: config.port } }
export function routed(config: ConnectionConfig, address: Endpoint): ConnectionConfig { return { ...config, [transport]: address } as RoutedConfig }
export function isRouted(config: ConnectionConfig) { return Boolean((config as RoutedConfig)[transport]) }
