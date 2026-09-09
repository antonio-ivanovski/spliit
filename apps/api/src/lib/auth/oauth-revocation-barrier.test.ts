// organize-imports-ignore: ../../test/mocks must be imported before the module
// under test so @spliit/db is replaced with the shared Prisma mock.
import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import '../../test/mocks'
import { prismaMock } from '../../test/state'
import {
  finalizeOAuthTokenExchange,
  oauthRevocationBarrierIdentifier,
  prepareOAuthConsent,
  prepareOAuthTokenExchange,
  rearmOAuthClientAfterConsent,
} from './oauth-revocation-barrier'

const RAW_CODE = 'authorization-code'
const STORED_CODE = createHash('sha256').update(RAW_CODE).digest('base64url')
const RAW_REFRESH_TOKEN = 'refresh-token'

const issuedAt = new Date('2026-08-24T10:00:00.000Z')
const revokedAt = new Date('2026-08-24T10:01:00.000Z')

function authorizationCodeRow(createdAt = issuedAt) {
  return {
    createdAt,
    value: JSON.stringify({
      type: 'authorization_code',
      userId: 'acct-1',
      query: { client_id: 'client-1' },
    }),
  }
}

function tokenBody() {
  return {
    grant_type: 'authorization_code',
    client_id: 'client-1',
    code: RAW_CODE,
  }
}

describe('OAuth revocation barrier', () => {
  it('rejects and consumes a pending code after revocation', async () => {
    prismaMock.verification.findFirst
      .mockResolvedValueOnce(authorizationCodeRow() as never)
      .mockResolvedValueOnce({ createdAt: revokedAt } as never)
    prismaMock.oauthConsent.findFirst.mockResolvedValue(null)
    const request = new Request('http://localhost/auth/oauth2/token', {
      method: 'POST',
    })

    await expect(
      prepareOAuthTokenExchange(request, tokenBody()),
    ).rejects.toMatchObject({
      body: { error: 'invalid_grant' },
    })
    expect(prismaMock.verification.deleteMany).toHaveBeenCalledWith({
      where: { identifier: STORED_CODE },
    })
  })

  it('quarantines tokens when revocation commits during a code exchange', async () => {
    prismaMock.verification.findFirst
      .mockResolvedValueOnce(authorizationCodeRow() as never)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ createdAt: revokedAt } as never)
    prismaMock.oauthConsent.findFirst
      .mockResolvedValueOnce({ createdAt: issuedAt } as never)
      .mockResolvedValueOnce(null)
    prismaMock.oauthAccessToken.deleteMany.mockResolvedValue({ count: 1 })
    prismaMock.oauthRefreshToken.updateMany.mockResolvedValue({ count: 1 })
    const request = new Request('http://localhost/auth/oauth2/token', {
      method: 'POST',
    })

    await prepareOAuthTokenExchange(request, tokenBody())
    const response = await finalizeOAuthTokenExchange(request)

    expect(response?.status).toBe(400)
    await expect(response?.json()).resolves.toMatchObject({
      error: 'invalid_grant',
    })
    expect(prismaMock.oauthAccessToken.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: 'acct-1',
        clientId: 'client-1',
        authorizationCodeId: STORED_CODE,
      },
    })
    expect(prismaMock.oauthRefreshToken.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'acct-1',
        clientId: 'client-1',
        authorizationCodeId: STORED_CODE,
      },
      data: {
        revoked: expect.any(Date),
        rotationReplayResponse: null,
        rotationReplayExpiresAt: null,
      },
    })
  })

  it('also closes a refresh-token rotation racing revocation', async () => {
    const storedRefresh = createHash('sha256')
      .update(RAW_REFRESH_TOKEN)
      .digest('base64url')
    prismaMock.oauthRefreshToken.findUnique.mockResolvedValue({
      id: 'refresh-1',
      authorizationCodeId: 'family-code-id',
      clientId: 'client-1',
      createdAt: issuedAt,
      userId: 'acct-1',
    } as never)
    prismaMock.verification.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ createdAt: revokedAt } as never)
    prismaMock.oauthConsent.findFirst
      .mockResolvedValueOnce({ createdAt: issuedAt } as never)
      .mockResolvedValueOnce(null)
    prismaMock.oauthAccessToken.deleteMany.mockResolvedValue({ count: 1 })
    prismaMock.oauthRefreshToken.updateMany.mockResolvedValue({ count: 2 })
    const request = new Request('http://localhost/auth/oauth2/token', {
      method: 'POST',
    })

    await prepareOAuthTokenExchange(request, {
      grant_type: 'refresh_token',
      client_id: 'client-1',
      refresh_token: RAW_REFRESH_TOKEN,
    })
    const response = await finalizeOAuthTokenExchange(request)

    expect(prismaMock.oauthRefreshToken.findUnique).toHaveBeenCalledWith({
      where: { token: storedRefresh },
      select: expect.any(Object),
    })
    expect(response?.status).toBe(400)
    expect(prismaMock.oauthRefreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          authorizationCodeId: 'family-code-id',
        }),
      }),
    )
  })

  it('rearms only after a successful consent code, without clearing a newer barrier', async () => {
    const newCode = 'new-authorization-code'
    const newCodeId = createHash('sha256').update(newCode).digest('base64url')
    const consentStartedAt = new Date('2026-08-24T10:01:30.000Z')
    const reauthorizedAt = new Date('2026-08-24T10:02:00.000Z')
    const request = new Request('http://localhost/auth/oauth2/consent', {
      method: 'POST',
    })
    prismaMock.verification.findFirst.mockResolvedValue(
      authorizationCodeRow(reauthorizedAt) as never,
    )

    vi.useFakeTimers()
    try {
      vi.setSystemTime(consentStartedAt)
      prepareOAuthConsent(request)
      vi.setSystemTime(reauthorizedAt)
      await rearmOAuthClientAfterConsent(request, {
        url: `https://client.example/callback?code=${newCode}`,
      })
    } finally {
      vi.useRealTimers()
    }

    expect(prismaMock.verification.findFirst).toHaveBeenCalledWith({
      where: {
        identifier: newCodeId,
        expiresAt: { gt: expect.any(Date) },
      },
      select: { value: true },
    })
    expect(prismaMock.verification.deleteMany).toHaveBeenCalledWith({
      where: {
        identifier: oauthRevocationBarrierIdentifier('acct-1', 'client-1'),
        createdAt: { lte: consentStartedAt },
      },
    })
  })

  it('does not rearm after a denied or malformed consent response', async () => {
    const request = new Request('http://localhost/auth/oauth2/consent', {
      method: 'POST',
    })
    prepareOAuthConsent(request)
    await rearmOAuthClientAfterConsent(request, {
      url: 'https://client.example/callback?error=access_denied',
    })

    expect(prismaMock.verification.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.verification.deleteMany).not.toHaveBeenCalled()
  })
})
