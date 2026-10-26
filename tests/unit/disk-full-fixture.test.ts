import { expect, it, vi } from 'vitest'
import { createDiskImage, detachDiskImage, diskImageDevice, verifyDiskImageDetached } from '../desktop/disk-full-fixture'

it('selects only the attached device owning the private fixture mount', () => {
  const mount = '/private/fixture/volume'
  const entities = [{ 'dev-entry': '/dev/disk4' }, { 'dev-entry': '/dev/disk4s1', 'mount-point': mount }]
  expect(diskImageDevice({ 'system-entities': entities }, mount)).toBe('/dev/disk4')
  for (const report of [{}, { 'system-entities': [entities[0]] }, { 'system-entities': [entities[0], { 'dev-entry': '/dev/disk40s1', 'mount-point': mount }] }, { 'system-entities': [{ 'dev-entry': '/dev/disk4', 'mount-point': '/another/mount' }] }]) {
    expect(() => diskImageDevice(report, mount)).toThrow('Cannot identify the owned disk-image device')
  }
})

it('retries transient disk-image creation refusals only while its private output is absent', () => {
  const busy = Object.assign(new Error('hdiutil refusal'), { stderr: Buffer.from('hdiutil: create failed - Resource busy') })
  let attempts = 0, time = 0
  const execute = vi.fn().mockImplementation(() => { if (++attempts <= 2) throw busy; return Buffer.from('created') })
  const pause = vi.fn((ms: number) => { time += ms })
  createDiskImage('/private/fixture/volume.dmg', execute, pause, () => time, () => false)
  expect(execute).toHaveBeenCalledTimes(3); expect(time).toBe(1000)
  for (const args of execute.mock.calls) expect(args).toEqual(['hdiutil', ['create', '-size', '32m', '-fs', 'HFS+', '-volname', 'DbCommanderDiskFault', '-type', 'UDIF', '-nospotlight', '/private/fixture/volume.dmg'], { stdio: 'pipe', timeout: 15000 }])
})

it('keeps disk-image creation retries bounded and preserves the original error', () => {
  const busy = Object.assign(new Error('still busy'), { stderr: 'Resource busy' })
  let time = 0
  const execute = vi.fn(() => { throw busy }), pause = vi.fn((ms: number) => { time += ms })
  expect(() => createDiskImage('/private/fixture/volume.dmg', execute, pause, () => time, () => false)).toThrow(busy)
  expect(time).toBe(30000); expect(execute).toHaveBeenCalledTimes(61)
})

it('never retries disk-image creation over partial output or unrelated failures', () => {
  for (const [error, exists] of [
    [Object.assign(new Error('partial image'), { stderr: 'Resource busy' }), true],
    [Object.assign(new Error('denied'), { stderr: 'Operation not permitted' }), false],
    [Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), false]
  ] as const) {
    const execute = vi.fn(() => { throw error }), pause = vi.fn()
    expect(() => createDiskImage('/private/fixture/volume.dmg', execute, pause, Date.now, () => exists)).toThrow(error)
    expect(execute).toHaveBeenCalledOnce(); expect(pause).not.toHaveBeenCalled()
  }
})

it('retries a busy owned volume without forcing eject and succeeds when its handle is released', () => {
  const busy = Object.assign(new Error('hdiutil refusal'), { stderr: Buffer.from("hdiutil: couldn't eject disk2 - Resource busy\n") })
  let attempts = 0, time = 0
  const execute = vi.fn().mockImplementation(() => { if (++attempts <= 8) throw busy; return Buffer.from('detached') })
  const pause = vi.fn((ms: number) => { time += ms })
  detachDiskImage('/private/fixture/volume', execute, pause, undefined, () => time)
  expect(execute).toHaveBeenCalledTimes(9)
  for (const args of execute.mock.calls) expect(args).toEqual(['hdiutil', ['detach', '/private/fixture/volume'], { stdio: 'pipe', timeout: 5000 }])
  expect(time).toBe(4000); expect(pause.mock.calls.every(([ms]) => ms === 500)).toBe(true)
})

it('retains the original busy error after bounded retries so a mounted fixture is not removed', () => {
  const busy = Object.assign(new Error('still busy'), { stderr: 'Resource busy' })
  let time = 0
  const execute = vi.fn(() => { throw busy }), pause = vi.fn((ms: number) => { time += ms })
  expect(() => detachDiskImage('/private/fixture/volume', execute, pause, undefined, () => time)).toThrow(busy)
  expect(time).toBe(30000); expect(execute).toHaveBeenCalledTimes(61); expect(pause).toHaveBeenCalledTimes(60)
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
