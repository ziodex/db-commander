import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { DesktopApi, Workspace } from '../shared/contracts'
import { workspaceSqlLimit } from '../shared/workspace-limits'

export function useWorkspaceRecovery(
  api: Pick<DesktopApi, 'loadWorkspace' | 'saveWorkspace'>,
  initial: () => Workspace,
  onRecovered: (workspace: Workspace, notice?: string) => void,
  onError: (error: unknown) => void
) {
  const [workspace, setWorkspaceState] = useState(initial)
  const workspaceRef = useRef(workspace)
  const [ready, setReady] = useState(false)
  const readyRef = useRef(false)
  const [workspaceLoadError, setWorkspaceLoadError] = useState('')
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveAnnouncement, setSaveAnnouncement] = useState('')
  const previousSaveError = useRef('')
  const saveSequence = useRef(Promise.resolve())
  const recovered = useEffectEvent(onRecovered)
  const report = useEffectEvent(onError)
  const message = (error: unknown) => error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
    : String(error)

  function updateWorkspace(next: Workspace) {
    workspaceRef.current = next
    setWorkspaceState(next)
    setSaved(false)
  }

  function persist(): Promise<void> {
    if (!readyRef.current) return Promise.reject(new Error('Workspace recovery has not finished.'))
    const snapshot = workspaceRef.current
    const pending = saveSequence.current.catch(() => {}).then(() => {
      const limit = workspaceSqlLimit(snapshot.tabs)
      if (limit) throw new Error(limit)
      return api.saveWorkspace(snapshot)
    })
    saveSequence.current = pending
    return pending.then(() => {
      if (workspaceRef.current === snapshot) { setSaved(true); setSaveError('') }
    }, error => { setSaved(false); setSaveError(message(error)); throw error })
  }

  const autosave = useEffectEvent(persist)
  useEffect(() => {
    let disposed = false
    void api.loadWorkspace().then(loaded => {
      if (disposed) return
      if (loaded) {
        const { recoveryNotice, ...value } = loaded
        workspaceRef.current = value
        setWorkspaceState(value)
        recovered(value, recoveryNotice)
      }
      readyRef.current = true
      setReady(true)
    }).catch(error => {
      if (!disposed) { setWorkspaceLoadError(message(error)); report(error) }
    })
    return () => { disposed = true }
  }, [api])

  useEffect(() => {
    if (!ready) return
    const timer = setTimeout(() => { void autosave().catch(error => report(error)) }, 250)
    return () => clearTimeout(timer)
  }, [workspace, ready])

  useEffect(() => {
    if (saveError) setSaveAnnouncement('Workspace not saved. Use Retry workspace save.')
    else if (previousSaveError.current) setSaveAnnouncement('Workspace saved locally.')
    previousSaveError.current = saveError
  }, [saveError])

  return { workspace, workspaceRef, updateWorkspace, ready, readyRef, workspaceLoadError, saved, saveError, saveAnnouncement, persist }
}
