import type { ConnectionConfig, SessionInfo } from '../shared/contracts'
import type { DatabaseDriver, Emit } from './driver'

/** Feature jobs reserve sessions through the registry's single operation owner. */
export interface SessionAccess {
  driver(id: string): DatabaseDriver
  decorate(session: SessionInfo): SessionInfo
  consume(queryId: string, receive: Emit): () => void
  config(id: string): ConnectionConfig
  running(id: string): boolean
  protect(id: string): void
  operation<T>(id: string, action: () => Promise<T>): Promise<T>
  wait(id: string): Promise<unknown> | undefined
}
