import { expect, it, vi } from 'vitest'
import { dropOracleMonitorUser } from '../activity-fixture'

it('retries only Oracle connections that are still being released after fixture shutdown', () => {
  let time=0
  const busy=Object.assign(new Error('SQLPlus failed'),{stdout:Buffer.from('ORA-01940: cannot drop a user that is currently connected')})
  const drop=vi.fn().mockImplementationOnce(()=>{throw busy}).mockImplementationOnce(()=>{throw busy}).mockImplementation(()=>{})
  const pause=vi.fn((ms:number)=>{time+=ms})
  dropOracleMonitorUser(drop,pause,()=>time)
  expect(drop).toHaveBeenCalledTimes(3)
  expect(pause.mock.calls).toEqual([[100],[100]])
})

it('keeps Oracle cleanup failures actionable and bounded', () => {
  let time=0
  const busy=new Error('Oracle monitoring fixture SQL failed: ORA-01940: cannot drop a user that is currently connected')
  const drop=vi.fn(()=>{throw busy})
  expect(()=>dropOracleMonitorUser(drop,ms=>{time+=ms},()=>time)).toThrow(busy)
  expect(time).toBe(10000)
  expect(drop).toHaveBeenCalledTimes(101)
  const denied=Object.assign(new Error('SQLPlus failed'),{stdout:'ORA-01031: insufficient privileges'})
  const pause=vi.fn()
  expect(()=>dropOracleMonitorUser(()=>{throw denied},pause)).toThrow(denied)
  expect(pause).not.toHaveBeenCalled()
})
