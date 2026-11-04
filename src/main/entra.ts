import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PublicClientApplication, type AccountInfo, type AuthenticationResult, type Configuration } from '@azure/msal-node'
import type { EntraAttempt, EntraProfile, EntraProgress } from '../shared/entra'

const issuer = 'https://login.microsoftonline.com'
const scopes = ['https://database.windows.net/user_impersonation', 'offline_access', 'openid', 'profile']
const signedOut = 'Microsoft Entra sign-in is required. Sign in again to open a new database connection.'
type Browser = (url: string) => Promise<void>
type Identity = Pick<PublicClientApplication, 'getAuthCodeUrl' | 'acquireTokenByCode' | 'acquireTokenSilent'>
type IdentityFactory = (authority: string, clientId: string) => Identity
type Credential = { identity: Identity; account: AccountInfo; token: string; expires: number }
type Grant = { credentials: Credential; users: number; pending?: Promise<string> }

const network: NonNullable<NonNullable<Configuration['system']>['networkClient']> = {
  sendGetRequestAsync: (url, options) => request(url, { headers: options?.headers }),
  sendPostRequestAsync: (url, options) => request(url, { method: 'POST', headers: options?.headers, body: options?.body })
}

async function request<T>(url: string, init: RequestInit) {
  if (new URL(url).origin !== issuer) throw new Error('Untrusted Microsoft Entra endpoint.')
  const response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(12_000) })
  const headers: Record<string, string> = {}
  for (const [key, value] of response.headers) headers[key] = value
  return { status: response.status, headers, body: await response.json() as T }
}

const makeIdentity: IdentityFactory = (authority, clientId) => new PublicClientApplication({
  auth: { clientId, authority, knownAuthorities: ['login.microsoftonline.com'] },
  system: { networkClient: network }
})

function checkToken(result: AuthenticationResult, tenant: string): Credential['token'] {
  if (!result.account || result.account.tenantId.toLowerCase() !== tenant.toLowerCase() ||
    !result.accessToken || result.accessToken.length > 65_536 || !result.expiresOn || result.expiresOn.getTime() <= Date.now() + 10_000) {
    throw new Error('Microsoft Entra did not return a current token for the configured tenant.')
  }
  return result.accessToken
}

async function authorize(identity: Identity, authority: string, openBrowser: Browser, signal: AbortSignal, progress: (phase: 'browser' | 'finishing') => void, hint?: string) {
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url')
  let resolveCode!: (code: string) => void, rejectCode!: (error: Error) => void
  let redirect = '', received = false
  const callback = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject })
  void callback.catch(() => {}) // Cancellation can arrive while building the browser URL.
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000, maxHeaderSize: 8192 }, (req, res) => {
    const reply = (code: number, body: string) => {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'", Connection: 'close' })
      res.end(body)
    }
    let url: URL
    try { url = new URL(req.url ?? '', redirect) } catch { reply(400, 'Invalid sign-in response.'); return }
    const actual = url.searchParams.get('state') ?? ''
    if (!redirect || req.method !== 'GET' || req.headers.host !== new URL(redirect).host || url.origin !== redirect || url.pathname !== '/' ||
      url.searchParams.getAll('state').length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(actual) || !timingSafeEqual(Buffer.from(actual), Buffer.from(state))) {
      reply(400, 'Invalid sign-in response.'); return
    }
    if (received || signal.aborted) { reply(410, 'This sign-in has already ended. Return to Db Commander.'); return }
    received = true
    const codes = url.searchParams.getAll('code')
    if (url.searchParams.has('error') || codes.length !== 1 || !codes[0] || codes[0].length > 8192) {
      reply(400, 'Sign-in did not finish. Return to Db Commander.')
      rejectCode(new Error('Microsoft Entra sign-in was declined or did not finish.'))
      return
    }
    reply(200, 'Return to Db Commander to finish connecting. You can close this browser tab.')
    resolveCode(codes[0])
  })
  server.maxConnections = 8
  const abort = () => rejectCode(new Error('Microsoft Entra sign-in was cancelled or expired.'))
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    redirect = `http://localhost:${(server.address() as AddressInfo).port}`
    const address = await identity.getAuthCodeUrl({
      authority, scopes, redirectUri: redirect, state, responseMode: 'query', prompt: 'select_account',
      ...(hint ? { loginHint: hint } : {}),
      codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256'
    })
    const url = new URL(address)
    if (url.origin !== issuer || url.pathname !== `${new URL(authority).pathname}/oauth2/v2.0/authorize` || url.username || url.password) {
      throw new Error('Microsoft Entra returned an invalid authorization address.')
    }
    signal.throwIfAborted()
    await openBrowser(address)
    signal.throwIfAborted()
    progress('browser')
    const code = await callback
    signal.throwIfAborted()
    progress('finishing')
    const result = await identity.acquireTokenByCode({ authority, scopes, redirectUri: redirect, code, codeVerifier: verifier })
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener('abort', abort)
    server.close()
    server.closeAllConnections()
  }
}

export class EntraGrants {
  private grants = new Map<string, Grant>()
  private interactive?: { id: string; controller: AbortController }
  constructor(private openBrowser: Browser, private identity: IdentityFactory = makeIdentity, private notify: (progress: EntraProgress) => void = () => {}) {}

  private async signIn(profile: EntraProfile, request: EntraAttempt, hint?: string): Promise<Credential> {
    if (this.interactive) throw new Error('Finish or cancel the current Microsoft Entra sign-in first.')
    const controller = new AbortController()
    const attempt = { id: request.id, controller }
    const progress = (phase: EntraProgress['phase']) => this.notify({ ...request, phase })
    this.interactive = attempt
    progress('opening')
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)])
    const authority = `${issuer}/${profile.tenantId.toLowerCase()}`
    try {
      const identity = this.identity(authority, profile.clientId)
      const result = await authorize(identity, authority, this.openBrowser, signal, progress, hint)
      const token = checkToken(result, profile.tenantId)
      return { identity, account: result.account!, token, expires: result.expiresOn!.getTime() }
    } catch {
      throw new Error(controller.signal.aborted ? 'Microsoft Entra sign-in was cancelled.' :
        signal.aborted ? 'Microsoft Entra sign-in expired. Try again.' :
        'Microsoft Entra sign-in failed. Verify the tenant, application registration and account access, then try again.')
    } finally {
      if (this.interactive === attempt) { this.interactive = undefined; progress('finished') }
    }
  }

  async open(profile: EntraProfile, hint?: string, request: EntraAttempt = { id: randomUUID(), surface: 'workspace' }) {
    const credentials = await this.signIn(profile, request, hint)
    const id = randomUUID()
    this.grants.set(id, { credentials, users: 1 })
    return id
  }

  retain(id: string) {
    const grant = this.grants.get(id)
    if (!grant) throw new Error(signedOut)
    grant.users++
  }

  release(id: string | undefined) {
    if (!id) return
    const grant = this.grants.get(id)
    if (grant && --grant.users === 0) this.grants.delete(id)
  }

  async renew(id: string, profile: EntraProfile, request: EntraAttempt = { id: randomUUID(), surface: 'workspace' }) {
    const grant = this.grants.get(id)
    if (!grant) throw new Error(signedOut)
    const before = grant.credentials
    const replacement = await this.signIn(profile, request, before.account.username)
    if (this.grants.get(id) !== grant) throw new Error('The database connection closed during sign-in.')
    if (replacement.account.homeAccountId !== before.account.homeAccountId || replacement.account.tenantId !== before.account.tenantId) {
      throw new Error('Choose the same Microsoft Entra account to renew this connection.')
    }
    grant.credentials = replacement
    grant.pending = undefined
  }

  async token(id: string): Promise<string> {
    const grant = this.grants.get(id)
    if (!grant) throw new Error(signedOut)
    const current = grant.credentials
    if (current.expires - Date.now() > 120_000) return current.token
    grant.pending ??= current.identity.acquireTokenSilent({ account: current.account, scopes, forceRefresh: true }).then(result => {
      if (this.grants.get(id) !== grant) throw new Error(signedOut)
      if (grant.credentials !== current) return grant.credentials.token
      if (!result || result.account?.homeAccountId !== current.account.homeAccountId) throw new Error(signedOut)
      current.token = checkToken(result, current.account.tenantId)
      current.expires = result.expiresOn!.getTime()
      return current.token
    }).catch(() => {
      if (this.grants.get(id) === grant && grant.credentials !== current) return grant.credentials.token
      throw new Error(signedOut)
    }).finally(() => { if (grant.credentials === current) grant.pending = undefined })
    return grant.pending
  }

  cancel(id: string) { if (this.interactive?.id === id) this.interactive.controller.abort() }
  clear() { this.interactive?.controller.abort(); this.grants.clear() }
}
