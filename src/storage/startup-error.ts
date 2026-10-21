/** Keep startup diagnostics actionable without treating other SQLite faults as full disks. */
export function workspaceStartupError(error: unknown, availableBytes?: number): string {
  const fault = error as { code?: string; errcode?: number } | null | undefined
  const sqlite = fault?.code === 'ERR_SQLITE_ERROR'
  if (fault?.code === 'ENOSPC' || (sqlite && (fault.errcode === 13 || (fault.errcode === 14 && availableBytes === 0)))) {
    return 'The workspace disk is full. Free disk space, then reload Db Commander to recover saved SQL buffers. No SQL was replayed.'
  }
  return error instanceof Error ? error.message : 'The workspace could not be opened.'
}
