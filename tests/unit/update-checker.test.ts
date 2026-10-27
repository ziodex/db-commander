import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { UpdateChecker } from '../../src/main/update-checker'
import { isUpdateStatus, UPDATE_API_URL, UPDATE_INTERVAL_MS, UPDATE_RELEASES_URL, type UpdateStatus } from '../../src/shared/updates'

const directories: string[] = [], checkers: UpdateChecker[] = []
afterEach(() => {
  checkers.splice(0).forEach(checker => checker.stop())
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }))
  vi.useRealTimers()
})
function response(tag = 'v0.2.0', extra = {}) { return Response.json({ tag_name: tag, draft: false, prerelease: false, ...extra }) }
function fixture(version = '0.1.0', directory?: string) {
  const root = directory ?? mkdtempSync(join(tmpdir(), 'dbcommander-updates-'))
  if (!directory) directories.push(root)
  const fetch = vi.fn<(url: string, options: RequestInit) => Promise<Response>>().mockImplementation(async () => response())
  const statuses: UpdateStatus[] = []
  const checker = new UpdateChecker(root, version, fetch, status => statuses.push(status))
  checkers.push(checker)
  return { checker, fetch, root, statuses }
}

it('checks at startup, once daily and when a resumed application is overdue, using one shared request', async () => {
  vi.useFakeTimers()
  const { checker, fetch } = fixture()
  checker.start(); checker.start()
  await vi.waitFor(() => expect(checker.status.available?.version).toBe('0.2.0'))
  expect(fetch).toHaveBeenCalledTimes(1)
  await checker.checkIfDue(); expect(fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS)
  expect(fetch).toHaveBeenCalledTimes(2)
  vi.setSystemTime(Date.now() + UPDATE_INTERVAL_MS)
  await checker.checkIfDue(); expect(fetch).toHaveBeenCalledTimes(3)
  checker.stop()
  await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS * 2)
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('sends only a fixed public metadata request without credentials or automatic redirects', async () => {
  const { checker, fetch } = fixture()
  const state = await checker.check()
  expect(fetch).toHaveBeenCalledExactlyOnceWith(UPDATE_API_URL, expect.objectContaining({
    redirect: 'error', credentials: 'omit', cache: 'no-store', signal: expect.any(AbortSignal),
    headers: expect.objectContaining({ Accept: 'application/vnd.github+json', 'User-Agent': 'DbCommander/0.1.0' })
  }))
  expect(state).toMatchObject({ checking: false, available: { version: '0.2.0', url: `${UPDATE_RELEASES_URL}/tag/v0.2.0` }, dismissed: false })
})

it('schedules the next daily check 24 hours after a manual check, without skipping a day or repeating it early', async () => {
  vi.useFakeTimers()
  const { checker, fetch } = fixture()
  checker.start()
  await vi.waitFor(() => expect(checker.status.checking).toBe(false))
  await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS / 2)
  await checker.check(true); expect(fetch).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS / 2)
  expect(fetch).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS / 2)
  expect(fetch).toHaveBeenCalledTimes(3)
})

it('compares semantic versions numerically and accepts stable releases over installed prereleases', async () => {
  const first = fixture('0.9.0'); first.fetch.mockImplementation(async () => response('v0.10.0'))
  expect((await first.checker.check()).available?.version).toBe('0.10.0')
  const second = fixture('1.0.0-beta.1'); second.fetch.mockImplementation(async () => response('1.0.0'))
  expect((await second.checker.check()).available?.version).toBe('1.0.0')
})

it.each(['v0.1.0', 'v0.0.9'])('keeps background checks quiet for installed or older versions (%s)', async tag => {
  const { checker, fetch } = fixture(); fetch.mockImplementation(async () => response(tag))
  expect(await checker.check()).toMatchObject({ checking: false, available: undefined, message: undefined })
  expect((await checker.check(true)).message).toContain("You're up to date")
})

it('persists dismissal across windows, daily checks and restart, while manual checks and newer versions show again', async () => {
  const first = fixture()
  await first.checker.check(); await first.checker.dismiss('0.2.0')
  expect(first.checker.status.dismissed).toBe(true)
  expect((await first.checker.check()).dismissed).toBe(true)
  first.checker.stop()
  const next = fixture('0.1.0', first.root)
  expect((await next.checker.check()).dismissed).toBe(true)
  expect((await next.checker.check(true)).dismissed).toBe(false)
  await next.checker.dismiss('0.2.0')
  next.fetch.mockImplementation(async () => response('v0.3.0'))
  expect(await next.checker.check()).toMatchObject({ available: { version: '0.3.0' }, dismissed: false })
  await expect(next.checker.dismiss('0.2.0')).rejects.toThrow('availability changed')
  expect(next.checker.status.dismissed).toBe(false)
})

it('does not overwrite damaged or future preferences and still allows session-only dismissal', async () => {
  const { checker, root } = fixture(), file = join(root, 'update-settings.json')
  writeFileSync(file, '{"futureField":true}')
  await checker.check(); await checker.dismiss('0.2.0')
  expect(readFileSync(file, 'utf8')).toBe('{"futureField":true}')
  expect(checker.status.dismissed).toBe(true)
})

it('does not replace symbolic-link preferences when remembering a dismissal', async () => {
  const { checker, root } = fixture(), file = join(root, 'update-settings.json')
  await checker.check()
  writeFileSync(file, '{"dismissedVersion":"0.0.1"}')
  const { symlinkSync, unlinkSync } = await import('node:fs')
  const other = join(root, 'keep.json'); writeFileSync(other, 'keep')
  unlinkSync(file); symlinkSync(other, file)
  await checker.dismiss('0.2.0')
  expect(readFileSync(other, 'utf8')).toBe('keep')
  expect(checker.status.dismissed).toBe(true)
})

it('coalesces a manual check with an in-flight startup check and returns the manual result', async () => {
  const { checker, fetch } = fixture()
  let complete!: (response: Response) => void
  fetch.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  const background = checker.check()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  const manual = checker.check(true)
  expect(manual).toBe(background)
  complete(response('v0.1.0'))
  expect((await manual).message).toContain("You're up to date")
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('does not reopen a dismissed progress notice when its in-flight manual check finishes', async () => {
  const { checker, fetch } = fixture()
  let complete!: (response: Response) => void
  fetch.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  const pending = checker.check(true)
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  await checker.dismiss()
  complete(response('v0.1.0'))
  expect((await pending).message).toBeUndefined()
})

it('validates preload messages without external dependencies or arbitrary release links', async () => {
  const { checker } = fixture()
  const status = await checker.check()
  expect(isUpdateStatus(status)).toBe(true)
  for (const value of [null, [], { ...status, checking: 'yes' }, { ...status, currentVersion: 'x'.repeat(97) }, { ...status, message: 'x'.repeat(513) }, { ...status, arbitrary: true }, { ...status, available: { version: '0.2.0', url: 'https://malicious.example/' } }]) expect(isUpdateStatus(value)).toBe(false)
})

it('treats a repository without releases separately from connectivity failures', async () => {
  const { checker, fetch } = fixture()
  fetch.mockImplementation(async () => new Response('', { status: 404 }))
  expect((await checker.check()).message).toBeUndefined()
  expect((await checker.check(true)).message).toContain('No public release')
  expect(checker.releasePage()).toBe(UPDATE_RELEASES_URL)
})

it('keeps offline background checks quiet and preserves a previously available release', async () => {
  const { checker, fetch } = fixture()
  await checker.check()
  fetch.mockRejectedValue(new Error('Server or proxy details must not be displayed'))
  expect(await checker.check()).toMatchObject({ available: { version: '0.2.0' }, message: undefined })
  const state = await checker.check(true)
  expect(state.message).toContain('Could not check')
  expect(state.message).not.toContain('proxy')
  await checker.dismiss('0.2.0'); expect(checker.status.message).toBeUndefined()
})

it.each([403, 429, 500])('handles unsuccessful metadata responses (%s)', async status => {
  const { checker, fetch } = fixture(); fetch.mockImplementation(async () => new Response('', { status }))
  expect((await checker.check()).message).toBeUndefined()
  expect((await checker.check(true)).message).toContain(status === 500 ? 'Could not check' : 'temporarily limited')
})

it.each([
  ['v9.0.0-beta.1', {}], ['nonsense', {}], ['v9.0.0', { draft: true }], ['v9.0.0', { prerelease: true }]
])('rejects unpublished, prerelease or invalid release metadata (%s)', async (tag, extra) => {
  const { checker, fetch } = fixture(); fetch.mockImplementation(async () => response(tag, extra))
  const state = await checker.check(true)
  expect(state.available).toBeUndefined(); expect(state.message).toContain('Could not check')
})

it('never opens a response-supplied external URL', async () => {
  const { checker, fetch } = fixture()
  fetch.mockImplementation(async () => response('v0.2.0', { html_url: 'file:///private/data', assets: [{ browser_download_url: 'https://malicious.example/setup.exe' }] }))
  await checker.check()
  expect(checker.releasePage()).toBe(`${UPDATE_RELEASES_URL}/tag/v0.2.0`)
})

it('bounds streamed metadata even without content-length', async () => {
  const { checker, fetch } = fixture()
  fetch.mockImplementation(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); controller.close() } })))
  expect((await checker.check(true)).message).toContain('Could not check')
  expect(checker.status.available).toBeUndefined()
})

it('aborts stalled requests after ten seconds and cancels on application shutdown', async () => {
  vi.useFakeTimers()
  const { checker, fetch, statuses } = fixture()
  fetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => { signal!.addEventListener('abort', () => reject(new Error('Aborted'))) }))
  const pending = checker.check(true)
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  await vi.advanceTimersByTimeAsync(10_000)
  expect((await pending).message).toContain('Could not check')
  const second = checker.check()
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  const count = statuses.length
  checker.stop(); await second
  expect(statuses).toHaveLength(count)
})
