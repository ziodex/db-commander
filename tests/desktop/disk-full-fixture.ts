import { closeSync, existsSync, fstatSync, ftruncateSync, mkdtempSync, openSync, realpathSync, rmSync, statfsSync, writeFileSync, writeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function diskImageDevice(report: { 'system-entities'?: { 'dev-entry'?: string; 'mount-point'?: string }[] }, mount: string) {
  const entities = report['system-entities']
  const device = entities?.find(entity => /^\/dev\/disk\d+$/.test(entity['dev-entry'] ?? ''))?.['dev-entry']
  if (!device || !entities?.some(entity => entity['mount-point'] === mount && new RegExp(`^${device}(?:s\\d+)*$`).test(entity['dev-entry'] ?? ''))) throw new Error('Cannot identify the owned disk-image device.')
  return device
}

export function verifyDiskImageDetached(image: string, mount: string, execute = execFileSync, deadline = Date.now() + 10000, now = Date.now) {
  const timeout = () => {
    const remaining = deadline - now()
    if (remaining <= 0) throw new Error('Cannot verify owned disk-image detachment within its deadline.')
    return Math.min(5000, remaining)
  }
  const plist = execute('hdiutil', ['info', '-plist'], { stdio: 'pipe', timeout: timeout(), maxBuffer: 1024 * 1024 })
  const report = JSON.parse(String(execute('plutil', ['-convert', 'json', '-o', '-', '-'], { input: plist, stdio: 'pipe', timeout: timeout(), maxBuffer: 1024 * 1024 })))
  if (!Array.isArray(report.images) || report.images.some((entry: any) => typeof entry['image-path'] !== 'string' || !Array.isArray(entry['system-entities']))) throw new Error('Cannot verify owned disk-image detachment.')
  return !report.images.some((entry: any) => entry['image-path'] === image || entry['system-entities'].some((entity: any) => entity['mount-point'] === mount))
}

export function detachDiskImage(mount: string, execute = execFileSync, pause = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }, verifyDetached?: (deadline: number) => boolean, now = Date.now) {
  const deadline = now() + 30000
  for (;;) {
    try { execute('hdiutil', ['detach', mount], { stdio: 'pipe', timeout: 5000 }); return }
    catch (error) {
      // An earlier native detach can already have removed the mount. Accept
      // that result only after hdiutil confirms both this image and mount are
      // absent. Never delete a fixture whose image may still be attached.
      if (/No such file or directory/i.test(String((error as { stderr?: unknown }).stderr)) && verifyDetached?.(deadline)) return
      // The native ejection can settle after its command client times out.
      // Observe only: never repeat that ambiguous detach or remove an image
      // until both its path and mount are independently absent. Verification
      // shares the existing teardown deadline; unknown state remains failure.
      if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT' && verifyDetached) {
        while (now() < deadline) {
          if (verifyDetached(deadline)) return
          const remaining = deadline - now()
          if (remaining > 0) pause(Math.min(500, remaining))
        }
        throw error
      }
      // Native filesystem handles can outlast app exit on hosted macOS. Allow
      // bounded teardown time for this owned volume, without forced eject or
      // relaxing any application recovery/performance assertion.
      if (now() >= deadline || !/Resource busy/i.test(String((error as { stderr?: unknown }).stderr))) throw error
      pause(500)
    }
  }
}

export function createDiskImage(image: string, execute = execFileSync, pause = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }, now = Date.now, exists = existsSync) {
  const deadline = now() + 30000
  for (;;) {
    try {
      execute('hdiutil', ['create', '-size', '32m', '-fs', 'HFS+', '-volname', 'DbCommanderDiskFault', '-type', 'UDIF', '-nospotlight', image], { stdio: 'pipe', timeout: 15000 })
      return
    } catch (error) {
      // Hosted macOS can briefly refuse a new image while the native service
      // settles. Retry only that refusal and only if no output was created;
      // never overwrite a partial image or retry permission/timeout failures.
      if (now() >= deadline || !/Resource busy/i.test(String((error as { stderr?: unknown }).stderr)) || exists(image)) throw error
      pause(500)
    }
  }
}

/** A bounded destination for real ENOSPC; image and reports live on the host. */
export function diskFullFixture() {
  if (process.platform !== 'darwin') throw new Error('The private disk-image fixture requires macOS.')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dbcommander-disk-full-'))), mount = join(root, 'volume'), image = join(root, 'volume.dmg'), filler = join(mount, 'filler')
  let mounted = false, device: string | undefined
  const dispose = () => {
    // A full HFS+ volume can lose its mount path while its image stays attached.
    // Detach the device returned by our own attach, retaining identity checks.
    if (mounted) {
      try { detachDiskImage(device ?? mount, execFileSync, undefined, deadline => verifyDiskImageDetached(image, mount, execFileSync, deadline)); mounted = false }
      catch (error) {
        // Retain the image on failure and identify only this fixture's handles.
        let handles: string
        try { handles = execFileSync('lsof', ['+D', mount], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 }) }
        catch (inspection) { const detail = inspection as { stdout?: Buffer | string; stderr?: Buffer | string }; handles = [detail.stdout, detail.stderr].join('\n') }
        console.error(`Cannot detach owned test image ${image}; open handles:\n${handles || '(none reported)'}`)
        throw error
      }
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
  try {
    createDiskImage(image)
    const attached = execFileSync('hdiutil', ['attach', '-plist', '-nobrowse', '-mountpoint', mount, image], { stdio: 'pipe' }); mounted = true
    device = diskImageDevice(JSON.parse(String(execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], { input: attached, stdio: 'pipe' }))), mount)
    writeFileSync(join(mount, '.metadata_never_index'), '')
    return { root, mount, dispose, release: () => rmSync(filler), fill(reservedBytes = 0) {
      if (!Number.isInteger(reservedBytes) || reservedBytes < 0 || reservedBytes > 1024 * 1024) throw new Error('Reserve at most 1 MiB in the private volume.')
      const descriptor = openSync(filler, 'wx', 0o600), block = Buffer.alloc(1024 * 1024)
      let reachedENOSPC = false, fillerBytes = 0
      try {
        for (let index = 0; index < 40; index++) writeSync(descriptor, block)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOSPC') throw error; reachedENOSPC = true }
      finally {
        try {
          // Consume sub-MiB tail space too; a failed large write can leave room
          // for many small SQLite WAL frames on HFS+.
          if (reachedENOSPC) {
            const page = Buffer.alloc(4096)
            try { for (let index = 0; index < 256; index++) writeSync(descriptor, page) }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOSPC') throw error }
          }
          fillerBytes = Math.max(0, fstatSync(descriptor).size - reservedBytes)
          if (reservedBytes) ftruncateSync(descriptor, fillerBytes)
        }
        finally { closeSync(descriptor) }
      }
      if (!reachedENOSPC) throw new Error('The private volume did not reach ENOSPC within its 40 MiB write budget.')
      const stat = statfsSync(mount)
      return { reachedENOSPC, volumeMiB: 32, reservedBytes, fillerBytes, availableBytes: stat.bavail * stat.bsize }
    } }
  } catch (error) { dispose(); throw error }
}
