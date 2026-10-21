import { expect, it, vi } from 'vitest'
import { detachDiskImage, ownedDiskImageDevice, verifyDiskImageDetached } from '../desktop/disk-full-fixture'

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

it('detaches the exact owned image device even after its filesystem is already unmounted', () => {
  const image = '/private/fixture/volume.dmg'
  const execute = vi.fn().mockReturnValueOnce(Buffer.from('plist')).mockReturnValueOnce(Buffer.from(JSON.stringify({ images: [
    { 'image-path': '/other/image.dmg', 'system-entities': [{ 'dev-entry': '/dev/disk8' }] },
    { 'image-path': image, 'system-entities': [{ 'dev-entry': '/dev/disk9' }, { 'dev-entry': '/dev/disk9s1' }] }
  ] }))).mockReturnValue(Buffer.from('detached'))
  const device = ownedDiskImageDevice(image, execute)
  expect(device).toBe('/dev/disk9')
  detachDiskImage(device!, execute, vi.fn())
  expect(execute.mock.lastCall).toEqual(['hdiutil', ['detach', '/dev/disk9'], { stdio: 'pipe', timeout: 5000 }])
})

it('refuses ambiguous or unidentifiable image devices and never selects an unrelated image', () => {
  const image = '/private/fixture/volume.dmg', entities = [{ 'dev-entry': '/dev/disk9' }]
  const inspect = (images: unknown[]) => ownedDiskImageDevice(image, vi.fn().mockReturnValueOnce(Buffer.from('plist')).mockReturnValueOnce(Buffer.from(JSON.stringify({ images }))))
  expect(inspect([{ 'image-path': '/other/image.dmg', 'system-entities': entities }])).toBeUndefined()
  for (const images of [
    [{ 'image-path': image, 'system-entities': [{ 'dev-entry': '/dev/disk9s1' }] }],
    [{ 'image-path': image, 'system-entities': [...entities, { 'dev-entry': '/dev/disk10' }] }],
    [{ 'image-path': image, 'system-entities': entities }, { 'image-path': image, 'system-entities': entities }]
  ]) expect(() => inspect(images)).toThrow(/owned disk-image/)
})
