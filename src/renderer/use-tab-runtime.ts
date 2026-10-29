import { useRef, useState, type RefObject } from 'react'
import type { Workspace } from '../shared/contracts'
import type { QueryTabState } from './query-tabs'
import { patchSessionState, reconcileSessionBusy } from './shared-sessions'
import { rendererError } from './workspace-runtime'

export function useTabRuntime(workspaceRef: RefObject<Workspace>) {
  const activeTabId = workspaceRef.current.activeTabId
  const [states, setStates] = useState<Record<string, QueryTabState>>({})
  const statesRef = useRef(states)

  function changeStates(update: (previous: Record<string, QueryTabState>) => Record<string, QueryTabState>) {
    const next = reconcileSessionBusy(update(statesRef.current))
    statesRef.current = next
    setStates(next)
  }

  function patchState(id: string, patch: Partial<QueryTabState>) {
    if (!workspaceRef.current.tabs.some(tab => tab.id === id)) return
    changeStates(previous => patchSessionState(previous, id, patch))
  }

  function report(error: unknown, id = activeTabId) {
    patchState(id, { error: rendererError(error), failure: undefined })
  }

  return { states, statesRef, changeStates, patchState, report }
}
