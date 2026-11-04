import { describe, expect, it, vi } from 'vitest'
import { readPerformance } from '../../src/activity/performance'

describe('performance counter boundary', () => {
  it('uses the logical Azure interval only for the actual edition and retains exact decimals', async () => {
    const query = vi.fn().mockResolvedValueOnce([['5']]).mockResolvedValueOnce([['0.123456789', null, 'bad', '99.00', '2026-11-04T12:00:00']])
    const snapshot = await readPerformance({ engine: 'sqlserver', database: 'test', currentSessionId: '42', query })
    expect(query.mock.calls[1][0]).toContain('sys.dm_db_resource_stats')
    expect(snapshot.metrics).toEqual([
      { label: 'Average CPU', value: '0.123456789', unit: '%', basis: 'interval' },
      { label: 'Average memory usage', value: '99.00', unit: '%', basis: 'interval' }
    ])
    expect(snapshot.reference).toBe('Interval ended (UTC): 2026-11-04T12:00:00')
  })
  it('never passes raw driver errors to an unavailable snapshot', async () => {
    const query = vi.fn().mockRejectedValue(new Error('private engine SQL or credential'))
    const snapshot = await readPerformance({ engine: 'oracle', database: 'test', currentSessionId: '42', query })
    expect(snapshot).toMatchObject({ status: 'unavailable', metrics: [] })
    expect(JSON.stringify(snapshot)).not.toContain('private')
  })
})
