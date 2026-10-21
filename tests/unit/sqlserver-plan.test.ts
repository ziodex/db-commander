import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionConfig } from '../../src/shared/contracts'
import type { Frame } from '../../src/driver/sqlserver-transport'

vi.mock('../../src/driver/sqlserver-transport', () => ({ openSqlServer: vi.fn(), streamSqlServer: vi.fn() }))
import { openSqlServer, streamSqlServer } from '../../src/driver/sqlserver-transport'
import { isolatedPlan } from '../../src/explain/execution'

afterEach(() => vi.resetAllMocks())
const config = { engine: 'sqlserver' } as ConnectionConfig
function setup(failAt?: string, controller?: AbortController) {
  const close = vi.fn(), cancel = vi.fn()
  vi.mocked(openSqlServer).mockResolvedValue({ close } as any)
  vi.mocked(streamSqlServer).mockImplementation((_client, sql, _values, options) => ({
    cancel,
    frames: (async function* (): AsyncGenerator<Frame> {
      if (sql === failAt) yield { kind: 'error', error: new Error('SHOWPLAN unavailable') }
      else if (options?.procedure) yield { kind: 'row', row: ['<ShowPlanXML />'] }
      if (sql === 'SET SHOWPLAN_XML ON') controller?.abort()
    })()
  }))
  return { close }
}
it('enables SHOWPLAN before invoking a private procedure with native values and closes it afterward', async () => {
  const { close } = setup(), submitted: string[] = []
  const secret = "O'Brien 😀; DROP TABLE customers; --"
  const output = await isolatedPlan(config, 'SELECT @sc_p1, @sc_p2', new AbortController().signal, submitted, [
    { name: 'text', type: 'text', value: secret }, { name: 'bytes', type: 'hex', value: '00ff' }
  ])
  const calls = vi.mocked(streamSqlServer).mock.calls
  expect(calls).toHaveLength(3)
  const procedure = calls[2][1]
  expect(procedure).toMatch(/^#sc_plan_[a-f0-9]{32}$/)
  expect(calls[0][1]).toBe(`CREATE PROCEDURE ${procedure}\n@sc_p1 nvarchar(max),\n@sc_p2 varbinary(max)\nAS\nSELECT @sc_p1, @sc_p2\n`)
  expect(calls[1][1]).toBe('SET SHOWPLAN_XML ON')
  expect(calls[2].slice(2)).toEqual([[secret, Buffer.from('00ff', 'hex')], { procedure: true }])
  expect(submitted.join('\n')).not.toContain(secret)
  expect(output.rows).toEqual([['<ShowPlanXML />']]); expect(close).toHaveBeenCalledOnce()
})
it('never invokes the query if SHOWPLAN fails and still closes the temporary session', async () => {
  const { close } = setup('SET SHOWPLAN_XML ON')
  await expect(isolatedPlan(config, 'SELECT @sc_p1', new AbortController().signal, [], [{ name: 'id', type: 'integer', value: '1' }])).rejects.toThrow('SHOWPLAN unavailable')
  expect(vi.mocked(streamSqlServer).mock.calls.some(call => call[3]?.procedure)).toBe(false)
  expect(close).toHaveBeenCalledOnce()
})
it('cancellation between setup and planning closes the session without invoking the query', async () => {
  const controller = new AbortController(), { close } = setup(undefined, controller)
  await expect(isolatedPlan(config, 'SELECT @sc_p1', controller.signal, [], [{ name: 'id', type: 'integer', value: '1' }])).rejects.toThrow()
  expect(vi.mocked(streamSqlServer).mock.calls.some(call => call[3]?.procedure)).toBe(false)
  expect(close).toHaveBeenCalledOnce()
})
it('zero-value array parameters use a normal SHOWPLAN batch without a temporary procedure', async () => {
  const { close } = setup()
  await isolatedPlan(config, 'SELECT 1 WHERE 1=0', new AbortController().signal, [], [])
  expect(vi.mocked(streamSqlServer).mock.calls.map(call => call[1])).toEqual(['SET SHOWPLAN_XML ON', 'SELECT 1 WHERE 1=0'])
  expect(close).toHaveBeenCalledOnce()
})
