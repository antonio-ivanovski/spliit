import { createHash } from 'node:crypto'

import { prisma } from '@spliit/db'

import { getApiBaseUrl, oauthAudiences } from './urls'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requestedResources(resource: unknown): string[] | null {
  if (resource == null) return [getApiBaseUrl()]
  const values = Array.isArray(resource) ? resource : [resource]
  if (
    values.length !== 1 ||
    values.some((value) => typeof value !== 'string' || value.length === 0)
  ) {
    return null
  }

  const resources = [...new Set(values as string[])]
  const allowed = new Set(oauthAudiences())
  return resources.every((value) => allowed.has(value)) ? resources : null
}

function storedRefreshToken(rawToken: string): string {
  // Better Auth's default `storeTokens: "hashed"` representation is an
  // unpadded base64url SHA-256 digest. Spliit does not override token storage
  // or add a refresh-token prefix, so this resolves both 1.6 and 1.7 tokens.
  return createHash('sha256').update(rawToken).digest('base64url')
}

/**
 * Bind a pre-1.7 refresh-token family to its first post-upgrade resource.
 *
 * Better Auth 1.7 added `resources` columns with an empty-array migration
 * default. Without this compatibility bridge, every existing refresh token
 * either mints an unusable opaque token (resource omitted) or fails with
 * `invalid_target` (resource supplied). The old provider already allowed any
 * server-configured audience at refresh time, so accepting only a currently
 * configured audience here preserves — and does not widen — legacy authority.
 * New grants already carry resources and bypass this path.
 */
export async function bindLegacyRefreshTokenResource(
  body: unknown,
): Promise<void> {
  if (
    !isRecord(body) ||
    body.grant_type !== 'refresh_token' ||
    typeof body.refresh_token !== 'string' ||
    typeof body.client_id !== 'string'
  ) {
    return
  }

  const resources = requestedResources(body.resource)
  // Let Better Auth return its protocol-level validation error for malformed
  // or unknown resource indicators; never persist an unrecognised audience.
  if (!resources) return

  const now = new Date()
  const token = storedRefreshToken(body.refresh_token)
  const legacy = await prisma.oauthRefreshToken.findUnique({
    where: { token },
    select: {
      id: true,
      clientId: true,
      userId: true,
      resources: true,
      expiresAt: true,
      revoked: true,
      oauthClient: {
        select: { disabled: true, tokenEndpointAuthMethod: true },
      },
    },
  })
  if (
    !legacy ||
    legacy.clientId !== body.client_id ||
    legacy.resources.length !== 0 ||
    legacy.revoked !== null ||
    legacy.oauthClient.disabled === true ||
    legacy.oauthClient.tokenEndpointAuthMethod !== 'none' ||
    (legacy.expiresAt !== null && legacy.expiresAt <= now)
  ) {
    return
  }

  await prisma.$transaction(async (tx) => {
    const updated = await tx.oauthRefreshToken.updateMany({
      where: {
        id: legacy.id,
        token,
        clientId: legacy.clientId,
        resources: { isEmpty: true },
        revoked: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      data: { resources },
    })
    if (updated.count === 0) return

    // Preserve the same binding if this client starts another authorization
    // later. Only legacy empty consents are touched; 1.7 grants remain intact.
    await tx.oauthConsent.updateMany({
      where: {
        clientId: legacy.clientId,
        userId: legacy.userId,
        resources: { isEmpty: true },
      },
      data: { resources },
    })
  })
}
