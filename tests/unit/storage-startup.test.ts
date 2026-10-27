import { describe, expect, it } from 'vitest'
import { workspaceStartupError } from '../../src/storage/startup-error'

function sqlite(errcode: number) { return Object.assign(new Error('SQLite startup failed.'), { code: 'ERR_SQLITE_ERROR', errcode }) }

describe('workspace startup diagnostics', () => {
  it.each([
    [sqlite(13), undefined],
    [sqlite(14), 0],
    [Object.assign(new Error('Disk full.'), { code: 'ENOSPC' }), undefined]
  ])('explains a confirmed full workspace volume', (error, availableBytes) => {
    expect(workspaceStartupError(error, availableBytes)).toBe('The workspace disk is full. Free disk space, then reload Db Commander to recover saved SQL buffers. No SQL was replayed.')
  })
  it.each([
    [sqlite(14), undefined], [sqlite(14), 1024], [sqlite(11), 0],
    [Object.assign(new Error('Permission denied.'), { code: 'EACCES' }), 0],
    [new Error('This workspace was created by a newer Db Commander version.'), 0]
  ])('preserves other startup errors', (error, availableBytes) => {
    expect(workspaceStartupError(error, availableBytes)).toBe(error.message)
  })
  it('handles an unknown failure', () => {
    expect(workspaceStartupError(null)).toBe('The workspace could not be opened.')
  })
})
