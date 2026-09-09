import { initTRPC, TRPCError } from '@trpc/server'
import superjson from 'superjson'
import { z } from 'zod'

import {
  GroupInvitationStatus,
  GroupInvitationType,
  type GroupRole,
  prisma,
} from '@spliit/db'

import { isAnonymousSetupIncomplete } from '../lib/auth/account-cache'
import { hasScope, SPLIIT_SCOPES, type SpliitScope } from '../lib/auth/scopes'
import type { OAuthResolvedAuth, ResolvedAuth } from '../lib/auth/session'
import {
  getAuthFromRequest,
  getOAuthAuthFromRequest,
} from '../lib/auth/session'
import { getApiBaseUrl } from '../lib/auth/urls'
import { env } from '../lib/env'
import { groupViewKeysMatch } from '../lib/group-view'
import { hashLinkToken } from '../lib/invitations'
import { FixedWindowLimiter, logRateLimitExceeded } from '../lib/rate-limit'

export type AuthContext = {
  /** Authenticated account + better-auth session, or null. */
  auth: ResolvedAuth | OAuthResolvedAuth | null
  /** Outgoing fetch Request, when available (tRPC context only sees headers). */
  req?: Request
  /** Mutable response headers supplied by the fetch adapter. */
  resHeaders?: Headers
}

export async function createTRPCContext(opts: {
  req?: Request
  resHeaders?: Headers
}): Promise<AuthContext> {
  const request =
    opts.req ?? new Request('http://localhost', { headers: new Headers() })
  const auth =
    (await getAuthFromRequest(request).catch(() => null)) ??
    (await getOAuthAuthFromRequest(request).catch(() => null))
  return {
    auth,
    req: opts.req,
    resHeaders: opts.resHeaders,
  }
}

// Avoid exporting the entire t-object
// since it's not very descriptive.
// For instance, the use of a t variable
// is common in i18n libraries.
/**
 * Per-procedure metadata.
 *
 * `scope` records the OAuth scope a programmatic caller must hold. It is set by
 * `apiProcedure`, `scopedGroupReadProcedure` and `assistantProcedure` rather
 * than maintained separately, so the OpenAPI generator reads the real
 * requirement off the router instead of tracking a table that would drift.
 *
 * Typed as a plain string because `assistantProcedure` carries the legacy
 * assistant scope, which is deliberately outside `SpliitScope`.
 */
export type ProcedureMeta = {
  scope?: string
}

const t = initTRPC.context<AuthContext>().meta<ProcedureMeta>().create({
  /** @see https://trpc.io/docs/server/data-transformers */
  transformer: superjson,
})

// Base router and procedure helpers
export const createTRPCRouter = t.router
export const baseProcedure = t.procedure

/**
 * Public procedure: anyone can call this. `ctx.auth` may still be non-null if
 * the caller is signed in (e.g. a "current user" hint), but the procedure must
 * not rely on it.
 */
export const publicProcedure = baseProcedure

/**
 * Read procedure that permits sessions and bearer group tokens (`viewKey` /
 * `linkInviteToken`). Individual resolvers still call `loadGroupViewer`.
 */
export const groupReadProcedure = baseProcedure.use(async ({ ctx, next }) => {
  if (
    ctx.auth &&
    'credentialKind' in ctx.auth &&
    ctx.auth.credentialKind === 'oauth'
  ) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Session required' })
  }
  if (ctx.auth && isAnonymousSetupIncomplete(ctx.auth.user)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'ANONYMOUS_SETUP_REQUIRED',
    })
  }
  return next()
})

const assistantRequestLimiter = new FixedWindowLimiter({
  limit: 120,
  windowMs: 60_000,
})
const authenticatedMutationLimiter = new FixedWindowLimiter({
  limit: 120,
  windowMs: 60_000,
})

/**
 * Procedure that requires an authenticated account. The account is exposed to
 * the procedure via `ctx.auth.user`.
 */
export const protectedProcedure = baseProcedure.use(
  async ({ ctx, next, path, type }) => {
    if (
      !ctx.auth ||
      ('credentialKind' in ctx.auth && ctx.auth.credentialKind === 'oauth')
    ) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      })
    }
    if (isAnonymousSetupIncomplete(ctx.auth.user)) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'ANONYMOUS_SETUP_REQUIRED',
      })
    }
    if (type === 'mutation') {
      const decision = authenticatedMutationLimiter.hit(ctx.auth.user.id)
      if (!decision.allowed) {
        logRateLimitExceeded({
          policy: 'authenticated-mutation',
          identity: ctx.auth.user.id,
          retryAfterSeconds: decision.retryAfterSeconds,
          path,
        })
        ctx.resHeaders?.set('Retry-After', String(decision.retryAfterSeconds))
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Request limit exceeded; try again shortly',
        })
      }
    }

    return next({
      ctx: {
        ...ctx,
        // Narrow the type so procedures can rely on a non-null auth.
        auth: ctx.auth,
      },
    })
  },
)

function accountRateLimitedProcedure(options: {
  policy: string
  limit: number
  windowMs: number
}) {
  const limiter = new FixedWindowLimiter({
    limit: options.limit,
    windowMs: options.windowMs,
  })

  const enforce = (accountId: string, path?: string, resHeaders?: Headers) => {
    const decision = limiter.hit(accountId)
    if (decision.allowed) return
    logRateLimitExceeded({
      policy: options.policy,
      identity: accountId,
      retryAfterSeconds: decision.retryAfterSeconds,
      path,
    })
    resHeaders?.set('Retry-After', String(decision.retryAfterSeconds))
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Request limit exceeded; try again later',
    })
  }

  return {
    procedure: protectedProcedure.use(({ ctx, next, path }) => {
      enforce(ctx.auth.user.id, path, ctx.resHeaders)
      return next()
    }),
    enforce,
  }
}

const aiRequests = accountRateLimitedProcedure({
  policy: 'ai',
  limit: 60,
  windowMs: 60 * 60 * 1000,
})
const categoryAiRequests = accountRateLimitedProcedure({
  policy: 'ai-category',
  limit: 120,
  windowMs: 60 * 60 * 1000,
})
const bulkAiRequests = accountRateLimitedProcedure({
  policy: 'ai-bulk',
  limit: 20,
  windowMs: 60 * 60 * 1000,
})
const uploadPresignRequests = accountRateLimitedProcedure({
  policy: 'upload-presign',
  limit: 120,
  windowMs: 60 * 60 * 1000,
})
const importRequests = accountRateLimitedProcedure({
  policy: 'group-import',
  limit: 20,
  windowMs: 60 * 60 * 1000,
})

export const uploadPresignProcedure = uploadPresignRequests.procedure
export const importProcedure = importRequests.procedure

/** Charge AI quotas only immediately before provider work. */
export const enforceAiRequestLimit = aiRequests.enforce
export const enforceCategoryAiRequestLimit = categoryAiRequests.enforce
export const enforceBulkAiRequestLimit = bulkAiRequests.enforce

/**
 * Reads made with a token. Mutations deliberately do not use this bucket: they
 * share `authenticatedMutationLimiter` with the account's own sessions, so a
 * token can never out-mutate the account it acts for.
 */
const scopedReadLimiter = new FixedWindowLimiter({
  limit: 300,
  windowMs: 60_000,
})

/**
 * `FORBIDDEN` that remembers which scope was missing. The `/trpc` fetch handler
 * collects these to build the RFC 6750 `insufficient_scope` challenge with the
 * exact minimum scopes for the requested operations.
 */
export class MissingScopeError extends TRPCError {
  readonly requiredScope: SpliitScope

  constructor(requiredScope: SpliitScope) {
    super({
      code: 'FORBIDDEN',
      message: `Missing required scope: ${requiredScope}`,
    })
    this.requiredScope = requiredScope
  }
}

/**
 * Enforce the token audience, the scope and the programmatic rate limit for an
 * OAuth caller. Shared by `apiProcedure` and `scopedGroupReadProcedure` so the
 * two cannot drift apart on what a token is allowed to do.
 */
function enforceScopedAccess(
  auth: OAuthResolvedAuth,
  requiredScope: SpliitScope,
  path: string | undefined,
  resHeaders: Headers | undefined,
  type: 'query' | 'mutation' | 'subscription' = 'query',
): void {
  // RFC 8707 audience separation: the direct API only accepts tokens minted
  // for itself. A token whose `aud` names only the MCP resource authenticates
  // fine (the assistant surface needs that) but cannot reach this surface —
  // otherwise the MCP hop's forwarded token would double as an API credential.
  // Optional chaining keeps a malformed auth object fail-closed.
  if (!auth.audiences?.includes(getApiBaseUrl())) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Access token was not issued for this API resource',
    })
  }
  if (!hasScope(auth.scopes, requiredScope)) {
    throw new MissingScopeError(requiredScope)
  }
  // Mutations count against the same bucket as the account's browser
  // sessions, so a leaked token cannot write faster than its own account.
  const mutating = type === 'mutation'
  const limiter = mutating ? authenticatedMutationLimiter : scopedReadLimiter
  const decision = limiter.hit(auth.user.id)
  if (decision.allowed) return
  logRateLimitExceeded({
    policy: mutating ? 'authenticated-mutation' : 'oauth-read',
    identity: auth.user.id,
    retryAfterSeconds: decision.retryAfterSeconds,
    path,
  })
  resHeaders?.set('Retry-After', String(decision.retryAfterSeconds))
  throw new TRPCError({
    code: 'TOO_MANY_REQUESTS',
    message: 'Request limit exceeded; try again shortly',
  })
}

/**
 * Group read procedure that also accepts an OAuth token carrying
 * `requiredScope`.
 *
 * Every non-OAuth path is untouched: sessions, `viewKey` holders and
 * `linkInviteToken` invitees reach the resolver exactly as they do through
 * `groupReadProcedure`, anonymous access included. Resolvers derive identity
 * through `groupViewerArgs`, which reads `ctx.auth.user.id`, so a token caller
 * resolves to its own account with no resolver change.
 */
export function scopedGroupReadProcedure(requiredScope: SpliitScope) {
  return baseProcedure
    .meta({ scope: requiredScope })
    .use(async ({ ctx, next, path }) => {
      if (ctx.auth && isAnonymousSetupIncomplete(ctx.auth.user)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'ANONYMOUS_SETUP_REQUIRED',
        })
      }
      if (
        ctx.auth &&
        'credentialKind' in ctx.auth &&
        ctx.auth.credentialKind === 'oauth'
      ) {
        enforceScopedAccess(ctx.auth, requiredScope, path, ctx.resHeaders)
        return next()
      }
      return next()
    })
}

/**
 * Procedure reachable by a signed-in session **or** an OAuth access token
 * carrying `requiredScope`.
 *
 * Session callers are unaffected: they reach the resolver exactly as they do
 * through `protectedProcedure`, with the same anonymous-setup gate. Token
 * callers must carry the scope, so widening a procedure to programmatic clients
 * never widens what a browser session could already do.
 */
export function apiProcedure(requiredScope: SpliitScope) {
  return baseProcedure
    .meta({ scope: requiredScope })
    .use(async ({ ctx, next, path, type }) => {
      if (!ctx.auth) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        })
      }

      if (isAnonymousSetupIncomplete(ctx.auth.user)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'ANONYMOUS_SETUP_REQUIRED',
        })
      }

      const isOAuth =
        'credentialKind' in ctx.auth && ctx.auth.credentialKind === 'oauth'

      if (isOAuth) {
        const auth = ctx.auth as OAuthResolvedAuth
        enforceScopedAccess(auth, requiredScope, path, ctx.resHeaders, type)
        return next({ ctx: { ...ctx, auth } })
      }

      if (type === 'mutation') {
        const decision = authenticatedMutationLimiter.hit(ctx.auth.user.id)
        if (!decision.allowed) {
          logRateLimitExceeded({
            policy: 'authenticated-mutation',
            identity: ctx.auth.user.id,
            retryAfterSeconds: decision.retryAfterSeconds,
            path,
          })
          ctx.resHeaders?.set('Retry-After', String(decision.retryAfterSeconds))
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: 'Request limit exceeded; try again shortly',
          })
        }
      }
      return next({ ctx: { ...ctx, auth: ctx.auth } })
    })
}

/**
 * Require the delete scope for an edit that destroys data.
 *
 * Some mutations delete as a side effect: shortening a recurring series with
 * `THIS_AND_FUTURE` drops the occurrences that fall outside the new schedule
 * and their stored documents. Letting the manage scope cover that would break
 * the promise that a default grant cannot destroy anything.
 *
 * Sessions are unaffected: a signed-in member is already bound by the group
 * role rules, and scopes only ever constrain tokens.
 */
export function assertScopeForDestructiveEdit(
  auth: ResolvedAuth | OAuthResolvedAuth,
): void {
  assertOAuthScope(auth, SPLIIT_SCOPES.expensesDelete)
}

/** Require an additional scope only for OAuth callers; sessions are unchanged. */
export function assertOAuthScope(
  auth: ResolvedAuth | OAuthResolvedAuth,
  requiredScope: SpliitScope,
): void {
  if (!('credentialKind' in auth) || auth.credentialKind !== 'oauth') return
  if (hasScope(auth.scopes, requiredScope)) return
  throw new MissingScopeError(requiredScope)
}

export function assistantProcedure(requiredScope: string) {
  return baseProcedure
    .meta({ scope: requiredScope })
    .use(async ({ ctx, next }) => {
      if (!env.ENABLE_MCP) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Assistant API is disabled',
        })
      }
      if (
        !ctx.auth ||
        !('credentialKind' in ctx.auth) ||
        ctx.auth.credentialKind !== 'oauth'
      ) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'OAuth bearer authentication required',
        })
      }
      if (isAnonymousSetupIncomplete(ctx.auth.user)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'ANONYMOUS_SETUP_REQUIRED',
        })
      }
      if (!ctx.auth.scopes.includes(requiredScope)) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `Missing required scope: ${requiredScope}`,
        })
      }
      const decision = assistantRequestLimiter.hit(ctx.auth.user.id)
      if (!decision.allowed) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Assistant request limit exceeded; try again shortly',
        })
      }
      return next({ ctx: { ...ctx, auth: ctx.auth } })
    })
}

/**
 * Procedure that requires an active group membership for the given groupId.
 * Resolves the group, the group member row, and the ledger, and exposes them on
 * `ctx` for downstream resolvers. Optional minimum role can be passed.
 */
export function groupProcedure(opts: {
  /** Minimum group role required to call this procedure. */
  minRole?: 'MEMBER' | 'ADMIN'
}) {
  const rolesRank: Record<'ADMIN' | 'MEMBER', number> = {
    ADMIN: 2,
    MEMBER: 1,
  }
  const minRole = opts.minRole ?? 'MEMBER'

  return protectedProcedure.use(async ({ ctx, next, path }) => {
    // We expect groupId to be present in the procedure input. Resolvers
    // expose it via ctx.group after this middleware runs.
    return next({
      ctx: {
        ...ctx,
        // Surface the role helper so resolvers can authorise further.
        requireGroupRole(role: 'MEMBER' | 'ADMIN') {
          if (rolesRank[role] < rolesRank[minRole]) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: `Requires role ${role}`,
            })
          }
        },
        // Will be filled in by the per-procedure input middleware if needed.
        // Procedures using `groupProcedure` should additionally call
        // `loadGroupMutationContext` to populate `group`, `member`, and `ledger`.
        __groupMiddlewareTag: path,
      },
    })
  })
}

/**
 * Resolve the current account's membership, role, status, and the group +
 * ledger records for a given groupId. Throws when the account is not an active
 * member. Designed to be called from within a `groupProcedure` (or
 * `protectedProcedure`) resolver.
 */
export async function loadGroupMutationContext({
  groupId,
  accountId,
}: {
  groupId: string
  accountId: string
}) {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: { ledger: true },
  })
  if (!group) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' })
  }

  const member = await prisma.groupMember.findUnique({
    where: { groupId_accountId: { groupId, accountId } },
    include: { ledgerParticipant: true },
  })
  if (!member || member.status !== 'ACTIVE') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You are not an active member of this group',
    })
  }

  return { group, member, ledger: group.ledger }
}

/** Shared input fields for bearer tokens carried in the group page URL. */
export const groupAccessFields = {
  linkInviteToken: z.string().optional(),
  viewKey: z.string().optional(),
}

export function groupViewerArgs(
  input: { groupId: string; linkInviteToken?: string; viewKey?: string },
  ctx: { auth?: { user?: { id: string; email?: string | null } } | null },
) {
  return {
    groupId: input.groupId,
    accountId: ctx.auth?.user?.id,
    accountEmail: ctx.auth?.user?.email,
    linkInviteToken: input.linkInviteToken,
    viewKey: input.viewKey,
  }
}

/**
 * Read-only group viewer: ACTIVE member, public view-only key, or PENDING
 * invitee (email match or `?invite=` token). Mutations must still use
 * `loadGroupMutationContext` to enforce write eligibility.
 */
export type GroupViewer =
  | { kind: 'ACTIVE'; access: 'READ_WRITE' }
  | { kind: 'PUBLIC_VIEW'; access: 'READ_ONLY' }
  | {
      kind: 'PENDING_INVITEE'
      access: 'READ_ONLY'
      invitation: {
        id: string
        role: GroupRole
        type: GroupInvitationType
      }
    }

export type GroupViewerContext = {
  group: NonNullable<Awaited<ReturnType<typeof prisma.group.findUnique>>> & {
    ledger: NonNullable<Awaited<ReturnType<typeof prisma.ledger.findUnique>>>
  }
  member:
    | (NonNullable<
        Awaited<ReturnType<typeof prisma.groupMember.findUnique>>
      > & {
        ledgerParticipant: Awaited<
          ReturnType<typeof prisma.ledgerParticipant.findUnique>
        >
      })
    | null
  ledger: NonNullable<Awaited<ReturnType<typeof prisma.ledger.findUnique>>>
  viewer: GroupViewer
}

export async function loadGroupViewer({
  groupId,
  accountId,
  accountEmail,
  viewKey,
  linkInviteToken,
}: {
  groupId: string
  accountId?: string | null
  accountEmail?: string | null
  viewKey?: string | null
  linkInviteToken?: string | null
}): Promise<GroupViewerContext> {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: { ledger: true },
  })
  if (!group) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' })
  }

  const member = accountId
    ? await prisma.groupMember.findUnique({
        where: { groupId_accountId: { groupId, accountId } },
        include: { ledgerParticipant: true },
      })
    : null

  if (member && member.status === 'ACTIVE') {
    return {
      group,
      member,
      ledger: group.ledger,
      viewer: { kind: 'ACTIVE', access: 'READ_WRITE' },
    }
  }

  if (accountEmail) {
    const invitation = await prisma.groupInvitation.findFirst({
      where: {
        groupId,
        type: GroupInvitationType.EMAIL,
        status: GroupInvitationStatus.PENDING,
        email: { equals: accountEmail, mode: 'insensitive' },
      },
      select: { id: true, role: true, type: true },
    })

    if (invitation) {
      return {
        group,
        member: null,
        ledger: group.ledger,
        viewer: {
          kind: 'PENDING_INVITEE',
          access: 'READ_ONLY',
          invitation: {
            id: invitation.id,
            role: invitation.role,
            type: invitation.type,
          },
        },
      }
    }
  }

  const trimmedViewKey = viewKey?.trim()
  if (
    trimmedViewKey &&
    group.groupType === 'GROUP' &&
    group.publicViewKey &&
    groupViewKeysMatch(group.publicViewKey, trimmedViewKey)
  ) {
    return {
      group,
      member: null,
      ledger: group.ledger,
      viewer: { kind: 'PUBLIC_VIEW', access: 'READ_ONLY' },
    }
  }

  const trimmedInvite = linkInviteToken?.trim()
  if (trimmedInvite) {
    const invitation = await prisma.groupInvitation.findFirst({
      where: {
        groupId,
        type: GroupInvitationType.LINK,
        status: GroupInvitationStatus.PENDING,
        tokenHash: await hashLinkToken(trimmedInvite),
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true, role: true, type: true },
    })
    if (invitation) {
      return {
        group,
        member: null,
        ledger: group.ledger,
        viewer: {
          kind: 'PENDING_INVITEE',
          access: 'READ_ONLY',
          invitation: {
            id: invitation.id,
            role: invitation.role,
            type: invitation.type,
          },
        },
      }
    }
  }

  if (trimmedViewKey || trimmedInvite) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: trimmedViewKey
        ? 'This view-only link is not valid for this group.'
        : 'This invite link is not valid for this group.',
    })
  }

  if (!accountId) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
    })
  }

  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'You are not an active member of this group',
  })
}
