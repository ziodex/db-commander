import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import semver from 'semver'
import { z } from 'zod'
import { UPDATE_API_URL, UPDATE_INTERVAL_MS, UPDATE_RELEASES_URL, type UpdateStatus } from '../shared/updates'
import { writeGeneratedFile } from './generated-file'

const preferencesSchema = z.object({ dismissedVersion: z.string().max(96).optional() }).strict()
const releaseSchema = z.object({ tag_name: z.string().max(96), draft: z.literal(false), prerelease: z.literal(false) })
const responseLimit = 1024 * 1024
const connectionError = 'Could not check for updates. Check your internet connection and try again.'
type FetchRelease = (url: string, options: RequestInit) => Promise<Response>

/** Application-wide metadata checks only. No package downloads or installation. */
export class UpdateChecker {
  private state: UpdateStatus
  private readonly file: string
  private loading: Promise<void> | undefined
  private preferencesWritable = true
  private dismissedVersion: string | undefined
  private saving: Promise<void> = Promise.resolve()
  private pending: Promise<UpdateStatus> | undefined
  private manualRequested = false
  private controller: AbortController | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private started = false
  private lastChecked = 0
  private stopped = false

  constructor(directory: string, version: string, private fetchRelease: FetchRelease,
    private changed: (status: UpdateStatus) => void, private now = Date.now) {
    this.file = join(directory, 'update-settings.json')
    this.state = { currentVersion: version, checking: false, dismissed: false }
  }
  get status(): UpdateStatus { return structuredClone(this.state) }
  private publish() { if (!this.stopped) this.changed(this.status) }
  start() {
    if (this.started || this.stopped) return
    this.started = true
    void this.check()
  }
  checkIfDue(): Promise<UpdateStatus> {
    return this.now() - this.lastChecked >= UPDATE_INTERVAL_MS ? this.check() : Promise.resolve(this.status)
  }
  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.controller?.abort()
  }
  private async loadPreferences() {
    try {
      const file = await open(this.file, constants.O_RDONLY | constants.O_NONBLOCK)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid update preferences.')
        const bytes = Buffer.alloc(4097)
        let length = 0
        while (length < bytes.length) {
          const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
          if (!bytesRead) break
          length += bytesRead
        }
        if (length > 4096) throw new Error('Invalid update preferences.')
        const preferences = preferencesSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))))
        this.dismissedVersion = preferences.dismissedVersion
      } finally { await file.close() }
    } catch (error) {
      // Corrupt or future settings must not be overwritten by a dismissal.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.preferencesWritable = false
    }
  }
  check(manual = false): Promise<UpdateStatus> {
    if (this.stopped) return Promise.resolve(this.status)
    if (manual) this.manualRequested = true
    this.state.checking = true
    this.state.message = this.manualRequested ? 'Checking for updates…' : undefined
    this.publish()
    this.pending ??= this.performCheck().finally(() => { this.pending = undefined })
    return this.pending
  }
  private async performCheck(): Promise<UpdateStatus> {
    this.controller = new AbortController()
    const controller = this.controller
    const timeout = setTimeout(() => controller.abort(), 10_000)
    timeout.unref()
    try {
      await (this.loading ??= this.loadPreferences())
      const response = await this.fetchRelease(UPDATE_API_URL, {
        signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': `DbCommander/${this.state.currentVersion}` }
      })
      if (response.status === 404) {
        await response.body?.cancel()
        this.state.available = undefined
        this.state.message = this.manualRequested ? 'No public release is available yet. You can check the releases page for news.' : undefined
      } else {
        if (!response.ok) {
          await response.body?.cancel()
          throw new Error(response.status === 403 || response.status === 429 ? 'GitHub update checks are temporarily limited. Try again later.' : connectionError)
        }
        const release = releaseSchema.parse(await this.readRelease(response))
        const version = semver.valid(release.tag_name)
        if (!version || semver.prerelease(version) || !semver.valid(this.state.currentVersion)) throw new Error(connectionError)
        if (semver.gt(version, this.state.currentVersion)) {
          const sameRelease = this.state.available?.version === version
          this.state.dismissed = this.manualRequested ? false : sameRelease ? this.state.dismissed : this.dismissedVersion === version
          // Construct a fixed-repository HTTPS page; never open a server-supplied URL.
          this.state.available = { version, url: `${UPDATE_RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}` }
          this.state.message = undefined
        } else {
          this.state.available = undefined
          this.state.message = this.manualRequested ? `You're up to date. Db Commander ${this.state.currentVersion} is installed.` : undefined
        }
      }
    } catch (error) {
      this.state.message = undefined
      if (this.manualRequested) this.state.message = error instanceof Error && error.message.startsWith('GitHub update checks') ? error.message : connectionError
    } finally {
      clearTimeout(timeout)
      this.controller = undefined
      this.lastChecked = this.now()
      if (this.started && !this.stopped) {
        clearTimeout(this.timer)
        this.timer = setTimeout(() => { void this.check() }, UPDATE_INTERVAL_MS)
        this.timer.unref()
      }
      this.state.checking = false
      this.manualRequested = false
      this.publish()
    }
    return this.status
  }
  private async readRelease(response: Response): Promise<unknown> {
    if (Number(response.headers.get('content-length')) > responseLimit) {
      await response.body?.cancel()
      throw new Error(connectionError)
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error(connectionError)
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        length += value.length
        if (length > responseLimit) throw new Error(connectionError)
        chunks.push(value)
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  async dismiss(version?: string) {
    if (version !== undefined && version !== this.state.available?.version) throw new Error('Update availability changed. Review the latest version before dismissing it.')
    this.manualRequested = false
    this.state.message = undefined
    if (version) { this.state.dismissed = true; this.dismissedVersion = version }
    this.publish()
    if (!version) return
    await (this.loading ??= this.loadPreferences())
    if (!this.preferencesWritable) return
    const preferences = JSON.stringify({ dismissedVersion: version })
    this.saving = this.saving.catch(() => {}).then(() => writeGeneratedFile(this.file, preferences, { replace: true }))
    // A full or read-only profile still permits dismissal for this session.
    await this.saving.catch(() => {})
  }
  releasePage() { return this.state.available?.url ?? UPDATE_RELEASES_URL }
}
