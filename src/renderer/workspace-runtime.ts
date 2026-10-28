import type { RefObject } from 'react'
import type { Workspace, WorkspaceTab } from '../shared/contracts'
import type { QueryTabState } from './query-tabs'

/** Shared mutation boundary. Features keep their own operations and UI state;
 * all tab changes pass through the same session reconciliation and workspace save path. */
export interface WorkspaceRuntime {
  workspaceRef: RefObject<Workspace>
  statesRef: RefObject<Record<string, QueryTabState>>
  changeWorkspace(update: (previous: Workspace) => Workspace): void
  changeStates(update: (previous: Record<string, QueryTabState>) => Record<string, QueryTabState>): void
  patchState(id: string, patch: Partial<QueryTabState>): void
  patchTab(id: string, patch: Partial<WorkspaceTab>): void
  persist(): Promise<void>
  report(error: unknown, id?: string): void
}

export function rendererError(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(error)
}
