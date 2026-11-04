import { request } from 'node:http'
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { AccountInfo, AuthenticationResult } from '@azure/msal-node'
import { EntraGrants } from '../../src/main/entra'
import { withEntraToken, resolveEntraToken } from '../../src/connections/entra-transport'
import { connectionSchema, profileSchema } from '../../src/shared/contracts'
import { connectionProfile } from '../../src/shared/connection-profiles'
import { buildSqlServerConfig } from '../../src/driver/sqlserver-transport'

const profile = { tenantId: '6ae9079a-d895-4ff4-8baf-d7a6959c76d6', clientId: 'bf41c407-e027-4c2a-95b9-6be2635f30bf' }
const config = connectionSchema.parse({
  engine: 'azure-sql', name: 'Test Azure', host: 'test.database.windows.net', port: 1433,
  database: 'test', user: '', password: '', authentication: 'entra-interactive', entra: profile, tls: 'verify-full'
})
const account = { tenantId: profile.tenantId, homeAccountId: 'account-1', username: 'fixture@example.test' } as AccountInfo
const token = (value: string, identity = account) => ({
  account: identity, accessToken: value, expiresOn: new Date(Date.now() + 180_000)
}) as AuthenticationResult

function callback(authorize: URL, values: Record<string, string>) {
  const endpoint = new URL(authorize.searchParams.get('redirect_uri')!)
  return new Promise<number>((resolve, reject) => {
    const address = new URL(endpoint)
    address.hostname = '127.0.0.1'
    address.search = new URLSearchParams({ state: authorize.searchParams.get('state')!, code: 'fixture-code', ...values }).toString()
    const req = request(address, { headers: { Host: endpoint.host } }, response => {
      response.resume()
      response.on('end', () => resolve(response.statusCode!))
    })
    req.on('error', reject)
    req.end()
  })
}

function identity() {
  const sdk = {
    getAuthCodeUrl: vi.fn(async (input: { authority?: string; redirectUri: string; state?: string }) => {
      const url = new URL(`${input.authority}/oauth2/v2.0/authorize`)
      url.search = new URLSearchParams({ redirect_uri: input.redirectUri, state: input.state! }).toString()
      return url.toString()
    }),
    acquireTokenByCode: vi.fn(async () => token('first-access')),
    acquireTokenSilent: vi.fn(async () => token('refreshed-access'))
  }
  return sdk
}

afterEach(() => vi.restoreAllMocks())

it('uses a state-bound loopback and PKCE and coalesces silent renewal for live owners', async () => {
  const sdk = identity()
  const broker = new EntraGrants(async value => {
    const url = new URL(value)
    expect(await callback(url, { state: 'forged' })).toBe(400)
    expect(await callback(url, {})).toBe(200)
  }, () => sdk)
  const grant = await broker.open(profile)
  const authorize = sdk.getAuthCodeUrl.mock.calls[0][0] as unknown as { codeChallenge: string; codeChallengeMethod: string }
  const exchange = sdk.acquireTokenByCode.mock.calls[0] as unknown as [{ code: string; codeVerifier: string }]
  expect(exchange[0].code).toBe('fixture-code')
  expect(authorize.codeChallengeMethod).toBe('S256')
  expect(authorize.codeChallenge).toBe(createHash('sha256').update(exchange[0].codeVerifier).digest('base64url'))
  expect(await broker.token(grant)).toBe('first-access')
  const before = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => before + 150_000)
  expect(await Promise.all([broker.token(grant), broker.token(grant)])).toEqual(['refreshed-access', 'refreshed-access'])
  expect(sdk.acquireTokenSilent).toHaveBeenCalledTimes(1)
  broker.retain(grant)
  broker.release(grant)
  expect(await broker.token(grant)).toBe('refreshed-access')
  broker.release(grant)
  await expect(broker.token(grant)).rejects.toThrow(/sign-in is required/)
})

it('cancels a pending loopback sign-in without exchanging a code or accepting a late response', async () => {
  const sdk = identity()
  let opened!: (url: string) => void
  const browser = new Promise<string>(resolve => { opened = resolve })
  const broker = new EntraGrants(async value => { opened(value) }, () => sdk)
  const attempt = { id: '64475b55-0969-4d8b-8a39-472ce1c71de7', surface: 'dialog' } as const
  const active = broker.open(profile, undefined, attempt)
  const url = new URL(await browser)
  await expect(broker.open(profile)).rejects.toThrow(/current Microsoft Entra sign-in/)
  broker.cancel('33c4eddc-12b1-4a98-9160-82485e067c7e')
  expect(await callback(url, { state: 'forged' })).toBe(400)
  broker.cancel(attempt.id)
  await expect(active).rejects.toThrow(/cancelled/)
  await expect(callback(url, {})).rejects.toThrow()
  expect(sdk.acquireTokenByCode).not.toHaveBeenCalled()
})

it('requires the same account during explicit renewal and keeps the current grant if renewal fails', async () => {
  const sdk = identity()
  sdk.acquireTokenByCode.mockResolvedValueOnce(token('first-access'))
    .mockResolvedValueOnce(token('other-access', { ...account, homeAccountId: 'account-2' }))
    .mockResolvedValueOnce(token('same-account-access'))
  const broker = new EntraGrants(async value => { await callback(new URL(value), {}) }, () => sdk)
  const grant = await broker.open(profile)
  await expect(broker.renew(grant, profile)).rejects.toThrow(/same Microsoft Entra account/)
  expect(await broker.token(grant)).toBe('first-access')
  await broker.renew(grant, profile)
  expect(await broker.token(grant)).toBe('same-account-access')
})

it('keeps only public registration fields in profiles and uses the current token for each native open', async () => {
  const provider = vi.fn().mockResolvedValueOnce('first-access').mockResolvedValueOnce('second-access')
  const attached = withEntraToken(config, provider)
  expect(JSON.stringify(attached)).not.toContain('first-access')
  expect(profileSchema.parse(connectionProfile(config))).toMatchObject({ entra: profile })
  expect(profileSchema.safeParse({ ...connectionProfile(config), accessToken: 'secret' }).success).toBe(false)
  for (const unsafe of [{ host: 'outside.example.test' }, { ca: 'private CA' }, { tls: 'disable' }, { database: '' }, { password: 'secret' }, { accessToken: 'secret' }]) {
    expect(connectionSchema.safeParse({ ...config, ...unsafe }).success).toBe(false)
  }
  const first = buildSqlServerConfig(await resolveEntraToken(attached))
  const second = buildSqlServerConfig(await resolveEntraToken({ ...attached, database: 'other' }))
  expect(first.authentication).toMatchObject({ type: 'azure-active-directory-access-token', options: { token: 'first-access' } })
  expect(second.authentication).toMatchObject({ options: { token: 'second-access' } })
  expect(second.options).toMatchObject({ database: 'other', encrypt: true, trustServerCertificate: false })
  await expect(resolveEntraToken(config)).rejects.toThrow(/sign in/i)
})

it('exchanges a PKCE code and renews with the packaged MSAL client against a mock issuer', async () => {
  const authority = `https://login.microsoftonline.com/${profile.tenantId}`
  const authorizeEndpoint = `${authority}/oauth2/v2.0/authorize`
  const tokenEndpoint = `${authority}/oauth2/v2.0/token`
  const claims = { oid: 'fixture-user', sub: 'fixture-user', tid: profile.tenantId,
    aud: profile.clientId, iss: `${authority}/v2.0`, preferred_username: account.username,
    exp: Math.floor(Date.now() / 1000) + 3600 }
  const base64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const requests: URLSearchParams[] = []
  const network = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.redirect).toBe('error')
    if (url === `${authority}/v2.0/.well-known/openid-configuration`) return Response.json({
      issuer: claims.iss, authorization_endpoint: authorizeEndpoint, token_endpoint: tokenEndpoint,
      end_session_endpoint: `${authority}/oauth2/v2.0/logout`
    })
    const endpoint = new URL(url)
    expect(endpoint.origin + endpoint.pathname).toBe(tokenEndpoint)
    const params = new URLSearchParams(String(init.body))
    requests.push(params)
    return Response.json({
      token_type: 'Bearer', scope: 'https://database.windows.net/user_impersonation', expires_in: 1800,
      access_token: requests.length === 1 ? 'fixture-access' : 'fixture-renewed',
      refresh_token: 'fixture-refresh',
      id_token: `${base64({ alg: 'RS256', typ: 'JWT' })}.${base64(claims)}.fixture-signature`,
      client_info: base64({ uid: claims.oid, utid: claims.tid })
    })
  })
  vi.stubGlobal('fetch', network)
  let challenge = ''
  try {
    const broker = new EntraGrants(async address => {
      const url = new URL(address)
      expect(url.origin + url.pathname).toBe(authorizeEndpoint)
      expect(url.searchParams.get('scope')).toContain('https://database.windows.net/user_impersonation')
      expect(url.searchParams.get('code_challenge_method')).toBe('S256')
      challenge = url.searchParams.get('code_challenge')!
      expect(await callback(url, {})).toBe(200)
    })
    const id = await broker.open(profile)
    expect(await broker.token(id)).toBe('fixture-access')
    expect(requests[0].get('grant_type')).toBe('authorization_code')
    expect(requests[0].get('client_secret')).toBeNull()
    expect(createHash('sha256').update(requests[0].get('code_verifier')!).digest('base64url')).toBe(challenge)
    const before = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => before + 1750_000)
    expect(await broker.token(id)).toBe('fixture-renewed')
    expect(requests[1].get('grant_type')).toBe('refresh_token')
    expect(requests[1].get('refresh_token')).toBe('fixture-refresh')
  } finally { vi.unstubAllGlobals() }
})
