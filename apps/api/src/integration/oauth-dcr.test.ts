import { afterAll, describe, expect, it } from 'vitest'

import { prisma } from '@spliit/db'

import { app } from '../app'
import {
  ASSISTANT_WRITE_SCOPE,
  DEFAULT_CLIENT_SCOPES,
  DESTRUCTIVE_SCOPES,
  SPLIIT_SCOPES,
} from '../lib/auth/scopes'
import { getApiBaseUrl } from '../lib/auth/urls'
import { checkDbConnection } from './setup'

await checkDbConnection()

describe('OAuth dynamic client registration', () => {
  const clientIds: string[] = []

  afterAll(async () => {
    await prisma.oauthClient.deleteMany({
      where: { clientId: { in: clientIds } },
    })
  })

  it('registers a minimal public client with safe API defaults', async () => {
    const response = await app.request('/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Spliit OAuth integration test',
        redirect_uris: ['http://localhost:3002/oauth/callback'],
        token_endpoint_auth_method: 'none',
      }),
    })
    expect(response.status).toBe(201)

    const body = (await response.json()) as {
      client_id: string
      contacts: string[]
      post_logout_redirect_uris: string[]
      grant_types: string[]
      response_types: string[]
      scope: string
      resources: string[]
    }
    if (body.client_id) clientIds.push(body.client_id)

    expect(body).toMatchObject({
      contacts: [],
      post_logout_redirect_uris: [],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      resources: [getApiBaseUrl()],
    })
    const registeredScopes = body.scope.split(' ')
    expect(new Set(registeredScopes)).toEqual(new Set(DEFAULT_CLIENT_SCOPES))
    expect(registeredScopes).toEqual(
      expect.arrayContaining([
        SPLIIT_SCOPES.groupsRead,
        SPLIIT_SCOPES.expensesRead,
      ]),
    )
    // An omitted `scope` must never grant write authority: no manage, no
    // delete, no legacy assistant write. Clients name those explicitly and
    // reach them through the insufficient_scope step-up flow.
    expect(registeredScopes).not.toContain(SPLIIT_SCOPES.groupsManage)
    expect(registeredScopes).not.toContain(SPLIIT_SCOPES.expensesManage)
    for (const scope of DESTRUCTIVE_SCOPES) {
      expect(registeredScopes).not.toContain(scope)
    }
    expect(registeredScopes).not.toContain(ASSISTANT_WRITE_SCOPE)
  })

  it('still registers manage scopes when a client asks for them by name', async () => {
    const requestedScope = [
      'openid',
      'offline_access',
      SPLIIT_SCOPES.groupsRead,
      SPLIIT_SCOPES.groupsManage,
      SPLIIT_SCOPES.expensesManage,
    ].join(' ')
    const response = await app.request('/auth/oauth2/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Spliit OAuth explicit-scope test',
        redirect_uris: ['http://localhost:3002/oauth/callback'],
        token_endpoint_auth_method: 'none',
        scope: requestedScope,
      }),
    })
    expect(response.status).toBe(201)

    const body = (await response.json()) as { client_id: string; scope: string }
    if (body.client_id) clientIds.push(body.client_id)

    expect(new Set(body.scope.split(' '))).toEqual(
      new Set(requestedScope.split(' ')),
    )
  })

  it('allows browser-based public clients to preflight registration', async () => {
    const inspectorOrigin = 'https://inspector.example'
    const response = await app.request('/auth/oauth2/register', {
      method: 'OPTIONS',
      headers: {
        origin: inspectorOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(
      inspectorOrigin,
    )
    expect(response.headers.get('access-control-allow-methods')).toContain(
      'POST',
    )
  })
})
