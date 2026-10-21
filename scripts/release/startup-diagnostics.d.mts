import type { ElectronApplication } from '@playwright/test'

export interface SqliteWorkerProbe {
  entry: string
  opened: boolean
  closed: boolean
  timedOut: boolean
  error?: string
  exitCode: number | null
  signal: NodeJS.Signals | 'unconfirmed' | null
  stderr: string
}
export function probeSqliteWorker(executable: string, entry: string, timeout?: number): Promise<SqliteWorkerProbe>
export function captureStartupDiagnostics(app: ElectronApplication, directory: string): () => Promise<{ stderr: string; probe: unknown }>
