import { expect, it, vi } from 'vitest'
import { detachDiskImage, diskImageDevice, verifyDiskImageDetached } from '../desktop/disk-full-fixture'

it('selects only the attached device owning the private fixture mount', () => {
  const mount = '/private/fixture/volume'
  const entities = [{ 'dev-entry': '/dev/disk4' }, { 'dev-entry': '/dev/disk4s1', 'mount-point': mount }]
  expect(diskImageDevice({ 'system-entities': entities }, mount)).toBe('/dev/disk4')
  for (const report of [{}, { 'system-entities': [entities[0]] }, { 'system-entities': [entities[0], { 'dev-entry': '/dev/disk40s1', 'mount-point': mount }] }, { 'system-entities': [{ 'dev-entry': '/dev/disk4', 'mount-point': '/another/mount' }] }]) {
    expect(() => diskImageDevice(report, mount)).toThrow('Cannot identify the owned disk-image device')
  }
})

it('retries a busy owned volume without forcing eject and succeeds when its handle is released', () => {
  const busy = Object.assign(new Error('hdiutil refusal'), { stderr: Buffer.from("hdiutil: couldn't eject disk2 - Resource busy\n") })
  const execute = vi.fn().mockImplementationOnce(() => { throw busy }).mockImplementationOnce(() => { throw busy }).mockReturnValue(Buffer.from('detached'))
  const pause = vi.fn()
  detachDiskImage('/private/fixture/volume', execute, pause)
  expect(execute).toHaveBeenCalledTimes(3)
  for (const args of execute.mock.calls) expect(args).toEqual(['hdiutil', ['detach', '/private/fixture/volume'], { stdio: 'pipe', timeout: 5000 }])
  expect(pause.mock.calls).toEqual([[500], [500]])
})

it('retains the original busy error after bounded retries so a mounted fixture is not removed', () => {
  const busy = Object.assign(new Error('still busy'), { stderr: 'Resource busy' })
  const execute = vi.fn(() => { throw busy }), pause = vi.fn()
  expect(() => detachDiskImage('/private/fixture/volume', execute, pause)).toThrow(busy)
  expect(execute).toHaveBeenCalledTimes(6); expect(pause).toHaveBeenCalledTimes(5)
})

it('does not retry unrelated detach failures or command timeouts', () => {
  for (const error of [Object.assign(new Error('permission denied'), { stderr: 'Operation not permitted' }), Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })]) {
    const execute = vi.fn(() => { throw error }), pause = vi.fn()
    expect(() => detachDiskImage('/private/fixture/volume', execute, pause)).toThrow(error)
    expect(execute).toHaveBeenCalledOnce(); expect(pause).not.toHaveBeenCalled()
  }
})

it('accepts an absent mount only when the owned image and mount are independently verified detached', () => {
  const absent = Object.assign(new Error('missing mount'), { stderr: 'hdiutil: detach failed - No such file or directory' })
  const execute = vi.fn(() => { throw absent }), pause = vi.fn(), verify = vi.fn(() => true)
  expect(() => detachDiskImage('/private/fixture/volume', execute, pause, verify)).not.toThrow()
  expect(verify).toHaveBeenCalledOnce(); expect(pause).not.toHaveBeenCalled()
  for (const verifier of [undefined, () => false, () => { throw new Error('inspection failed') }]) {
    expect(() => detachDiskImage('/private/fixture/volume', execute, pause, verifier)).toThrow()
  }
})

it('checks image identity as well as mount identity and refuses an incomplete disk-image report', () => {
  const image = '/private/fixture/volume.dmg', mount = '/private/fixture/volume'
  for (const [images, detached] of [
    [[], true],
    [[{ 'image-path': image, 'system-entities': [] }], false],
    [[{ 'image-path': '/other/image.dmg', 'system-entities': [{ 'mount-point': mount }] }], false],
    [[{ 'image-path': '/other/image.dmg', 'system-entities': [{ 'mount-point': '/other/mount' }] }], true]
  ] as const) {
    const execute = vi.fn().mockReturnValueOnce(Buffer.from('native plist')).mockReturnValueOnce(Buffer.from(JSON.stringify({ images })))
    expect(verifyDiskImageDetached(image, mount, execute)).toBe(detached)
    expect(execute.mock.calls[0]).toEqual(['hdiutil', ['info', '-plist'], { stdio: 'pipe', timeout: 5000, maxBuffer: 1024 * 1024 }])
    expect(execute.mock.calls[1][2].input).toEqual(Buffer.from('native plist'))
  }
  for (const report of [{}, { images: [{}] }, { images: [{ 'image-path': image }] }]) {
    const execute = vi.fn().mockReturnValueOnce(Buffer.from('plist')).mockReturnValueOnce(Buffer.from(JSON.stringify(report)))
    expect(() => verifyDiskImageDetached(image, mount, execute)).toThrow('Cannot verify owned disk-image detachment')
  }
})
