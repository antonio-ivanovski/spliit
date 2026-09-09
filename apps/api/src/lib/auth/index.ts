import { randomUUID } from 'node:crypto'

import { oauthProvider } from '@better-auth/oauth-provider'
import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from 'better-auth/api'
import {
  jwt,
  magicLink,
  openAPI,
  type Jwk,
  type JwtOptions,
} from 'better-auth/plugins'
import { anonymous } from 'better-auth/plugins/anonymous'
import { genericOAuth } from 'better-auth/plugins/generic-oauth'

import { prisma, type Account } from '@spliit/db'
import { isStrongPassword } from '@spliit/domain/password'

import { autoAcceptPendingFriendInvitationsForAccount } from '../api/friends'
import { env, getConfiguredOidcProvider, webOrigins } from '../env'
import {
  buildProviderPlaceholderEmail,
  isPlaceholderEmail,
} from '../invitations'
import { sendEmail } from '../mail/send'
import {
  renderMagicLinkEmail,
  renderPasswordChangedNoticeEmail,
  renderPasswordRecoveryEmail,
  renderVerificationEmail,
} from '../mail/templates'
import {
  FixedWindowLimiter,
  logRateLimitExceeded,
  resolveClientIp,
} from '../rate-limit'
import { invalidateAccountCache } from './account-cache'
import { anonymousRecovery } from './anonymous-recovery'
import { emailChange } from './email-change'
import { enforceAuthEmailRecipientLimit } from './email-rate-limit'
import { bindLegacyRefreshTokenResource } from './oauth-refresh-compat'
import { applyNativeApplicationTypeForLoopbackRegistration } from './oauth-registration'
import {
  finalizeOAuthTokenExchange,
  prepareOAuthConsent,
  prepareOAuthTokenExchange,
  rearmOAuthClientAfterConsent,
} from './oauth-revocation-barrier'
import { passwordSet } from './password-set'
import { ALL_SCOPES, DEFAULT_CLIENT_SCOPES } from './scopes'
import {
  assertCanCreateAccount,
  enforceSignupGate,
  persistSignupInviteCookie,
} from './signup-gate'
import { getApiBaseUrl, oauthAudiences } from './urls'

const oidcProvider = getConfiguredOidcProvider()

const anonymousSignupLimiter = new FixedWindowLimiter({
  limit: 10,
  windowMs: 60 * 60 * 1000,
})

const changePasswordLimiter = new FixedWindowLimiter({
  limit: 10,
  windowMs: 60 * 60 * 1000,
})

const authMethodLabels: Record<string, string> = {
  credential: 'email and password',
  google: 'Google',
  github: 'GitHub',
  twitter: 'X',
  'magic-link': 'email sign-in link',
  ...(oidcProvider ? { [oidcProvider.id]: oidcProvider.name } : {}),
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function getAuthMethodLabels(userId: string) {
  const identities = await prisma.authIdentity.findMany({
    where: { userId },
    select: { providerId: true },
    orderBy: { createdAt: 'asc' },
  })

  return Array.from(
    new Set(
      identities.map(
        (identity) =>
          authMethodLabels[identity.providerId] ?? identity.providerId,
      ),
    ),
  )
}

function buildPasswordRecoveryEmail(opts: {
  resetUrl: string
  methodLabels: string[]
}) {
  return renderPasswordRecoveryEmail(opts)
}

const beforeAuthMiddleware = createAuthMiddleware(async (ctx) => {
  if (ctx.path === '/oauth2/token') {
    await prepareOAuthTokenExchange(ctx.request, ctx.body)
    await bindLegacyRefreshTokenResource(ctx.body)
  }
  if (ctx.path === '/oauth2/consent') {
    prepareOAuthConsent(ctx.request)
  }

  if (ctx.path === '/oauth2/authorize') {
    const authorizationParams =
      ctx.method === 'POST' && isRecord(ctx.body) ? ctx.body : ctx.query
    if (isRecord(authorizationParams) && authorizationParams.resource == null) {
      authorizationParams.resource = getApiBaseUrl()
    }
  }

  if (ctx.path === '/oauth2/register' && isRecord(ctx.body)) {
    applyNativeApplicationTypeForLoopbackRegistration(ctx.body)
  }

  if (ctx.path === '/sign-in/anonymous') {
    if (!env.ENABLE_ANONYMOUS_AUTH || env.SIGNUP_MODE !== 'open') {
      throw new APIError('FORBIDDEN', {
        message: 'Anonymous account creation is disabled.',
        code: 'ANONYMOUS_SIGNUP_DISABLED',
      })
    }
    const current = await getSessionFromCtx(ctx, { disableRefresh: true })
    if (current) {
      throw new APIError('CONFLICT', {
        message: 'Sign out before creating an anonymous account.',
        code: 'ANONYMOUS_SIGNUP_ACCOUNT_CONFLICT',
      })
    }
    const ip = resolveClientIp(ctx.headers ?? new Headers(), {
      trustProxy: env.TRUST_PROXY,
    })
    const decision = anonymousSignupLimiter.hit(ip)
    if (!decision.allowed) {
      logRateLimitExceeded({
        policy: 'anonymous-signup',
        identity: ip,
        retryAfterSeconds: decision.retryAfterSeconds,
        path: ctx.path,
      })
      throw new APIError(
        'TOO_MANY_REQUESTS',
        {
          message: 'Too many anonymous accounts. Please try again later.',
          code: 'ANONYMOUS_SIGNUP_RATE_LIMITED',
        },
        { 'Retry-After': String(decision.retryAfterSeconds) },
      )
    }
  }

  const password =
    ctx.path === '/sign-up/email'
      ? ctx.body?.password
      : ctx.path === '/reset-password' ||
          ctx.path === '/change-password' ||
          ctx.path === '/password/set'
        ? ctx.body?.newPassword
        : undefined

  if (ctx.path === '/change-password') {
    const session = await getSessionFromCtx(ctx, { disableRefresh: true })
    const accountId =
      session?.user && typeof session.user.id === 'string'
        ? session.user.id
        : null
    if (accountId) {
      const ip = resolveClientIp(ctx.headers ?? new Headers(), {
        trustProxy: env.TRUST_PROXY,
      })
      const decision = changePasswordLimiter.hit(`${accountId}:${ip}`)
      if (!decision.allowed) {
        logRateLimitExceeded({
          policy: 'password-change',
          identity: accountId,
          retryAfterSeconds: decision.retryAfterSeconds,
          path: ctx.path,
        })
        throw new APIError(
          'TOO_MANY_REQUESTS',
          {
            message: 'Too many attempts. Please try again later.',
            code: 'PASSWORD_RATE_LIMITED',
          },
          { 'Retry-After': String(decision.retryAfterSeconds) },
        )
      }
    }
    // Force revocation so the “other sessions have been signed out” notice is accurate
    // even for raw API callers that omit the field. The web client already sends true.
    if (isRecord(ctx.body)) {
      ctx.body.revokeOtherSessions = true
    }
  }

  if (typeof password === 'string' && !isStrongPassword(password)) {
    throw new APIError('BAD_REQUEST', {
      message:
        'Password must be at least 8 characters and include uppercase, lowercase, number, and symbol.',
      code: 'PASSWORD_POLICY_NOT_MET',
    })
  }

  await persistSignupInviteCookie(ctx)
  await enforceSignupGate(ctx)
})

async function narrowDynamicClientRegistrationScopes(ctx: {
  path: string
  body: unknown
  context: { returned?: unknown }
}) {
  if (ctx.path !== '/oauth2/register' || !isRecord(ctx.context.returned)) return
  const clientId = ctx.context.returned.client_id
  if (typeof clientId !== 'string') return

  // Better Auth 1.7 persists the union of default and allowed registration
  // scopes as every dynamic client's capability set. Spliit's delete scopes
  // are deliberately opt-in per client, so retain the narrower registration
  // request (or our non-destructive defaults) in both storage and response.
  const requestedScope =
    isRecord(ctx.body) && typeof ctx.body.scope === 'string'
      ? ctx.body.scope.split(' ').filter(Boolean)
      : DEFAULT_CLIENT_SCOPES
  const scopes = [...new Set(requestedScope)]

  try {
    await prisma.oauthClient.update({
      where: { clientId },
      data: { scopes },
    })
  } catch (error) {
    // Never leave behind a broader registration if narrowing failed.
    await prisma.oauthClient.deleteMany({ where: { clientId } }).catch(() => {})
    throw error
  }
  ctx.context.returned.scope = scopes.join(' ')
}

// Integration and unit tests share the local PostgreSQL database with the
// already-running development API. Persisting test signing keys there would
// replace or conflict with keys encrypted by the development secret. Keep test
// JWKS process-local while development and production continue using Better
// Auth's default database-backed adapter.
const testJwks: Jwk[] = []
const testJwtAdapter: JwtOptions['adapter'] | undefined =
  env.NODE_ENV === 'test'
    ? {
        async getJwks() {
          return [...testJwks]
        },
        async createJwk(data) {
          const key: Jwk = { ...data, id: randomUUID() }
          testJwks.push(key)
          return key
        },
      }
    : undefined

type OAuthToken = {
  accessToken?: string
}

type GitHubProfile = {
  id: number | string
  login?: string | null
  name?: string | null
  email?: string | null
  avatar_url?: string | null
}

type GitHubEmail = {
  email: string
  primary: boolean
  verified: boolean
  visibility: 'public' | 'private' | null
}

async function fetchGitHubJson<T>(url: string, accessToken: string) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': 'spliit-cloud',
    },
  })
  if (!response.ok) return null
  return (await response.json()) as T
}

/**
 * Resolve the Spliit `Account` for a GitHub OAuth sign-in. Prefers a verified
 * email from GitHub's `/user/emails` endpoint; falls back to a synthetic
 * placeholder email (`<id>@github.placeholder.local`) when the user has no
 * verified email on file (private email, missing `user:email` scope). The
 * synthetic path is what enables "email-less accounts" — the user gets a
 * complete account and can use the app, but email-only features (magic-link
 * sign-in, password reset, notifications) skip them because the email is a
 * placeholder.
 */
export async function getVerifiedGitHubUserInfo(token: OAuthToken) {
  if (!token.accessToken) return null

  const profile = await fetchGitHubJson<GitHubProfile>(
    'https://api.github.com/user',
    token.accessToken,
  )
  if (!profile) return null

  const emails = await fetchGitHubJson<GitHubEmail[]>(
    'https://api.github.com/user/emails',
    token.accessToken,
  )

  const verifiedEmail =
    emails?.find((email) => email.primary && email.verified) ??
    emails?.find((email) => email.verified)

  const profileId = String(profile.id)
  const displayName = profile.name || profile.login || ''
  const image = profile.avatar_url ?? undefined

  if (verifiedEmail) {
    return {
      user: {
        name: displayName,
        email: verifiedEmail.email,
        image,
        emailVerified: true,
      },
      data: {
        ...profile,
        email: verifiedEmail.email,
      },
    }
  }

  // No verified email on GitHub. Synthesize a placeholder so the user
  // can still sign in. `emailVerified: false` keeps magic-link sign-in
  // and password recovery off the table for these accounts (they have
  // no real address to send to) and `isPlaceholderEmail(...)` is the
  // application-side marker to skip email-only features.
  return {
    user: {
      name: displayName,
      email: buildProviderPlaceholderEmail('github', profileId),
      image,
      emailVerified: false,
    },
    data: {
      ...profile,
      email: null,
      isPlaceholderEmail: true,
    },
  }
}

type TwitterProfile = {
  data?: {
    id?: string
    name?: string | null
    username?: string | null
    profile_image_url?: string | null
    confirmed_email?: string | null
  }
}

const TWITTER_PROFILE_FETCH_TIMEOUT_MS = 8_000

async function fetchTwitterJson<T>(url: string, accessToken: string) {
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(TWITTER_PROFILE_FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

/**
 * Resolve the Spliit `Account` for an X (Twitter) OAuth sign-in. Prefers the
 * confirmed email from X API v2 (`user.fields=confirmed_email`); falls back to
 * a synthetic placeholder (`<id>@twitter.placeholder.local`) when the user has
 * no confirmed email. Better Auth's default uses the X username as the email in
 * that case, which is not a real address and would break account linking and
 * email-only features.
 */
export async function getVerifiedTwitterUserInfo(token: OAuthToken) {
  if (!token.accessToken) return null

  const profile = await fetchTwitterJson<TwitterProfile>(
    'https://api.x.com/2/users/me?user.fields=profile_image_url,confirmed_email',
    token.accessToken,
  )
  const data = profile?.data
  if (!data?.id) return null

  const profileId = String(data.id)
  const displayName = data.name || data.username || ''
  const image = data.profile_image_url ?? undefined
  const confirmedEmail = data.confirmed_email?.trim()

  if (confirmedEmail) {
    return {
      user: {
        name: displayName,
        email: confirmedEmail,
        image,
        emailVerified: true,
      },
      data: {
        data: {
          ...data,
          email: confirmedEmail,
        },
      },
    }
  }

  return {
    user: {
      name: displayName,
      email: buildProviderPlaceholderEmail('twitter', profileId),
      image,
      emailVerified: false,
    },
    data: {
      data: {
        ...data,
        email: null,
      },
      isPlaceholderEmail: true,
    },
  }
}

/**
 * Spliit authentication is built on better-auth. better-auth owns its own
 * schema (user, session, account, verification). We map those tables to our
 * Spliit concepts:
 *
 * Better-auth "user" -> Account (stable global user profile) better-auth
 * "account" -> AuthIdentity (provider identity records) better-auth "session"
 * -> Session (server-recognized sessions) better-auth "verification" ->
 * Verification (magic-link/email tokens)
 *
 * The mapping is achieved by passing `modelName` overrides to better-auth and
 * by naming the Prisma models to match (see packages/db/prisma/schema.prisma).
 *
 * Email identity merging: better-auth links a new OAuth/magic-link sign-in to
 * the existing `Account` when the verified email matches. We rely on the
 * library's `accountLinking` behaviour for that.
 */
export const auth = betterAuth({
  appName: 'Spliit Cloud',
  baseURL: getApiBaseUrl(),
  // The Hono mount point is `/auth/*`; tell better-auth so its internal
  // router strips the prefix when matching request paths. Without this,
  // basePath defaults to `/api/auth` and every endpoint (sign-in, callback,
  // social, session, …) returns 404.
  basePath: '/auth',
  // OAuth Provider mode exposes `/oauth2/token`; Better Auth's standalone JWT
  // token endpoint is redundant and must not be advertised or callable.
  // The provider's native delete-consent route only removes the consent row
  // and leaves refresh tokens alive. Account settings uses the transactional
  // Spliit revocation path instead, so keep the unsafe shortcut unreachable.
  disabledPaths: ['/token', '/oauth2/delete-consent'],
  secret: env.BETTER_AUTH_SECRET ?? 'spliit-dev-secret-change-me',
  // CORS already allows every configured WEB_ORIGINS entry; pass the full
  // list to better-auth so its trusted-origin check agrees. With only the
  // first entry here, sign-in from any additional origin would pass CORS
  // and then be rejected by better-auth.
  trustedOrigins: webOrigins,

  // Better Auth's built-in limiter is keyed by client IP. Without a trusted
  // proxy there is no safe per-client IP identity, so enabling it would put
  // every caller into one replica-wide bucket. The recipient-based email
  // limiter above remains active in either mode.
  rateLimit: {
    enabled: env.TRUST_PROXY,
  },

  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),

  // Use Spliit-specific model names that match our Prisma schema.
  user: {
    modelName: 'Account',
  },
  session: {
    modelName: 'Session',
    // 180-day (6 months) rolling sessions; better-auth handles refresh/sliding expiry.
    expiresIn: 60 * 60 * 24 * 180,
    updateAge: 60 * 60 * 24,
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5,
    },
  },
  account: {
    modelName: 'AuthIdentity',
    accountLinking: {
      enabled: true,
      // Generic OIDC is operator-configured and may report unverified
      // emails. Better Auth implicit-links a trusted provider even when
      // `emailVerified` is false, which would let a matching address take
      // over an existing account. Google, GitHub, and X stay trusted; OIDC
      // still links when the IdP marks the email verified.
      trustedProviders: [
        'google',
        'github',
        'twitter',
        'credential',
        'magic-link',
      ],
    },
  },
  verification: {
    modelName: 'Verification',
  },

  hooks: {
    before: beforeAuthMiddleware,
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/oauth2/token') {
        const revoked = await finalizeOAuthTokenExchange(ctx.request)
        if (revoked) return revoked
      }
      if (ctx.path === '/oauth2/consent') {
        await rearmOAuthClientAfterConsent(ctx.request, ctx.context.returned)
      }
      await narrowDynamicClientRegistrationScopes(ctx)
      if (ctx.path !== '/change-password') return
      let data: unknown = ctx.context.returned
      if (data instanceof Response) {
        if (data.status !== 200) return
        try {
          data = await data.clone().json()
        } catch {
          return
        }
      }
      if (isAPIError(data)) return
      if (
        !data ||
        typeof data !== 'object' ||
        !('user' in (data as Record<string, unknown>))
      )
        return
      const returnedUser = (data as { user?: { email?: string } }).user
      // Prefer returned user email (canonical after write); fall back to session
      const sessionEmail =
        returnedUser?.email ??
        (ctx.context.session?.user as { email?: string } | undefined)?.email
      if (!sessionEmail || isPlaceholderEmail(sessionEmail)) return
      try {
        const rendered = await renderPasswordChangedNoticeEmail()
        await sendEmail({ to: sessionEmail, ...rendered })
      } catch (err) {
        console.warn(
          `[password-change] failed to send notice to ${sessionEmail}:`,
          err,
        )
      }
    }),
  },

  // Reconcile pending friend-ledger invitations that target this
  // account's email immediately after the account row is created.
  // This is a one-time initialization — the hook fires on sign-up
  // (email/password, magic link, OAuth) and on programmatic account
  // creation. The function is idempotent: subsequent calls are no-ops
  // because all matching invitations are already flipped to ACCEPTED.
  databaseHooks: {
    user: {
      create: {
        before: async (user, context) => {
          await assertCanCreateAccount({
            email: user.email,
            context,
          })
          if (user.isAnonymous) {
            return { data: { ...user, name: user.email } }
          }
        },
        after: async (user) => {
          if (user.email) {
            await autoAcceptPendingFriendInvitationsForAccount({
              accountId: user.id,
              accountEmail: user.email,
            })
          }
        },
      },
      update: {
        after: async (user) => {
          invalidateAccountCache(user.id)
        },
      },
      delete: {
        after: async (user) => {
          invalidateAccountCache(user.id)
        },
      },
    },
  },

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    // One-hour window between requesting the reset and clicking the link.
    // Long enough to read the email, short enough that a leaked link is
    // unlikely to still be useful to an attacker.
    resetPasswordTokenExpiresIn: 60 * 60,
    // Cut off any other sessions for this account when the password is
    // changed. Standard recovery-flow hygiene: if a stolen session cookie
    // outlived the user noticing the breach, the reset kicks it out.
    revokeSessionsOnPasswordReset: true,
    async sendResetPassword({ user, url }) {
      enforceAuthEmailRecipientLimit(user.email, '/request-password-reset')
      // Best-effort: a failed send must not break the forgot-password flow.
      // better-auth already created the verification token in the DB, so the
      // user can retry from the forgot-password page and a fresh token will
      // be issued on the next request. Mirrors the swallow-and-warn pattern
      // used for verification emails and magic links above.
      try {
        const methodLabels = await getAuthMethodLabels(user.id)
        const email = await buildPasswordRecoveryEmail({
          resetUrl: url,
          methodLabels,
        })
        await sendEmail({
          to: user.email,
          ...email,
        })
      } catch (err) {
        console.warn(
          `[password-reset] failed to send reset email to ${user.email}:`,
          err,
        )
      }
    },
  },

  emailVerification: {
    // Verification should complete the sign-up by creating a session before
    // redirecting back to the web app.
    autoSignInAfterVerification: true,
    async sendVerificationEmail({ user, url }) {
      enforceAuthEmailRecipientLimit(user.email, '/send-verification-email')
      // Best-effort: a failed send must not break the sign-up flow.
      // better-auth already created the verification token in the DB, so the
      // user can retry from the sign-in page and a fresh token will be issued.
      // Mirrors the swallow-and-warn pattern used for magic links.
      try {
        const rendered = await renderVerificationEmail({
          verificationUrl: url,
        })
        await sendEmail({
          to: user.email,
          ...rendered,
        })
      } catch (err) {
        console.warn(
          `[email-verification] failed to send verification email to ${user.email}:`,
          err,
        )
      }
    },
  },

  socialProviders: (() => {
    const providers: Record<
      string,
      {
        clientId: string
        clientSecret: string
        getUserInfo?:
          | typeof getVerifiedGitHubUserInfo
          | typeof getVerifiedTwitterUserInfo
      }
    > = {}
    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
      providers.google = {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      }
    }
    if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
      providers.github = {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        getUserInfo: getVerifiedGitHubUserInfo,
      }
    }
    if (env.TWITTER_CLIENT_ID && env.TWITTER_CLIENT_SECRET) {
      providers.twitter = {
        clientId: env.TWITTER_CLIENT_ID,
        clientSecret: env.TWITTER_CLIENT_SECRET,
        getUserInfo: getVerifiedTwitterUserInfo,
      }
    }
    return Object.keys(providers).length > 0 ? providers : undefined
  })(),

  plugins: [
    anonymous({
      disableDeleteAnonymousUser: true,
      generateRandomEmail: () =>
        `guest-${randomUUID()}@anonymous.placeholder.local`,
    }),
    anonymousRecovery(),
    emailChange(),
    passwordSet(),
    ...(oidcProvider
      ? [
          genericOAuth({
            config: [
              {
                providerId: oidcProvider.id,
                clientId: oidcProvider.clientId,
                clientSecret: oidcProvider.clientSecret,
                discoveryUrl: oidcProvider.discoveryUrl,
                scopes: ['openid', 'email', 'profile'],
                // Keep the 1.6 synthetic issuer so existing AuthIdentity rows
                // (`local:oauth:<providerId>`) continue to match after 1.7's
                // discovery-based issuer default.
                accountIssuer: `local:oauth:${encodeURIComponent(oidcProvider.id)}`,
              },
            ],
          }),
        ]
      : []),
    // The OAuth provider is no longer gated behind ENABLE_MCP. The MCP app is
    // one client among others: any programmatic client (scripts, agents) needs
    // the same authorization server, and gating it made the API unreachable
    // whenever the assistant was disabled.
    oauthProvider({
      loginPage: `${webOrigins[0]}/oauth/login`,
      consentPage: `${webOrigins[0]}/oauth/consent`,
      scopes: [...ALL_SCOPES],
      // The API is the default protected resource. Keep the MCP resource
      // registered while configured so existing assistant clients can still
      // request tokens for it explicitly.
      resources: oauthAudiences(),
      clientRegistrationDefaultResources: [getApiBaseUrl()],
      clientRegistrationAllowedResources: oauthAudiences(),
      // Existing clients predate the 1.7 client-resource join table. Keep the
      // global resource allowlist authoritative until those registrations can
      // be backfilled without breaking their refresh flow.
      enforcePerClientResources: false,
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      allowPublicClientPrelogin: true,
      silenceWarnings: { oauthAuthServerConfig: true },
      grantTypes: ['authorization_code', 'refresh_token'],
      // Registering without asking for anything specific grants read-only
      // access. Manage and delete must be requested explicitly, so an
      // underspecified client fails safely into the step-up flow.
      clientRegistrationDefaultScopes: [...DEFAULT_CLIENT_SCOPES],
      clientRegistrationAllowedScopes: [...ALL_SCOPES],
      customAccessTokenClaims: ({ user }) => ({
        account_id: user?.id,
      }),
    }),
    jwt({
      // OAuth access tokens are minted by the OAuth Provider flow. Adding a
      // JWT header to every cookie-session response is unnecessary and makes
      // ordinary `/get-session` reads depend on the OAuth signing key.
      disableSettingJwtHeader: true,
      adapter: testJwtAdapter,
    }),
    magicLink({
      disableSignUp: false,
      sendMagicLink: async ({ email, url }) => {
        enforceAuthEmailRecipientLimit(email, '/sign-in/magic-link')
        // Best-effort: a failed send must not break the magic-link sign-in
        // flow. better-auth already created the verification token in the DB,
        // so the user can retry from the sign-in page and a fresh token will
        // be issued on the next request. Mirrors the swallow-and-warn pattern
        // used in lib/invitations.ts.
        try {
          const rendered = await renderMagicLinkEmail({
            signInUrl: url,
          })
          await sendEmail({
            to: email,
            ...rendered,
          })
        } catch (err) {
          console.warn(
            `[magic-link] failed to send magic link email to ${email}:`,
            err,
          )
        }
      },
    }),
    // Exposes `auth.api.generateOpenAPISchema()` so the build-time spec
    // generator in `apps/api/scripts/generate-openapi.ts` can introspect
    // every endpoint (core + magic-link) and emit accurate paths, request
    // bodies, and responses — replacing hand-maintained auth paths that
    // drifted from the real routes. `disableDefaultReference` keeps
    // better-auth from mounting its own Scalar UI at `/auth/reference`;
    // we already serve a unified `/docs` page that merges tRPC + auth.
    //
    // Gated to non-production: the runtime schema endpoint
    // (`GET /auth/open-api/generate-schema`) leaks the auth API surface
    // and is not needed once the spec has been generated. The build
    // script runs with `NODE_ENV=` (empty), so the plugin is always
    // available at build time.
    ...(process.env.NODE_ENV === 'production'
      ? []
      : [openAPI({ disableDefaultReference: true })]),
  ],

  advanced: {
    // Use secure, HTTP-only cookies. The web client already runs on the same
    // origin in production and CORS is configured to allow credentials, so we
    // can rely on first-party cookies without exposing tokens to JS.
    useSecureCookies: process.env.NODE_ENV === 'production',
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    },
    ipAddress: {
      disableIpTracking: !env.TRUST_PROXY,
      // The public deployment is origin-locked behind Cloudflare. Prefer its
      // single-value client header, with conventional proxy headers retained
      // for supported self-hosted gateways. The Hono adapter strips all three
      // before calling Better Auth when TRUST_PROXY is disabled.
      ipAddressHeaders: ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'],
    },
  },
})

export type AuthAccount = Account
export type AuthInstance = typeof auth
