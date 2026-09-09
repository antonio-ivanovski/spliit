import { createHash, randomBytes } from 'node:crypto'

import { makeSignature } from 'better-auth/crypto'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { prisma } from '@spliit/db'

import { app } from '../app'
import { revokeAuthorizedClient } from '../lib/auth/authorized-clients'
import { oauthRevocationBarrierIdentifier } from '../lib/auth/oauth-revocation-barrier'
import { getApiBaseUrl } from '../lib/auth/urls'
import { env } from '../lib/env'
import { assistantRouter } from '../trpc/routers/assistant'
import { groupsRouter } from '../trpc/routers/groups'
import { checkDbConnection, testRunId } from './setup'

await checkDbConnection()

const REDIRECT_URI = 'http://localhost:3002/oauth/callback'
const API_AUDIENCE = getApiBaseUrl()
const ISSUER = `${API_AUDIENCE}/auth`
const AUDIENCE = `${env.MCP_PUBLIC_URL}/mcp`
const SCOPES =
  'openid profile email offline_access spliit:groups:read spliit:expenses:write'

const trackedClientIds: string[] = []
const trackedAccountIds: string[] = []

afterAll(async () => {
  if (trackedClientIds.length > 0) {
    await prisma.oauthClient.deleteMany({
      where: { clientId: { in: trackedClientIds } },
    })
  }
  if (trackedAccountIds.length > 0) {
    await prisma.session.deleteMany({
      where: { userId: { in: trackedAccountIds } },
    })
    await prisma.account.deleteMany({
      where: { id: { in: trackedAccountIds } },
    })
  }
})

function base64url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function makePkce() {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

async function registerClient(
  clientName: string,
  registration?: { scope?: string; resources?: string[] },
): Promise<string> {
  const res = await app.request('/auth/oauth2/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(registration?.scope ? { scope: registration.scope } : {}),
      ...(registration?.resources ? { resources: registration.resources } : {}),
    }),
  })
  const body = (await res.json()) as {
    client_id?: string
    error?: string
    error_description?: string
  }
  if (!res.ok || !body.client_id) {
    throw new Error(
      `client registration failed (${res.status}): ${JSON.stringify(body)}`,
    )
  }
  trackedClientIds.push(body.client_id)
  return body.client_id
}

/** Drive authorize -> consent page redirect -> consent approval -> code. */
async function authorizeToCode(opts: {
  clientId: string
  cookie: string
  challenge: string
  state: string
  authorizationEndpoint?: string
  scope?: string
  resource?: string
  accept?: boolean
}): Promise<{ code: string | null; callbackUrl: string; location: string }> {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: opts.clientId,
    redirect_uri: REDIRECT_URI,
    scope: opts.scope ?? SCOPES,
    state: opts.state,
    code_challenge: opts.challenge,
    code_challenge_method: 'S256',
  })
  if (opts.resource) params.set('resource', opts.resource)
  const authorizationEndpoint = opts.authorizationEndpoint
    ? new URL(opts.authorizationEndpoint).pathname
    : '/auth/oauth2/authorize'
  const authorizeRes = await app.request(
    `${authorizationEndpoint}?${params.toString()}`,
    { method: 'GET', headers: { cookie: opts.cookie } },
  )
  expect(authorizeRes.status).toBeGreaterThanOrEqual(300)
  expect(authorizeRes.status).toBeLessThan(400)
  const location = authorizeRes.headers.get('location') ?? ''
  expect(location).toContain('/oauth/consent')

  // Mirror the web client: prefer an explicit oauth_query param, else the
  // whole signed query string Better Auth placed on the consent redirect.
  const search = new URL(location, 'http://localhost').search.replace(/^\?/, '')
  const oauthQuery = new URLSearchParams(search).get('oauth_query') ?? search

  const consentRes = await app.request('/auth/oauth2/consent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: opts.cookie },
    body: JSON.stringify({
      accept: opts.accept ?? true,
      oauth_query: oauthQuery,
    }),
  })
  const consentBody = (await consentRes.json()) as {
    url?: string
    redirect_uri?: string
  }
  const callbackUrl = consentBody.url ?? consentBody.redirect_uri ?? ''
  expect(callbackUrl).toBeTruthy()
  const code = new URL(callbackUrl, 'http://localhost').searchParams.get('code')
  return { code, callbackUrl, location }
}

async function exchangeCode(opts: {
  clientId: string
  code: string
  verifier: string
  tokenEndpoint?: string
  resource?: string
}): Promise<Response> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: opts.clientId,
    code: opts.code,
    code_verifier: opts.verifier,
    redirect_uri: REDIRECT_URI,
  })
  if (opts.resource) form.set('resource', opts.resource)
  const tokenEndpoint = opts.tokenEndpoint
    ? new URL(opts.tokenEndpoint).pathname
    : '/auth/oauth2/token'
  return app.request(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
}

async function localJwks() {
  const res = await app.request('/auth/jwks')
  const jwks = (await res.json()) as Parameters<typeof createLocalJWKSet>[0]
  return createLocalJWKSet(jwks)
}

async function refreshAccessToken(opts: {
  clientId: string
  refreshToken: string
  resource?: string
}): Promise<Response> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: opts.clientId,
    refresh_token: opts.refreshToken,
  })
  if (opts.resource) form.set('resource', opts.resource)
  return app.request('/auth/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
}

/**
 * Exercise the real Hono + tRPC bearer boundary without starting a server.
 * Token verification fetches the configured JWKS URL, so route that one
 * process-local request back through the same Hono app.
 */
async function trpcOverHttp(
  pathWithQuery: string,
  init: RequestInit,
): Promise<Response> {
  const originalFetch = globalThis.fetch.bind(globalThis)
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, requestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      if (url === `${ISSUER}/jwks`) {
        return app.request('/auth/jwks', requestInit)
      }
      return originalFetch(input, requestInit)
    })

  try {
    return await app.request(pathWithQuery, init)
  } finally {
    fetchSpy.mockRestore()
  }
}

async function listGroupsOverHttp(accessToken: string): Promise<Response> {
  const input = encodeURIComponent(JSON.stringify({ json: { groupIds: [] } }))
  return trpcOverHttp(`/trpc/groups.list?input=${input}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}` },
  })
}

describe('OAuth authorization code + PKCE + refresh', () => {
  const runId = testRunId()

  // One verified account + one signed Better Auth session cookie reused by
  // every test: sign-up, credential sign-in and verification email are
  // covered by dedicated suites; this file only needs a valid session.
  let fixtureAccountId = ''
  let fixtureCookie = ''

  beforeAll(async () => {
    const rawToken = randomBytes(32).toString('base64url')
    const signature = await makeSignature(rawToken, env.BETTER_AUTH_SECRET)
    // One hour comfortably outlives a suite run while limiting damage if
    // cleanup never gets to run.
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60)
    // Transaction so a failed session insert cannot leak the account row.
    const accountId = await prisma.$transaction(async (tx) => {
      const account = await tx.account.create({
        data: {
          id: `oauth-fixture-${runId}`,
          email: `oauth-user-${runId}@test.example`,
          name: 'OAuth Fixture',
          emailVerified: true,
        },
      })
      await tx.session.create({
        data: {
          id: `oauth-fixture-sess-${runId}`,
          userId: account.id,
          token: rawToken,
          expiresAt,
        },
      })
      return account.id
    })
    trackedAccountIds.push(accountId)
    fixtureAccountId = accountId
    // Same value format Better Auth sets on sign-in: raw.signature.
    fixtureCookie = `better-auth.session_token=${rawToken}.${signature}`
  })

  it('discovers OAuth from an unauthenticated API request', async () => {
    const input = encodeURIComponent(JSON.stringify({ json: { groupIds: [] } }))
    const unauthorized = await app.request(`/trpc/groups.list?input=${input}`)
    expect(unauthorized.status).toBe(401)

    const challenge = unauthorized.headers.get('www-authenticate')
    const metadataUrl = challenge?.match(/resource_metadata="([^"]+)"/)?.[1]
    expect(metadataUrl).toBe(
      `${API_AUDIENCE}/.well-known/oauth-protected-resource`,
    )

    const metadataResponse = await app.request(metadataUrl!)
    expect(metadataResponse.status).toBe(200)
    const metadata = (await metadataResponse.json()) as {
      resource: string
      authorization_servers: string[]
      scopes_supported: string[]
      bearer_methods_supported: string[]
    }
    expect(metadata).toMatchObject({
      resource: API_AUDIENCE,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
    })
    expect(metadata.scopes_supported).toContain('spliit:groups:read')

    const issuerPath = new URL(metadata.authorization_servers[0]!).pathname
    const discoveryResponse = await app.request(
      `/.well-known/oauth-authorization-server${issuerPath}`,
    )
    expect(discoveryResponse.status).toBe(200)
    const discovery = (await discoveryResponse.json()) as {
      registration_endpoint: string
      authorization_endpoint: string
      token_endpoint: string
      code_challenge_methods_supported: string[]
    }
    expect(discovery).toMatchObject({
      authorization_endpoint: `${ISSUER}/oauth2/authorize`,
      token_endpoint: `${ISSUER}/oauth2/token`,
      code_challenge_methods_supported: ['S256'],
    })

    const registrationResponse = await app.request(
      discovery.registration_endpoint,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: `Discovered agent ${runId}`,
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
        }),
      },
    )
    expect(registrationResponse.status).toBe(201)
    const registration = (await registrationResponse.json()) as {
      client_id: string
    }
    expect(registration.client_id).toBeTruthy()
    trackedClientIds.push(registration.client_id)

    const { verifier, challenge: codeChallenge } = makePkce()
    const { code } = await authorizeToCode({
      clientId: registration.client_id,
      cookie: fixtureCookie,
      challenge: codeChallenge,
      state: `state-discovered-${runId}`,
      authorizationEndpoint: discovery.authorization_endpoint,
      scope: 'openid profile email offline_access spliit:groups:read',
    })
    expect(code).toBeTruthy()

    const tokenResponse = await exchangeCode({
      clientId: registration.client_id,
      code: code!,
      verifier,
      tokenEndpoint: discovery.token_endpoint,
    })
    expect(tokenResponse.status).toBe(200)
    const tokens = (await tokenResponse.json()) as { access_token: string }
    expect(tokens.access_token).toBeTruthy()

    const apiResponse = await listGroupsOverHttp(tokens.access_token)
    expect(apiResponse.status).toBe(200)
  })

  it('defaults an omitted resource to the API through exchange and refresh', async () => {
    const clientId = await registerClient(`OAuth API default ${runId}`)
    const { verifier, challenge } = makePkce()

    // Deliberately omit `resource` from all three protocol requests. The
    // authorization server must persist its API default in the code and the
    // resulting refresh-token family.
    const { code } = await authorizeToCode({
      clientId,
      cookie: fixtureCookie,
      challenge,
      state: `state-api-default-${runId}`,
      scope: 'openid profile email offline_access spliit:groups:read',
    })
    expect(code).toBeTruthy()

    const tokenRes = await exchangeCode({
      clientId,
      code: code!,
      verifier,
    })
    expect(tokenRes.status).toBe(200)
    const tokens = (await tokenRes.json()) as {
      access_token: string
      refresh_token?: string
      token_type: string
      scope: string
    }
    expect(tokens.token_type.toLowerCase()).toBe('bearer')
    expect(tokens.refresh_token).toBeTruthy()

    const jwks = await localJwks()
    const { payload } = await jwtVerify(tokens.access_token, jwks, {
      issuer: ISSUER,
      audience: API_AUDIENCE,
    })
    expect(payload.sub).toBe(fixtureAccountId)
    expect(Array.isArray(payload.aud) ? payload.aud : [payload.aud]).toContain(
      API_AUDIENCE,
    )

    const groupsRes = await listGroupsOverHttp(tokens.access_token)
    expect(groupsRes.status).toBe(200)
    const groupsBody = (await groupsRes.json()) as {
      result?: { data?: { json?: { groups?: unknown[] } } }
      error?: unknown
    }
    expect(groupsBody.error).toBeUndefined()
    expect(groupsBody.result?.data?.json?.groups).toEqual(expect.any(Array))

    const refreshRes = await refreshAccessToken({
      clientId,
      refreshToken: tokens.refresh_token!,
    })
    expect(refreshRes.status).toBe(200)
    const refreshed = (await refreshRes.json()) as { access_token: string }
    const { payload: refreshedPayload } = await jwtVerify(
      refreshed.access_token,
      jwks,
      { issuer: ISSUER, audience: API_AUDIENCE },
    )
    expect(refreshedPayload.sub).toBe(fixtureAccountId)
    expect(
      Array.isArray(refreshedPayload.aud)
        ? refreshedPayload.aud
        : [refreshedPayload.aud],
    ).toContain(API_AUDIENCE)
  })

  it('completes the full flow and mints a verifiable MCP-audience token', async () => {
    const clientId = await registerClient(`OAuth flow ${runId}`, {
      scope: SCOPES,
      resources: [AUDIENCE],
    })
    const { verifier, challenge } = makePkce()
    const accountId = fixtureAccountId

    const { code } = await authorizeToCode({
      clientId,
      cookie: fixtureCookie,
      challenge,
      state: `state-${runId}`,
      resource: AUDIENCE,
    })
    expect(code).toBeTruthy()

    const tokenRes = await exchangeCode({
      clientId,
      code: code!,
      verifier,
      resource: AUDIENCE,
    })
    expect(tokenRes.status).toBe(200)
    const tokens = (await tokenRes.json()) as {
      access_token: string
      refresh_token?: string
      token_type: string
      scope: string
      expires_in: number
    }
    expect(tokens.token_type.toLowerCase()).toBe('bearer')
    expect(tokens.access_token).toBeTruthy()
    expect(tokens.refresh_token).toBeTruthy()
    expect(tokens.scope.split(' ')).toEqual(
      expect.arrayContaining(['spliit:groups:read', 'spliit:expenses:write']),
    )

    // Signature + issuer + audience + expiry verified against the real JWKS.
    const jwks = await localJwks()
    const { payload } = await jwtVerify(tokens.access_token, jwks, {
      issuer: ISSUER,
      audience: AUDIENCE,
    })
    expect(payload.sub).toBe(accountId)
    expect(typeof payload.exp).toBe('number')

    // Exercise the MCP-specific assistant surface with the verified token's
    // identity fields. The API-default case above covers the real HTTP bearer
    // and JWKS boundary; this assertion stays focused on legacy MCP behavior.
    const account = await prisma.account.findUnique({
      where: { id: accountId },
    })
    const groupCaller = groupsRouter.createCaller({
      auth: {
        session: { id: `sess-${runId}` },
        user: account,
      },
    } as never)
    const created = await groupCaller.create({
      requestId: crypto.randomUUID(),
      groupFormValues: {
        name: `OAuth Group ${runId}`,
        currency: '$',
        currencyCode: 'USD',
        participants: [{ name: 'OAuth Flow' }],
      },
    })
    const groupId = created.groupId

    const assistantCaller = assistantRouter.createCaller({
      auth: {
        credentialKind: 'oauth',
        accessToken: tokens.access_token,
        scopes: tokens.scope.split(' '),
        user: account,
        session: { id: `oauth:${accountId}` },
      },
    } as never)
    const context = await assistantCaller.listGroups()
    expect(context.connectedAccount.name).toBe(account?.name)
    expect(context.groups.map((group) => group.id)).toContain(groupId)

    // Simulate the 1.6 -> 1.7 schema migration, which leaves existing grants
    // with an empty resource list. The compatibility hook must bind this old
    // family to its explicitly requested MCP resource before Better Auth
    // applies 1.7's no-widening check.
    await prisma.oauthRefreshToken.updateMany({
      where: { clientId, userId: accountId, revoked: null },
      data: { resources: [] },
    })
    await prisma.oauthConsent.updateMany({
      where: { clientId, userId: accountId },
      data: { resources: [] },
    })

    // Refresh grant returns a new working access token.
    const refreshRes = await refreshAccessToken({
      clientId,
      refreshToken: tokens.refresh_token!,
      resource: AUDIENCE,
    })
    expect(refreshRes.status).toBe(200)
    const refreshed = (await refreshRes.json()) as { access_token: string }
    const { payload: refreshedPayload } = await jwtVerify(
      refreshed.access_token,
      jwks,
      { issuer: ISSUER, audience: AUDIENCE },
    )
    expect(refreshedPayload.sub).toBe(accountId)
    const rotatedFamily = await prisma.oauthRefreshToken.findFirst({
      where: { clientId, userId: accountId, revoked: null },
      orderBy: { createdAt: 'desc' },
      select: { resources: true },
    })
    expect(rotatedFamily?.resources).toContain(AUDIENCE)

    await prisma.group.deleteMany({ where: { id: groupId } })
  })

  it('rejects token exchange when the PKCE verifier is wrong', async () => {
    const clientId = await registerClient(`OAuth PKCE ${runId}`, {
      scope: SCOPES,
      resources: [AUDIENCE],
    })
    const { challenge } = makePkce()

    const { code } = await authorizeToCode({
      clientId,
      cookie: fixtureCookie,
      challenge,
      state: `state-pkce-${runId}`,
      resource: AUDIENCE,
    })
    expect(code).toBeTruthy()

    const tokenRes = await exchangeCode({
      clientId,
      code: code!,
      verifier: base64url(randomBytes(32)),
      resource: AUDIENCE,
    })
    expect(tokenRes.status).toBeGreaterThanOrEqual(400)
  })

  it('cannot exchange a pending code after the client is revoked', async () => {
    const clientId = await registerClient(`OAuth revoked code ${runId}`)
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeToCode({
      clientId,
      cookie: fixtureCookie,
      challenge,
      state: `state-revoked-code-${runId}`,
      scope: 'openid profile offline_access spliit:groups:read',
    })
    expect(code).toBeTruthy()

    const storedCode = createHash('sha256').update(code!).digest('base64url')
    const pendingCode = await prisma.verification.findFirst({
      where: { identifier: storedCode },
      select: { expiresAt: true, value: true },
    })
    expect(pendingCode).not.toBeNull()

    const consent = await prisma.oauthConsent.findFirst({
      where: { clientId, userId: fixtureAccountId },
      select: {
        id: true,
        requestedUserInfoClaims: true,
        resources: true,
        scopes: true,
      },
    })
    expect(consent).not.toBeNull()
    // Better Auth does not have a (userId, clientId) unique constraint. Keep a
    // duplicate around to prove revocation removes the complete authorization,
    // not just the consent row selected by the UI.
    await prisma.oauthConsent.create({
      data: {
        id: `duplicate-consent-${runId}`,
        clientId,
        userId: fixtureAccountId,
        requestedUserInfoClaims: consent!.requestedUserInfoClaims,
        resources: consent!.resources,
        scopes: consent!.scopes,
      },
    })
    const revoked = await revokeAuthorizedClient({
      accountId: fixtureAccountId,
      consentId: consent!.id,
    })
    expect(revoked?.authorizationCodesDeleted).toBeGreaterThan(0)
    await expect(
      prisma.oauthConsent.count({
        where: { clientId, userId: fixtureAccountId },
      }),
    ).resolves.toBe(0)
    await expect(
      prisma.verification.count({
        where: {
          identifier: oauthRevocationBarrierIdentifier(
            fixtureAccountId,
            clientId,
          ),
        },
      }),
    ).resolves.toBe(1)

    // Model the late INSERT side of an authorize/revoke race. The cleanup has
    // already swept the original row, but the committed barrier must still
    // make this identical code unusable.
    await prisma.verification.create({
      data: {
        id: `late-oauth-code-${runId}`,
        identifier: storedCode,
        value: pendingCode!.value,
        expiresAt: pendingCode!.expiresAt,
      },
    })

    const tokenRes = await exchangeCode({
      clientId,
      code: code!,
      verifier,
    })
    expect(tokenRes.status).toBeGreaterThanOrEqual(400)
    await expect(tokenRes.json()).resolves.toMatchObject({
      error: 'invalid_grant',
    })
  })

  it('allows a client again only after a new explicit consent', async () => {
    const clientId = await registerClient(`OAuth reauthorize ${runId}`)
    const firstPkce = makePkce()
    const first = await authorizeToCode({
      clientId,
      cookie: fixtureCookie,
      challenge: firstPkce.challenge,
      state: `state-before-revoke-${runId}`,
      scope: 'openid profile offline_access spliit:groups:read',
    })
    expect(first.code).toBeTruthy()

    const consent = await prisma.oauthConsent.findFirst({
      where: { clientId, userId: fixtureAccountId },
      select: { id: true },
    })
    await revokeAuthorizedClient({
      accountId: fixtureAccountId,
      consentId: consent!.id,
    })

    const secondPkce = makePkce()
    const second = await authorizeToCode({
      clientId,
      cookie: fixtureCookie,
      challenge: secondPkce.challenge,
      state: `state-after-revoke-${runId}`,
      scope: 'openid profile offline_access spliit:groups:read',
    })
    expect(second.code).toBeTruthy()

    await expect(
      prisma.verification.count({
        where: {
          identifier: oauthRevocationBarrierIdentifier(
            fixtureAccountId,
            clientId,
          ),
        },
      }),
    ).resolves.toBe(0)
    const tokenRes = await exchangeCode({
      clientId,
      code: second.code!,
      verifier: secondPkce.verifier,
    })
    expect(tokenRes.status).toBe(200)
  })

  it('rejects a requested resource that is not a valid audience', async () => {
    const clientId = await registerClient(`OAuth audience ${runId}`, {
      scope: SCOPES,
      resources: [AUDIENCE],
    })
    const { verifier, challenge } = makePkce()

    const { code } = await authorizeToCode({
      clientId,
      cookie: fixtureCookie,
      challenge,
      state: `state-aud-${runId}`,
    })
    expect(code).toBeTruthy()

    const tokenRes = await exchangeCode({
      clientId,
      code: code!,
      verifier,
      resource: 'https://evil.example/mcp',
    })
    expect(tokenRes.status).toBeGreaterThanOrEqual(400)
  })

  it('enforces scopes on the assistant write boundary', async () => {
    const clientId = await registerClient(`OAuth scope ${runId}`, {
      resources: [AUDIENCE],
    })
    const { verifier, challenge } = makePkce()
    const accountId = fixtureAccountId

    // Read-only scope set: no spliit:expenses:write.
    const readScope = 'openid profile offline_access spliit:groups:read'
    const { code } = await authorizeToCode({
      clientId,
      cookie: fixtureCookie,
      challenge,
      state: `state-scope-${runId}`,
      scope: readScope,
      resource: AUDIENCE,
    })
    expect(code).toBeTruthy()
    const tokenRes = await exchangeCode({
      clientId,
      code: code!,
      verifier,
      resource: AUDIENCE,
    })
    const tokens = (await tokenRes.json()) as {
      access_token: string
      scope: string
    }
    expect(tokens.scope.split(' ')).not.toContain('spliit:expenses:write')

    const account = await prisma.account.findUnique({
      where: { id: accountId },
    })
    const assistantCaller = assistantRouter.createCaller({
      auth: {
        credentialKind: 'oauth',
        accessToken: tokens.access_token,
        scopes: tokens.scope.split(' '),
        user: account,
        session: { id: `oauth:${accountId}` },
      },
    } as never)

    // Read works...
    await expect(assistantCaller.listGroups()).resolves.toBeTruthy()
    // ...but the write procedure rejects the missing scope.
    await expect(
      assistantCaller.prepareExpense({
        groupId: 'group-x',
        amount: '10',
        title: 'Lunch',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('rejects an MCP-audience token at the direct API with invalid_token', async () => {
    // RFC 8707 / RFC 9700 audience separation: the MCP server forwards its
    // callers' bearer tokens to the assistant surface, so a token minted for
    // the MCP resource must never double as a direct API credential.
    const clientId = await registerClient(`OAuth aud separation ${runId}`, {
      scope: SCOPES,
      resources: [AUDIENCE],
    })
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeToCode({
      clientId,
      cookie: fixtureCookie,
      challenge,
      state: `state-aud-separation-${runId}`,
      resource: AUDIENCE,
    })
    const tokenRes = await exchangeCode({
      clientId,
      code: code!,
      verifier,
      resource: AUDIENCE,
    })
    expect(tokenRes.status).toBe(200)
    const tokens = (await tokenRes.json()) as { access_token: string }

    const apiRes = await listGroupsOverHttp(tokens.access_token)
    expect(apiRes.status).toBe(401)
    const wwwAuthenticate = apiRes.headers.get('www-authenticate')
    expect(wwwAuthenticate).toContain('error="invalid_token"')
    expect(wwwAuthenticate).toContain('resource_metadata=')
  })

  it('answers a missing bearer with the operation scope and no error code', async () => {
    const input = encodeURIComponent(JSON.stringify({ json: { groupIds: [] } }))
    const response = await app.request(`/trpc/groups.list?input=${input}`)

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer scope="spliit:groups:read", resource_metadata="${API_AUDIENCE}/.well-known/oauth-protected-resource"`,
    )
  })

  it('answers a malformed bearer with invalid_token', async () => {
    const response = await listGroupsOverHttp('not-a-jwt-at-all')

    expect(response.status).toBe(401)
    const wwwAuthenticate = response.headers.get('www-authenticate')
    expect(wwwAuthenticate).toContain('error="invalid_token"')
    expect(wwwAuthenticate).toContain('scope="spliit:groups:read"')
  })

  it('asks for step-up with insufficient_scope when a read token hits a write', async () => {
    // Default registration is read-only, so the write below must fail with
    // the exact scope the agent should request next.
    const clientId = await registerClient(`OAuth step-up ${runId}`)
    const { verifier, challenge } = makePkce()
    const { code } = await authorizeToCode({
      clientId,
      cookie: fixtureCookie,
      challenge,
      state: `state-step-up-${runId}`,
      scope: 'openid profile email offline_access spliit:groups:read',
    })
    const tokenRes = await exchangeCode({ clientId, code: code!, verifier })
    expect(tokenRes.status).toBe(200)
    const tokens = (await tokenRes.json()) as {
      access_token: string
      scope: string
    }
    expect(tokens.scope.split(' ')).not.toContain('spliit:groups:manage')

    // The read surface stays reachable...
    const readRes = await listGroupsOverHttp(tokens.access_token)
    expect(readRes.status).toBe(200)

    // ...while the manage surface returns an actionable step-up challenge.
    const writeRes = await trpcOverHttp('/trpc/groups.update', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ json: {} }),
    })
    expect(writeRes.status).toBe(403)
    expect(writeRes.headers.get('www-authenticate')).toBe(
      `Bearer error="insufficient_scope", scope="spliit:groups:manage", resource_metadata="${API_AUDIENCE}/.well-known/oauth-protected-resource"`,
    )
    expect(writeRes.headers.get('access-control-expose-headers')).toContain(
      'WWW-Authenticate',
    )
  })
})
