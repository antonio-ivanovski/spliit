// organize-imports-ignore: ../../test/mocks must be imported before the module
// under test so @spliit/db is replaced with the shared Prisma mock.
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import '../../test/mocks'
import { prismaMock } from '../../test/state'
import { bindLegacyRefreshTokenResource } from './oauth-refresh-compat'
import { getApiBaseUrl } from './urls'

const RAW_REFRESH_TOKEN = 'legacy-refresh-token'
const STORED_REFRESH_TOKEN = createHash('sha256')
  .update(RAW_REFRESH_TOKEN)
  .digest('base64url')

function legacyToken(overrides: Record<string, unknown> = {}) {
  return {
    id: 'legacy-token-id',
    clientId: 'legacy-client',
    userId: 'legacy-account',
    resources: [],
    expiresAt: new Date(Date.now() + 60_000),
    revoked: null,
    oauthClient: { disabled: false, tokenEndpointAuthMethod: 'none' },
    ...overrides,
  }
}

describe('bindLegacyRefreshTokenResource', () => {
  it('binds an old empty token and consent to the API when resource is omitted', async () => {
    prismaMock.oauthRefreshToken.findUnique.mockResolvedValue(
      legacyToken() as never,
    )
    prismaMock.oauthRefreshToken.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.oauthConsent.updateMany.mockResolvedValue({ count: 1 })

    await bindLegacyRefreshTokenResource({
      grant_type: 'refresh_token',
      client_id: 'legacy-client',
      refresh_token: RAW_REFRESH_TOKEN,
    })

    expect(prismaMock.oauthRefreshToken.findUnique).toHaveBeenCalledWith({
      where: { token: STORED_REFRESH_TOKEN },
      select: expect.any(Object),
    })
    expect(prismaMock.oauthRefreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { resources: [getApiBaseUrl()] } }),
    )
    expect(prismaMock.oauthConsent.updateMany).toHaveBeenCalledWith({
      where: {
        clientId: 'legacy-client',
        userId: 'legacy-account',
        resources: { isEmpty: true },
      },
      data: { resources: [getApiBaseUrl()] },
    })
  })

  it('retains an explicitly requested configured resource', async () => {
    const resource = getApiBaseUrl()
    prismaMock.oauthRefreshToken.findUnique.mockResolvedValue(
      legacyToken() as never,
    )
    prismaMock.oauthRefreshToken.updateMany.mockResolvedValue({ count: 1 })

    await bindLegacyRefreshTokenResource({
      grant_type: 'refresh_token',
      client_id: 'legacy-client',
      refresh_token: RAW_REFRESH_TOKEN,
      resource,
    })

    expect(prismaMock.oauthRefreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { resources: [resource] } }),
    )
  })

  it('does not bind an unknown resource', async () => {
    await bindLegacyRefreshTokenResource({
      grant_type: 'refresh_token',
      client_id: 'legacy-client',
      refresh_token: RAW_REFRESH_TOKEN,
      resource: 'https://evil.example/resource',
    })

    expect(prismaMock.oauthRefreshToken.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.oauthRefreshToken.updateMany).not.toHaveBeenCalled()
  })

  it('does not bind repeated resource indicators from a legacy request', async () => {
    await bindLegacyRefreshTokenResource({
      grant_type: 'refresh_token',
      client_id: 'legacy-client',
      refresh_token: RAW_REFRESH_TOKEN,
      resource: [getApiBaseUrl(), getApiBaseUrl()],
    })

    expect(prismaMock.oauthRefreshToken.findUnique).not.toHaveBeenCalled()
  })

  it.each([
    ['another client', { clientId: 'other-client' }],
    ['a token already bound by 1.7', { resources: [getApiBaseUrl()] }],
    ['a revoked token', { revoked: new Date() }],
    ['an expired token', { expiresAt: new Date(0) }],
    [
      'a confidential client',
      {
        oauthClient: {
          disabled: false,
          tokenEndpointAuthMethod: 'client_secret_basic',
        },
      },
    ],
    [
      'a disabled client',
      {
        oauthClient: { disabled: true, tokenEndpointAuthMethod: 'none' },
      },
    ],
  ])('leaves %s unchanged', async (_label, overrides) => {
    prismaMock.oauthRefreshToken.findUnique.mockResolvedValue(
      legacyToken(overrides) as never,
    )

    await bindLegacyRefreshTokenResource({
      grant_type: 'refresh_token',
      client_id: 'legacy-client',
      refresh_token: RAW_REFRESH_TOKEN,
    })

    expect(prismaMock.oauthRefreshToken.updateMany).not.toHaveBeenCalled()
  })
})
