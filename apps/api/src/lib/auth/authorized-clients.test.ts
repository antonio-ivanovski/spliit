import { describe, expect, it } from 'vitest'

import '../../test/mocks'
import { prisma$Transaction, prismaMock } from '../../test/state'
import {
  listAuthorizedClients,
  revokeAuthorizedClient,
} from './authorized-clients'

describe('listAuthorizedClients', () => {
  it('returns an empty list without querying tokens', async () => {
    prismaMock.oauthConsent.findMany.mockResolvedValue([] as never)

    const clients = await listAuthorizedClients('acct-1')

    expect(clients).toEqual([])
    expect(prismaMock.oauthRefreshToken.findMany).not.toHaveBeenCalled()
  })

  it('reports the furthest standing refresh expiry per client', async () => {
    const soon = new Date(Date.now() + 60_000)
    const later = new Date(Date.now() + 120_000)
    prismaMock.oauthConsent.findMany.mockResolvedValue([
      {
        id: 'consent-1',
        clientId: 'client-1',
        scopes: ['spliit:groups:read'],
        createdAt: new Date('2026-08-01T00:00:00Z'),
        oauthClient: { name: 'Agent', icon: null },
      },
    ] as never)
    prismaMock.oauthRefreshToken.findMany.mockResolvedValue([
      { clientId: 'client-1', expiresAt: soon },
      { clientId: 'client-1', expiresAt: later },
    ] as never)

    const [client] = await listAuthorizedClients('acct-1')

    expect(client).toMatchObject({
      consentId: 'consent-1',
      name: 'Agent',
      activeUntil: later,
    })
  })

  it('only counts refresh tokens that are not revoked', async () => {
    prismaMock.oauthConsent.findMany.mockResolvedValue([
      {
        id: 'consent-1',
        clientId: 'client-1',
        scopes: [],
        createdAt: null,
        oauthClient: { name: null, icon: null },
      },
    ] as never)
    prismaMock.oauthRefreshToken.findMany.mockResolvedValue([] as never)

    const [client] = await listAuthorizedClients('acct-1')

    expect(client!.activeUntil).toBeNull()
    expect(prismaMock.oauthRefreshToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          revoked: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        }),
      }),
    )
  })

  it('ignores expired refresh tokens at the query boundary', async () => {
    prismaMock.oauthConsent.findMany.mockResolvedValue([
      {
        id: 'consent-1',
        clientId: 'client-1',
        scopes: [],
        createdAt: null,
        oauthClient: { name: null, icon: null },
      },
    ] as never)
    prismaMock.oauthRefreshToken.findMany.mockResolvedValue([
      { clientId: 'client-1', expiresAt: new Date(Date.now() - 60_000) },
    ] as never)

    const [client] = await listAuthorizedClients('acct-1')

    expect(client!.activeUntil).toBeNull()
  })

  it('treats a non-expiring standing refresh token as unbounded', async () => {
    prismaMock.oauthConsent.findMany.mockResolvedValue([
      {
        id: 'consent-1',
        clientId: 'client-1',
        scopes: [],
        createdAt: null,
        oauthClient: { name: null, icon: null },
      },
    ] as never)
    prismaMock.oauthRefreshToken.findMany.mockResolvedValue([
      { clientId: 'client-1', expiresAt: null },
      { clientId: 'client-1', expiresAt: new Date(Date.now() + 60_000) },
    ] as never)

    const [client] = await listAuthorizedClients('acct-1')

    expect(client!.activeUntil).toBeNull()
  })
})

describe('revokeAuthorizedClient', () => {
  it('refuses a consent belonging to another account', async () => {
    prismaMock.oauthConsent.findUnique.mockResolvedValue({
      id: 'consent-1',
      userId: 'someone-else',
      clientId: 'client-1',
    } as never)

    const result = await revokeAuthorizedClient({
      accountId: 'acct-1',
      consentId: 'consent-1',
    })

    expect(result).toBeNull()
    expect(prismaMock.oauthConsent.deleteMany).not.toHaveBeenCalled()
  })

  it('returns null for an unknown consent', async () => {
    prismaMock.oauthConsent.findUnique.mockResolvedValue(null as never)

    await expect(
      revokeAuthorizedClient({ accountId: 'acct-1', consentId: 'nope' }),
    ).resolves.toBeNull()
  })

  it('commits the fail-closed barrier before starting cleanup', async () => {
    prismaMock.oauthConsent.findUnique.mockResolvedValue({
      id: 'consent-1',
      userId: 'acct-1',
      clientId: 'client-1',
    } as never)
    prisma$Transaction
      .mockImplementationOnce(async (input: unknown) =>
        (input as (tx: unknown) => unknown)(prismaMock),
      )
      .mockRejectedValueOnce(new Error('cleanup failed'))

    await expect(
      revokeAuthorizedClient({
        accountId: 'acct-1',
        consentId: 'consent-1',
      }),
    ).rejects.toThrow('cleanup failed')

    expect(prismaMock.verification.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.oauthConsent.deleteMany).not.toHaveBeenCalled()
  })

  it('revokes refresh tokens rather than only dropping the consent', async () => {
    prismaMock.oauthConsent.findUnique.mockResolvedValue({
      id: 'consent-1',
      userId: 'acct-1',
      clientId: 'client-1',
    } as never)
    prismaMock.oauthRefreshToken.updateMany.mockResolvedValue({
      count: 2,
    } as never)
    prismaMock.verification.findMany.mockResolvedValue([
      {
        id: 'matching-code',
        value: JSON.stringify({
          type: 'authorization_code',
          userId: 'acct-1',
          query: { client_id: 'client-1' },
        }),
      },
      {
        id: 'another-client-code',
        value: JSON.stringify({
          type: 'authorization_code',
          userId: 'acct-1',
          query: { client_id: 'client-2' },
        }),
      },
      { id: 'malformed-code', value: '{' },
    ] as never)
    prismaMock.verification.deleteMany.mockResolvedValue({ count: 1 })
    prismaMock.oauthAccessToken.deleteMany.mockResolvedValue({
      count: 1,
    } as never)
    prismaMock.oauthConsent.deleteMany.mockResolvedValue({ count: 2 })

    const result = await revokeAuthorizedClient({
      accountId: 'acct-1',
      consentId: 'consent-1',
    })

    expect(result).toEqual({
      refreshTokensRevoked: 2,
      accessTokensDeleted: 1,
      authorizationCodesDeleted: 1,
    })
    expect(prismaMock.verification.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['matching-code'] } },
    })
    expect(prismaMock.verification.findMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { gt: expect.any(Date) },
        AND: [
          { value: { contains: '"type":"authorization_code"' } },
          { value: { contains: '"acct-1"' } },
          { value: { contains: '"client-1"' } },
        ],
      },
      select: { id: true, value: true },
    })
    expect(prismaMock.verification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        id: expect.any(String),
        identifier: expect.stringMatching(/^spliit:oauth-revocation:/),
        value: JSON.stringify({ type: 'spliit_oauth_revocation' }),
      }),
    })
    expect(prismaMock.oauthRefreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'acct-1',
          clientId: 'client-1',
          revoked: null,
        }),
      }),
    )
    expect(prismaMock.oauthConsent.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'acct-1', clientId: 'client-1' },
    })
    expect(prisma$Transaction).toHaveBeenCalledTimes(2)
    expect(
      prismaMock.verification.create.mock.invocationCallOrder[0],
    ).toBeLessThan(
      prismaMock.oauthConsent.deleteMany.mock.invocationCallOrder[0]!,
    )
  })

  it('skips the authorization-code delete when no pending code matches', async () => {
    prismaMock.oauthConsent.findUnique.mockResolvedValue({
      id: 'consent-1',
      userId: 'acct-1',
      clientId: 'client-1',
    } as never)
    prismaMock.verification.findMany.mockResolvedValue([])
    prismaMock.oauthRefreshToken.updateMany.mockResolvedValue({ count: 0 })
    prismaMock.oauthAccessToken.deleteMany.mockResolvedValue({ count: 0 })
    prismaMock.oauthConsent.deleteMany.mockResolvedValue({ count: 1 })

    await expect(
      revokeAuthorizedClient({
        accountId: 'acct-1',
        consentId: 'consent-1',
      }),
    ).resolves.toMatchObject({ authorizationCodesDeleted: 0 })
    expect(prismaMock.verification.deleteMany).not.toHaveBeenCalledWith({
      where: { id: { in: expect.any(Array) } },
    })
  })
})
