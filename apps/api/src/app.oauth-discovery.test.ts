import { describe, expect, it } from 'vitest'

import './test/mocks'
import { app } from './app'
import {
  API_RESOURCE_DISCOVERY_SCOPES,
  ASSISTANT_WRITE_SCOPE,
  DESTRUCTIVE_SCOPES,
  OIDC_SCOPES,
  SPLIIT_SCOPES,
} from './lib/auth/scopes'
import { getApiBaseUrl } from './lib/auth/urls'

const emptyInput = encodeURIComponent(JSON.stringify({ json: {} }))
const metadataUrl = new URL(
  '/.well-known/oauth-protected-resource',
  getApiBaseUrl(),
).toString()

describe('OAuth protected resource discovery', () => {
  it('publishes RFC 9728 metadata for an unknown client', async () => {
    const response = await app.request('/.well-known/oauth-protected-resource')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.json()).toEqual({
      resource: getApiBaseUrl(),
      authorization_servers: [new URL('/auth', getApiBaseUrl()).toString()],
      scopes_supported: [...API_RESOURCE_DISCOVERY_SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: 'Spliit API',
      resource_documentation: new URL('/docs', getApiBaseUrl()).toString(),
    })
  })

  it('advertises only the basic read scopes, never identity, legacy or destructive ones', async () => {
    // Agent clients that get no `scope` hint fall back to requesting every
    // advertised value, so anything beyond the read scopes would push default
    // authorizations toward write/delete permissions or fail registration.
    const response = await app.request('/.well-known/oauth-protected-resource')
    const metadata = (await response.json()) as { scopes_supported: string[] }

    expect(metadata.scopes_supported).toEqual([
      SPLIIT_SCOPES.groupsRead,
      SPLIIT_SCOPES.expensesRead,
    ])
    for (const scope of OIDC_SCOPES) {
      expect(metadata.scopes_supported).not.toContain(scope)
    }
    expect(metadata.scopes_supported).not.toContain(ASSISTANT_WRITE_SCOPE)
    expect(metadata.scopes_supported).not.toContain(SPLIIT_SCOPES.groupsManage)
    expect(metadata.scopes_supported).not.toContain(
      SPLIIT_SCOPES.expensesManage,
    )
    for (const scope of DESTRUCTIVE_SCOPES) {
      expect(metadata.scopes_supported).not.toContain(scope)
    }
  })

  it('challenges an unknown caller with the operation scope and no error code', async () => {
    const response = await app.request(`/trpc/groups.list?input=${emptyInput}`)

    expect(response.status).toBe(401)
    // No credentials at all: the agent should start authorization with the
    // minimum scope this operation needs. `invalid_token` would wrongly
    // suggest refreshing an existing grant.
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer scope="spliit:groups:read", resource_metadata="${metadataUrl}"`,
    )
    expect(response.headers.get('access-control-expose-headers')).toContain(
      'WWW-Authenticate',
    )
  })

  it('unions the minimum scopes across a batched request', async () => {
    const response = await app.request(
      '/trpc/groups.update,groups.delete?batch=1',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ 0: { json: {} }, 1: { json: {} } }),
      },
    )

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer scope="spliit:groups:manage spliit:groups:delete", resource_metadata="${metadataUrl}"`,
    )
  })

  it('marks a rejected bearer token as invalid_token', async () => {
    const response = await app.request(
      `/trpc/groups.list?input=${emptyInput}`,
      {
        headers: { authorization: 'Bearer not-a-verifiable-token' },
      },
    )

    expect(response.status).toBe(401)
    const challenge = response.headers.get('www-authenticate')
    expect(challenge).toContain('error="invalid_token"')
    expect(challenge).toContain(`resource_metadata="${metadataUrl}"`)
    expect(response.headers.get('access-control-expose-headers')).toContain(
      'WWW-Authenticate',
    )
  })

  it('does not advertise OAuth for a session-only procedure', async () => {
    const response = await app.request(`/trpc/account.me?input=${emptyInput}`)

    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBeNull()
  })

  it('passes the tRPC error through for a malformed procedure path', async () => {
    // Hono forwards `/trpc/%` untouched and tRPC answers it with its own
    // error envelope. The scope lookup must not replace that response with a
    // URIError crash from this handler — the body must stay tRPC's JSON.
    const response = await app.request('/trpc/%')
    const body = (await response.json()) as {
      error?: { json?: { message?: string } }
    }

    expect(body.error?.json?.message).toBe('URI malformed')
    expect(response.headers.get('www-authenticate')).toBeNull()
  })
})
