import { expect, it, vi } from 'vitest'
import { processIsAlive } from '../process-liveness'

it('keeps a denied process in the shutdown poll until the OS confirms its exit', () => {
  const denied = Object.assign(new Error('access denied'), { code: 'EPERM' })
  const exited = Object.assign(new Error('no process'), { code: 'ESRCH' })
  const probe = vi.fn().mockReturnValueOnce(true).mockImplementationOnce(() => { throw denied }).mockImplementationOnce(() => { throw exited })
  expect(processIsAlive(123, probe)).toBe(true)
  expect(processIsAlive(123, probe)).toBe(true)
  expect(processIsAlive(123, probe)).toBe(false)
  expect(probe.mock.calls).toEqual([[123, 0], [123, 0], [123, 0]])
})

it('does not hide unrelated errors while checking process exit', () => {
  const error = Object.assign(new Error('invalid signal'), { code: 'EINVAL' })
  expect(() => processIsAlive(123, () => { throw error })).toThrow(error)
})
