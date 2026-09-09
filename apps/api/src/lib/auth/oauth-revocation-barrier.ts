import { createHash, randomUUID } from 'node:crypto'

import { APIError } from 'better-auth/api'

import { prisma, type Prisma } from '@spliit/db'

const REVOCATION_BARRIER_PREFIX = 'spliit:oauth-revocation:'
const REVOCATION_BARRIER_EXPIRY = new Date('9999-12-31T23:59:59.999Z')

type GrantSnapshot = {
  accountId: string
  authorizationCodeId: string | null
  clientId: string
  issuedAt: Date
  kind: 'authorization_code' | 'refresh_token'
}

const pendingTokenExchanges = new WeakMap<Request, GrantSnapshot>()
const pendingConsentApprovals = new WeakMap<Request, Date>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function storedToken(rawToken: string): string {
  // Spliit uses Better Auth's default hashed token storage and does not add a
  // token prefix. Authorization codes and refresh tokens therefore use the
  // same unpadded base64url SHA-256 representation in the database.
  return createHash('sha256').update(rawToken).digest('base64url')
}

export function oauthRevocationBarrierIdentifier(
  accountId: string,
  clientId: string,
): string {
  const subject = createHash('sha256')
    .update(accountId)
    .update('\0')
    .update(clientId)
    .digest('base64url')
  return `${REVOCATION_BARRIER_PREFIX}${subject}`
}

function parseAuthorizationCode(value: string): {
  accountId: string
  clientId: string
} | null {
  try {
    const parsed = JSON.parse(value) as {
      type?: unknown
      userId?: unknown
      query?: { client_id?: unknown }
    }
    if (
      parsed.type !== 'authorization_code' ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.query?.client_id !== 'string'
    ) {
      return null
    }
    return { accountId: parsed.userId, clientId: parsed.query.client_id }
  } catch {
    return null
  }
}

async function findAuthorizationCodeSnapshot(
  body: Record<string, unknown>,
): Promise<GrantSnapshot | null> {
  if (typeof body.code !== 'string') return null

  const authorizationCodeId = storedToken(body.code)
  const code = await prisma.verification.findFirst({
    where: {
      identifier: authorizationCodeId,
      expiresAt: { gt: new Date() },
    },
    select: { createdAt: true, value: true },
  })
  if (!code) return null

  const owner = parseAuthorizationCode(code.value)
  if (!owner) return null

  return {
    ...owner,
    authorizationCodeId,
    issuedAt: code.createdAt,
    kind: 'authorization_code',
  }
}

async function findRefreshTokenSnapshot(
  body: Record<string, unknown>,
): Promise<GrantSnapshot | null> {
  if (typeof body.refresh_token !== 'string') return null

  const token = await prisma.oauthRefreshToken.findUnique({
    where: { token: storedToken(body.refresh_token) },
    select: {
      authorizationCodeId: true,
      clientId: true,
      createdAt: true,
      userId: true,
    },
  })
  if (!token) return null

  return {
    accountId: token.userId,
    authorizationCodeId: token.authorizationCodeId,
    clientId: token.clientId,
    issuedAt: token.createdAt ?? new Date(0),
    kind: 'refresh_token',
  }
}

async function findGrantSnapshot(body: unknown): Promise<GrantSnapshot | null> {
  if (!isRecord(body)) return null
  if (body.grant_type === 'authorization_code') {
    return findAuthorizationCodeSnapshot(body)
  }
  if (body.grant_type === 'refresh_token') {
    return findRefreshTokenSnapshot(body)
  }
  return null
}

async function grantWasRevoked(snapshot: GrantSnapshot): Promise<boolean> {
  const [barrier, consent] = await Promise.all([
    prisma.verification.findFirst({
      where: {
        identifier: oauthRevocationBarrierIdentifier(
          snapshot.accountId,
          snapshot.clientId,
        ),
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
    prisma.oauthConsent.findFirst({
      where: { userId: snapshot.accountId, clientId: snapshot.clientId },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ])

  // A standing barrier is fail-closed until a successful, explicit consent
  // re-arms the pair. This also rejects a code created late by an authorize
  // request that read the old consent just before it was deleted.
  if (barrier) return true

  // A newer consent denotes an explicit reauthorization. It must never revive
  // an authorization code or refresh-token family from the previous grant.
  return Boolean(consent?.createdAt && snapshot.issuedAt < consent.createdAt)
}

async function quarantineGrant(snapshot: GrantSnapshot): Promise<void> {
  const familyWhere = snapshot.authorizationCodeId
    ? { authorizationCodeId: snapshot.authorizationCodeId }
    : snapshot.kind === 'refresh_token'
      ? { authorizationCodeId: null }
      : null
  if (!familyWhere) return

  const now = new Date()
  await prisma.$transaction(async (tx) => {
    await tx.oauthAccessToken.deleteMany({
      where: {
        userId: snapshot.accountId,
        clientId: snapshot.clientId,
        ...familyWhere,
      },
    })
    await tx.oauthRefreshToken.updateMany({
      where: {
        userId: snapshot.accountId,
        clientId: snapshot.clientId,
        ...familyWhere,
      },
      data: {
        revoked: now,
        rotationReplayResponse: null,
        rotationReplayExpiresAt: null,
      },
    })
  })
}

function invalidGrantResponse(): Response {
  return Response.json(
    {
      error: 'invalid_grant',
      error_description: 'The authorization grant is no longer valid.',
    },
    {
      status: 400,
      headers: {
        'Cache-Control': 'no-store',
        Pragma: 'no-cache',
      },
    },
  )
}

/**
 * Capture and validate the grant before Better Auth consumes or rotates it.
 *
 * The matching after-hook validates the same snapshot again. Together those
 * checks close the useful race window: token issuance either linearizes before
 * revocation (and is swept by it), or observes the barrier afterwards and its
 * response is replaced after the newly-created token rows are quarantined.
 */
export async function prepareOAuthTokenExchange(
  request: Request | undefined,
  body: unknown,
): Promise<void> {
  if (!request) return
  const snapshot = await findGrantSnapshot(body)
  if (!snapshot) return
  pendingTokenExchanges.set(request, snapshot)

  if (!(await grantWasRevoked(snapshot))) return

  if (snapshot.kind === 'authorization_code') {
    await prisma.verification.deleteMany({
      where: { identifier: snapshot.authorizationCodeId! },
    })
  } else {
    await quarantineGrant(snapshot)
  }
  throw new APIError('BAD_REQUEST', {
    error: 'invalid_grant',
    error_description: 'The authorization grant is no longer valid.',
  })
}

/** Recheck a token exchange after Better Auth has created its token rows. */
export async function finalizeOAuthTokenExchange(
  request: Request | undefined,
): Promise<Response | null> {
  if (!request) return null
  const snapshot = pendingTokenExchanges.get(request)
  pendingTokenExchanges.delete(request)
  if (!snapshot || !(await grantWasRevoked(snapshot))) return null

  await quarantineGrant(snapshot)
  return invalidGrantResponse()
}

/** Capture the start boundary so a later concurrent revocation always wins. */
export function prepareOAuthConsent(request: Request | undefined): void {
  if (request) pendingConsentApprovals.set(request, new Date())
}

/** Install the durable barrier at the linearization point of revocation. */
export async function createOAuthRevocationBarrier(
  tx: Prisma.TransactionClient,
  accountId: string,
  clientId: string,
  revokedAt: Date,
): Promise<void> {
  const identifier = oauthRevocationBarrierIdentifier(accountId, clientId)
  await tx.verification.deleteMany({ where: { identifier } })
  await tx.verification.create({
    data: {
      id: randomUUID(),
      identifier,
      value: JSON.stringify({ type: 'spliit_oauth_revocation' }),
      createdAt: revokedAt,
      updatedAt: revokedAt,
      expiresAt: REVOCATION_BARRIER_EXPIRY,
    },
  })
}

function returnedCallbackUrl(returned: unknown): string | null {
  if (!isRecord(returned)) return null
  const body = isRecord(returned.body) ? returned.body : returned
  if (typeof body.url === 'string') return body.url
  if (typeof body.redirect_uri === 'string') return body.redirect_uri
  return null
}

/**
 * Rearm a client only after Better Auth persisted consent and issued its code.
 * Barriers newer than the start of that explicit approval are retained, so a
 * concurrent second revocation always wins.
 */
export async function rearmOAuthClientAfterConsent(
  request: Request | undefined,
  returned: unknown,
): Promise<void> {
  if (!request) return
  const consentStartedAt = pendingConsentApprovals.get(request)
  pendingConsentApprovals.delete(request)
  if (!consentStartedAt) return

  let value = returned
  if (value instanceof Response) {
    if (!value.ok) return
    try {
      value = await value.clone().json()
    } catch {
      return
    }
  }

  const callbackUrl = returnedCallbackUrl(value)
  if (!callbackUrl) return
  let rawCode: string | null
  try {
    rawCode = new URL(callbackUrl, 'http://localhost').searchParams.get('code')
  } catch {
    return
  }
  if (!rawCode) return

  const identifier = storedToken(rawCode)
  const code = await prisma.verification.findFirst({
    where: { identifier, expiresAt: { gt: new Date() } },
    select: { value: true },
  })
  if (!code) return
  const owner = parseAuthorizationCode(code.value)
  if (!owner) return

  await prisma.verification.deleteMany({
    where: {
      identifier: oauthRevocationBarrierIdentifier(
        owner.accountId,
        owner.clientId,
      ),
      // Never clear a barrier installed after this explicit approval began.
      createdAt: { lte: consentStartedAt },
    },
  })
}
