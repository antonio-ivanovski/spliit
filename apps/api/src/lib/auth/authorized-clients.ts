import { prisma } from '@spliit/db'

import { createOAuthRevocationBarrier } from './oauth-revocation-barrier'

export type AuthorizedClient = {
  consentId: string
  clientId: string
  name: string | null
  icon: string | null
  scopes: string[]
  authorizedAt: Date | null
  /**
   * Latest refresh token expiry still standing. Null means either no active
   * refresh token remains or at least one active token has no expiry.
   */
  activeUntil: Date | null
}

/**
 * OAuth clients an account has authorized, newest first.
 *
 * Consent is the durable record of "this account let this client in", so it
 * drives the list. Refresh token expiry is surfaced alongside it because that
 * is what actually decides how long the client keeps working.
 */
export async function listAuthorizedClients(
  accountId: string,
): Promise<AuthorizedClient[]> {
  const consents = await prisma.oauthConsent.findMany({
    where: { userId: accountId },
    include: { oauthClient: { select: { name: true, icon: true } } },
    orderBy: { createdAt: 'desc' },
  })
  if (consents.length === 0) return []

  const now = new Date()
  const refreshTokens = await prisma.oauthRefreshToken.findMany({
    where: {
      userId: accountId,
      clientId: { in: consents.map((consent) => consent.clientId) },
      revoked: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    select: { clientId: true, expiresAt: true },
  })

  const activeUntil = new Map<string, Date | null>()
  for (const token of refreshTokens) {
    // Keep this defensive check as well as the database filter so an expiry at
    // the query boundary can never be presented as active.
    if (token.expiresAt && token.expiresAt <= now) continue
    if (!activeUntil.has(token.clientId)) {
      activeUntil.set(token.clientId, token.expiresAt)
      continue
    }
    const current = activeUntil.get(token.clientId)
    // A null expiry is unbounded and therefore wins over every dated token.
    if (current === null) continue
    if (token.expiresAt === null || token.expiresAt > current!) {
      activeUntil.set(token.clientId, token.expiresAt)
    }
  }

  return consents.map((consent) => ({
    consentId: consent.id,
    clientId: consent.clientId,
    name: consent.oauthClient?.name ?? null,
    icon: consent.oauthClient?.icon ?? null,
    scopes: consent.scopes,
    authorizedAt: consent.createdAt,
    activeUntil: activeUntil.get(consent.clientId) ?? null,
  }))
}

export type RevokeResult = {
  refreshTokensRevoked: number
  accessTokensDeleted: number
  authorizationCodesDeleted: number
}

function authorizationCodeBelongsTo(
  value: string,
  accountId: string,
  clientId: string,
): boolean {
  try {
    const parsed = JSON.parse(value) as {
      type?: unknown
      userId?: unknown
      query?: { client_id?: unknown }
    }
    return (
      parsed.type === 'authorization_code' &&
      parsed.userId === accountId &&
      parsed.query?.client_id === clientId
    )
  } catch {
    return false
  }
}

/**
 * Withdraw an account's authorization for one OAuth client.
 *
 * Deleting the consent row is not enough on its own: the plugin's own
 * `delete-consent` endpoint stops there, which leaves a client refreshing
 * happily for the remaining lifetime of its refresh token. Revoking the refresh
 * tokens is what actually ends access. Pending authorization codes must also be
 * removed: otherwise a code issued just before revocation could be exchanged
 * afterwards and create a fresh refresh-token family. A durable revocation
 * barrier closes the remaining race where code creation or token rotation
 * started before cleanup but writes its result afterwards. Cleanup records go
 * together in a transaction after that barrier has committed.
 *
 * Access tokens are JWTs verified against the JWKS rather than looked up, so a
 * token already in flight stays valid until it expires. That window is one
 * hour, and callers should say so rather than promise instant cutoff.
 */
export async function revokeAuthorizedClient({
  accountId,
  consentId,
}: {
  accountId: string
  consentId: string
}): Promise<RevokeResult | null> {
  const consent = await prisma.oauthConsent.findUnique({
    where: { id: consentId },
    select: { id: true, userId: true, clientId: true },
  })
  // Same shape for "missing" and "someone else's" so the caller cannot probe
  // for consent ids belonging to other accounts.
  if (!consent || consent.userId !== accountId) return null

  const revokedAt = new Date()
  // Commit the barrier first. If it shared the cleanup transaction, a token
  // request could run after the sweep but before commit, observe neither the
  // barrier nor the cleanup, and leave a newly-issued family behind. A failed
  // second transaction intentionally leaves this fail-closed barrier standing
  // so retrying the revocation is safe.
  await prisma.$transaction(async (tx) => {
    await createOAuthRevocationBarrier(
      tx,
      accountId,
      consent.clientId,
      revokedAt,
    )
  })

  return prisma.$transaction(async (tx) => {
    // Better Auth does not enforce uniqueness for (userId, clientId). Remove
    // every duplicate so none can silently authorize the client afterwards.
    await tx.oauthConsent.deleteMany({
      where: { userId: accountId, clientId: consent.clientId },
    })

    const pendingCodes = await tx.verification.findMany({
      where: {
        expiresAt: { gt: revokedAt },
        AND: [
          { value: { contains: '"type":"authorization_code"' } },
          { value: { contains: JSON.stringify(accountId) } },
          { value: { contains: JSON.stringify(consent.clientId) } },
        ],
      },
      select: { id: true, value: true },
    })
    const authorizationCodeIds = pendingCodes
      .filter((code) =>
        authorizationCodeBelongsTo(code.value, accountId, consent.clientId),
      )
      .map((code) => code.id)
    const authorizationCodes = authorizationCodeIds.length
      ? await tx.verification.deleteMany({
          where: { id: { in: authorizationCodeIds } },
        })
      : { count: 0 }
    const refreshed = await tx.oauthRefreshToken.updateMany({
      where: {
        userId: accountId,
        clientId: consent.clientId,
        revoked: null,
      },
      data: { revoked: revokedAt },
    })
    await tx.oauthRefreshToken.updateMany({
      where: {
        userId: accountId,
        clientId: consent.clientId,
        rotationReplayResponse: { not: null },
      },
      data: {
        rotationReplayResponse: null,
        rotationReplayExpiresAt: null,
      },
    })
    const access = await tx.oauthAccessToken.deleteMany({
      where: { userId: accountId, clientId: consent.clientId },
    })
    return {
      refreshTokensRevoked: refreshed.count,
      accessTokensDeleted: access.count,
      authorizationCodesDeleted: authorizationCodes.count,
    }
  })
}
