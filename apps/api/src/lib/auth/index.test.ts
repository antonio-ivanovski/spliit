// organize-imports-ignore: ./mocks must be imported before any module that
// loads better-auth or @spliit/db so vi.mock is registered before those
// modules are evaluated.
import { afterEach, describe, expect, it, vi } from 'vitest'

import '../../test/mocks'
import { prismaMock, sendEmailMock } from '../../test/state'
import { clearAccountCache, getCachedAccount } from './account-cache'
import { DEFAULT_CLIENT_SCOPES, SPLIIT_SCOPES } from './scopes'

// `vi.importActual` returns the real (un-mocked) module so we can inspect the
// better-auth options we configured in `lib/auth/index.ts`. The existing
// `vi.mock('../lib/auth/index', ...)` in `./mocks` would otherwise hide the
// `options` property.
const realAuthModule = (await vi.importActual('./index')) as {
  getVerifiedGitHubUserInfo: (token: { accessToken?: string }) => Promise<{
    user: {
      name: string
      email: string
      image?: string
      emailVerified: boolean
    }
    data?: { id?: number | string; isPlaceholderEmail?: boolean }
  } | null>
  getVerifiedTwitterUserInfo: (token: { accessToken?: string }) => Promise<{
    user: {
      name: string
      email: string
      image?: string
      emailVerified: boolean
    }
    data?: {
      data?: { id?: string }
      isPlaceholderEmail?: boolean
    }
  } | null>
  auth: {
    options: {
      disabledPaths?: string[]
      plugins?: Array<{
        id?: string
        options?: {
          disableSettingJwtHeader?: boolean
          adapter?: unknown
          disableDeleteAnonymousUser?: boolean
          generateName?: (ctx: { headers?: Headers }) => string
          generateRandomEmail?: () => string
        }
      }>
      emailVerification?: {
        autoSignInAfterVerification?: boolean
        sendVerificationEmail?: (params: {
          user: { id: string; email: string }
          url: string
        }) => Promise<void>
      }
      session?: {
        expiresIn?: number
        updateAge?: number
      }
      hooks?: {
        before?: unknown
        after?: (ctx: unknown) => Promise<void>
      }
      databaseHooks?: {
        user?: {
          create?: {
            before?: (
              user: Record<string, unknown>,
              context: { path?: string },
            ) =>
              | Promise<{ data: Record<string, unknown> } | false | void>
              | { data: Record<string, unknown> }
              | false
              | void
          }
          update?: { after?: (user: { id: string }) => void | Promise<void> }
          delete?: { after?: (user: { id: string }) => void | Promise<void> }
        }
      }
      account?: {
        accountLinking?: {
          enabled?: boolean
          trustedProviders?: string[]
        }
      }
      advanced?: {
        ipAddress?: {
          ipAddressHeaders?: string[]
          disableIpTracking?: boolean
        }
      }
      rateLimit?: { enabled?: boolean }
      socialProviders?: Record<
        string,
        {
          clientId: string
          clientSecret: string
          getUserInfo?: (token: { accessToken?: string }) => Promise<{
            user: {
              name: string
              email: string
              image?: string
              emailVerified: boolean
            }
            data?: unknown
          } | null>
        }
      >
      emailAndPassword?: {
        sendResetPassword?: (params: {
          user: { id: string; email: string }
          url: string
        }) => Promise<void>
        revokeSessionsOnPasswordReset?: boolean
        resetPasswordTokenExpiresIn?: number
      }
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('better-auth session config', () => {
  it('registers anonymous auth with destructive linking disabled', () => {
    const plugin = realAuthModule.auth.options.plugins?.find(
      (candidate) => candidate.id === 'anonymous',
    )
    expect(plugin).toBeDefined()
    expect(plugin?.options).toMatchObject({
      disableDeleteAnonymousUser: true,
    })
    expect(plugin?.options?.generateName).toBeUndefined()
    expect(plugin?.options?.generateRandomEmail?.()).toMatch(
      /^guest-[0-9a-f-]+@anonymous\.placeholder\.local$/,
    )
  })

  it('registers the Spliit email add/change plugin', () => {
    const plugin = realAuthModule.auth.options.plugins?.find(
      (candidate) => candidate.id === 'spliit-email-change',
    )
    expect(plugin).toBeDefined()
  })

  it('marks a new anonymous account for the standard profile-name flow', async () => {
    prismaMock.account.count.mockResolvedValue(0)
    const beforeCreate =
      realAuthModule.auth.options.databaseHooks?.user?.create?.before
    expect(beforeCreate).toBeDefined()

    const result = await beforeCreate?.(
      {
        id: 'anonymous-1',
        email: 'guest-1@anonymous.placeholder.local',
        emailVerified: false,
        isAnonymous: true,
        name: 'Anonymous',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never,
      { path: '/sign-in/anonymous' } as never,
    )

    expect(result).toMatchObject({
      data: {
        name: 'guest-1@anonymous.placeholder.local',
      },
    })
  })

  it('uses a 180-day rolling session refreshed daily', () => {
    expect(realAuthModule.auth.options.session?.expiresIn).toBe(
      60 * 60 * 24 * 180,
    )
    expect(realAuthModule.auth.options.session?.updateAge).toBe(60 * 60 * 24)
  })

  it('keeps the standalone JWT token endpoint disabled in OAuth Provider mode', () => {
    expect(realAuthModule.auth.options.disabledPaths).toContain('/token')
  })

  it('disables the provider consent deletion that would leave refresh tokens alive', () => {
    expect(realAuthModule.auth.options.disabledPaths).toContain(
      '/oauth2/delete-consent',
    )
  })

  it('does not attach a JWT header to ordinary cookie-session responses', () => {
    const jwtPlugin = realAuthModule.auth.options.plugins?.find(
      (plugin) => plugin.id === 'jwt',
    )

    expect(jwtPlugin?.options?.disableSettingJwtHeader).toBe(true)
  })

  it('checks Cloudflare and conventional proxy IP headers in order', () => {
    expect(
      realAuthModule.auth.options.advanced?.ipAddress?.ipAddressHeaders,
    ).toEqual(['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'])
  })

  it('disables built-in IP tracking and throttling without a trusted proxy', () => {
    expect(realAuthModule.auth.options.rateLimit?.enabled).toBe(false)
    expect(
      realAuthModule.auth.options.advanced?.ipAddress?.disableIpTracking,
    ).toBe(true)
  })

  it('uses an isolated JWKS adapter in the test environment', () => {
    const jwtPlugin = realAuthModule.auth.options.plugins?.find(
      (plugin) => plugin.id === 'jwt',
    )

    expect(jwtPlugin?.options?.adapter).toBeDefined()
  })

  it('narrows a dynamic registration without scopes to safe defaults', async () => {
    prismaMock.oauthClient.update.mockResolvedValue({} as never)
    const returned = {
      client_id: 'default-scope-client',
      scope: 'broader-provider-capabilities',
    }

    await realAuthModule.auth.options.hooks?.after?.({
      path: '/oauth2/register',
      body: {},
      context: { returned },
    } as never)

    expect(prismaMock.oauthClient.update).toHaveBeenCalledWith({
      where: { clientId: 'default-scope-client' },
      data: { scopes: DEFAULT_CLIENT_SCOPES },
    })
    expect(returned.scope).toBe(DEFAULT_CLIENT_SCOPES.join(' '))
  })

  it('retains an explicitly registered destructive scope without widening it', async () => {
    prismaMock.oauthClient.update.mockResolvedValue({} as never)
    const scopes = [...DEFAULT_CLIENT_SCOPES, SPLIIT_SCOPES.expensesDelete]
    const returned = {
      client_id: 'delete-scope-client',
      scope: 'broader-provider-capabilities',
    }

    await realAuthModule.auth.options.hooks?.after?.({
      path: '/oauth2/register',
      body: { scope: scopes.join(' ') },
      context: { returned },
    } as never)

    expect(prismaMock.oauthClient.update).toHaveBeenCalledWith({
      where: { clientId: 'delete-scope-client' },
      data: { scopes },
    })
    expect(returned.scope).toBe(scopes.join(' '))
  })

  it('invalidates cached accounts after Better Auth user updates and deletes', async () => {
    clearAccountCache()
    const account = {
      id: 'acct-hook',
      email: 'alice@example.com',
      emailVerified: false,
      name: 'Alice',
      image: null,
    }
    prismaMock.account.findUnique.mockResolvedValue(account as never)
    await getCachedAccount(account.id)

    await realAuthModule.auth.options.databaseHooks?.user?.update?.after?.({
      id: account.id,
    })
    await getCachedAccount(account.id)
    await realAuthModule.auth.options.databaseHooks?.user?.delete?.after?.({
      id: account.id,
    })
    await getCachedAccount(account.id)

    expect(prismaMock.account.findUnique).toHaveBeenCalledTimes(3)
  })
})

describe('better-auth emailVerification config', () => {
  it('enables autoSignInAfterVerification', () => {
    // Without this flag, /auth/verify-email validates the token and 302s
    // to the callback URL without creating a session, which sends first-time
    // password sign-ups back to the sign-in page instead of profile completion.
    expect(
      realAuthModule.auth.options.emailVerification
        ?.autoSignInAfterVerification,
    ).toBe(true)
  })

  it('charges recipient quota only from the email delivery callback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const sendVerificationEmail =
      realAuthModule.auth.options.emailVerification?.sendVerificationEmail
    expect(sendVerificationEmail).toBeDefined()
    const params = {
      user: {
        id: 'recipient-delivery-limit-account',
        email: 'recipient-delivery-limit@example.test',
      },
      url: 'https://example.test/verify',
    }

    for (let count = 0; count < 10; count += 1) {
      await expect(sendVerificationEmail?.(params)).resolves.toBeUndefined()
    }
    await expect(sendVerificationEmail?.(params)).rejects.toMatchObject({
      status: 'TOO_MANY_REQUESTS',
      body: { code: 'EMAIL_RATE_LIMIT_EXCEEDED' },
    })

    expect(sendEmailMock).toHaveBeenCalledTimes(10)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('auth-email-recipient'),
    )
  })
})

describe('better-auth emailAndPassword config', () => {
  it('configures sendResetPassword so /auth/request-password-reset works', () => {
    // better-auth short-circuits the request-password-reset endpoint with a
    // "RESET_PASSWORD_DISABLED" error when no sendResetPassword callback is
    // configured. The web's forgot-password page would silently do nothing.
    expect(
      typeof realAuthModule.auth.options.emailAndPassword?.sendResetPassword,
    ).toBe('function')
  })

  it('revokes existing sessions on password reset', () => {
    // Sessions revoked on reset means a stolen cookie loses access as soon as
    // the rightful owner resets their password.
    expect(
      realAuthModule.auth.options.emailAndPassword
        ?.revokeSessionsOnPasswordReset,
    ).toBe(true)
  })

  it('configures a before hook for the app password policy', () => {
    expect(typeof realAuthModule.auth.options.hooks?.before).toBe('function')
  })

  it('mentions other linked sign-in methods in password reset emails', async () => {
    prismaMock.authIdentity.findMany.mockResolvedValueOnce([
      { providerId: 'credential' },
      { providerId: 'google' },
      { providerId: 'magic-link' },
    ])

    await realAuthModule.auth.options.emailAndPassword?.sendResetPassword?.({
      user: { id: 'acct-1', email: 'alice@example.com' },
      url: 'https://spliit.test/reset-token',
    })

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'alice@example.com',
        subject: 'Reset your Spliit Cloud password',
        text: expect.stringContaining(
          'This account can also sign in with: Google, email sign-in link.',
        ),
      }),
    )
  })

  it('sends sign-in method guidance instead of reset copy for social-only accounts', async () => {
    prismaMock.authIdentity.findMany.mockResolvedValueOnce([
      { providerId: 'google' },
      { providerId: 'magic-link' },
    ])

    await realAuthModule.auth.options.emailAndPassword?.sendResetPassword?.({
      user: { id: 'acct-1', email: 'alice@example.com' },
      url: 'https://spliit.test/reset-token',
    })

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'alice@example.com',
        subject: 'Sign in to Spliit Cloud',
        text: expect.stringContaining(
          'Use one of these sign-in methods instead: Google, email sign-in link.',
        ),
      }),
    )
  })

  it('uses the OIDC display name for password recovery method labels', async () => {
    prismaMock.authIdentity.findMany.mockResolvedValueOnce([
      { providerId: 'oidc' },
    ])

    await realAuthModule.auth.options.emailAndPassword?.sendResetPassword?.({
      user: { id: 'acct-1', email: 'alice@example.com' },
      url: 'https://spliit.test/reset-token',
    })

    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'alice@example.com',
        subject: 'Sign in to Spliit Cloud',
        text: expect.stringContaining(
          'Use one of these sign-in methods instead: Test SSO.',
        ),
      }),
    )
  })
})

describe('better-auth socialProviders config', () => {
  it('includes GitHub alongside Google in trustedProviders', () => {
    // Account linking joins a new GitHub sign-in to an existing account by
    // email. GitHub must be in the trusted list, otherwise better-auth treats
    // a same-email GitHub identity as a separate user and refuses to link.
    const trusted =
      realAuthModule.auth.options.account?.accountLinking?.trustedProviders ??
      []
    expect(trusted).toContain('github')
    expect(trusted).toContain('google')
    expect(trusted).toContain('twitter')
    expect(trusted).toContain('credential')
    expect(trusted).toContain('magic-link')
  })

  it('does not trust generic OIDC for unverified implicit linking', () => {
    // A matching unverified OIDC email must not take over an existing
    // account. Better Auth still implicit-links untrusted providers when
    // the IdP reports `emailVerified: true`.
    const trusted =
      realAuthModule.auth.options.account?.accountLinking?.trustedProviders ??
      []
    expect(trusted).not.toContain('oidc')
  })

  it('registers generic OIDC when OIDC env is complete', () => {
    const plugin = realAuthModule.auth.options.plugins?.find(
      (candidate) => candidate.id === 'generic-oauth',
    )
    expect(plugin).toBeDefined()
  })

  it('exposes GitHub credentials from env when both are set', () => {
    // The auth test environment is configured with GITHUB_CLIENT_ID and
    // GITHUB_CLIENT_SECRET (see apps/api/.env / scripts/i18n tooling).
    // If those ever get dropped the web's "Continue with GitHub" button
    // would render but the OAuth handshake would 404 — fail loudly here.
    const providers = realAuthModule.auth.options.socialProviders ?? {}
    expect(providers.github).toEqual(
      expect.objectContaining({
        clientId: expect.any(String),
        clientSecret: expect.any(String),
        getUserInfo: expect.any(Function),
      }),
    )
  })

  it('uses the primary verified GitHub email when the profile email is private', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/user')) {
        return Response.json({
          id: 123,
          login: 'octo',
          name: null,
          email: null,
          avatar_url: 'https://github.test/avatar.png',
        })
      }
      return Response.json([
        {
          email: 'private-primary@example.com',
          primary: true,
          verified: true,
          visibility: 'private',
        },
        {
          email: 'secondary@example.com',
          primary: false,
          verified: true,
          visibility: 'private',
        },
      ])
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await realAuthModule.getVerifiedGitHubUserInfo({
      accessToken: 'token-1',
    })

    expect(result?.user).toMatchObject({
      name: 'octo',
      email: 'private-primary@example.com',
      emailVerified: true,
    })
    expect(result?.data).toMatchObject({ id: 123 })
  })

  it('falls back to the first verified GitHub email when the primary email is unverified', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/user')) {
        return Response.json({
          id: 456,
          login: 'mona',
          name: 'Mona',
          email: 'unverified@example.com',
          avatar_url: null,
        })
      }
      return Response.json([
        {
          email: 'unverified@example.com',
          primary: true,
          verified: false,
          visibility: 'private',
        },
        {
          email: 'verified@example.com',
          primary: false,
          verified: true,
          visibility: 'private',
        },
      ])
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await realAuthModule.getVerifiedGitHubUserInfo({
      accessToken: 'token-2',
    })

    expect(result?.user).toMatchObject({
      name: 'Mona',
      email: 'verified@example.com',
      emailVerified: true,
    })
    expect(result?.data).toMatchObject({ id: 456 })
  })

  it('falls back to a synthetic placeholder email when GitHub returns no verified email', async () => {
    // When the user has no verified email on GitHub (private email,
    // missing `user:email` scope, no verified address), we no longer
    // hard-fail the sign-in. Instead we synthesize a placeholder under
    // the reserved `.placeholder.local` domain so the user gets a
    // complete account and can sign in normally via GitHub. Email-only
    // features (magic-link sign-in, password reset, notifications) skip
    // these accounts because their email is a placeholder.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/user')) {
        return Response.json({
          id: 789,
          login: 'no-verified-email',
          name: 'Octocat',
          email: null,
          avatar_url: 'https://github.test/avatar.png',
        })
      }
      return Response.json([
        {
          email: 'unverified@example.com',
          primary: true,
          verified: false,
          visibility: 'private',
        },
      ])
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await realAuthModule.getVerifiedGitHubUserInfo({
      accessToken: 'token-3',
    })

    expect(result?.user).toMatchObject({
      name: 'Octocat',
      email: '789@github.placeholder.local',
      emailVerified: false,
    })
    expect(result?.data).toMatchObject({
      id: 789,
      isPlaceholderEmail: true,
    })
  })

  it('keeps Google as a social provider alongside GitHub', () => {
    const providers = realAuthModule.auth.options.socialProviders ?? {}
    expect(providers.google).toEqual(
      expect.objectContaining({
        clientId: expect.any(String),
        clientSecret: expect.any(String),
      }),
    )
  })

  it('exposes X credentials from env when both are set', () => {
    const providers = realAuthModule.auth.options.socialProviders ?? {}
    expect(providers.twitter).toEqual(
      expect.objectContaining({
        clientId: expect.any(String),
        clientSecret: expect.any(String),
        getUserInfo: expect.any(Function),
      }),
    )
  })

  it('uses the confirmed X email when the profile includes one', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: {
          id: '2244994945',
          name: 'X Dev',
          username: 'xdev',
          profile_image_url: 'https://x.test/avatar.png',
          confirmed_email: 'dev@example.com',
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await realAuthModule.getVerifiedTwitterUserInfo({
      accessToken: 'token-x-1',
    })

    expect(result?.user).toMatchObject({
      name: 'X Dev',
      email: 'dev@example.com',
      emailVerified: true,
    })
    expect(result?.data).toMatchObject({ data: { id: '2244994945' } })
  })

  it('falls back to a synthetic placeholder email when X returns no confirmed email', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        data: {
          id: '12',
          name: 'Jack',
          username: 'jack',
          profile_image_url: null,
        },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await realAuthModule.getVerifiedTwitterUserInfo({
      accessToken: 'token-x-2',
    })

    expect(result?.user).toMatchObject({
      name: 'Jack',
      email: '12@twitter.placeholder.local',
      emailVerified: false,
    })
    expect(result?.data).toMatchObject({
      data: { id: '12' },
      isPlaceholderEmail: true,
    })
  })

  it('returns null when the X profile request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network failure')
      }),
    )

    await expect(
      realAuthModule.getVerifiedTwitterUserInfo({ accessToken: 'token-x-3' }),
    ).resolves.toBeNull()
  })

  it('returns null when the X profile response is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new Error('invalid JSON')
        },
      })),
    )

    await expect(
      realAuthModule.getVerifiedTwitterUserInfo({ accessToken: 'token-x-4' }),
    ).resolves.toBeNull()
  })
})

describe('password change notice after hook', () => {
  afterEach(() => {
    sendEmailMock.mockClear()
    vi.restoreAllMocks()
  })

  it('exists and sends notice on success with { token, user }', async () => {
    const after = realAuthModule.auth.options.hooks?.after
    expect(after).toBeDefined()
    await (after as (ctx: unknown) => Promise<void>)({
      path: '/change-password',
      context: {
        returned: {
          token: 'tok',
          user: { email: 'alice@example.com', id: 'u1' },
        },
        session: { user: { email: 'alice@example.com' } },
      },
    } as never)
    expect(sendEmailMock).toHaveBeenCalledOnce()
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'alice@example.com',
        subject: 'Your Spliit Cloud password was changed',
        text: expect.stringContaining('Other sessions have been signed out'),
      }),
    )
  })

  it('prefers returned user email over session email', async () => {
    const after = realAuthModule.auth.options.hooks!.after!
    await (after as (ctx: unknown) => Promise<void>)({
      path: '/change-password',
      context: {
        returned: { user: { email: 'new@example.com' } },
        session: { user: { email: 'old@example.com' } },
      },
    } as never)
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'new@example.com' }),
    )
  })

  it('falls back to session email when returned has no email', async () => {
    const after = realAuthModule.auth.options.hooks!.after!
    await (after as (ctx: unknown) => Promise<void>)({
      path: '/change-password',
      context: {
        returned: { user: { id: 'u1' } },
        session: { user: { email: 'fallback@example.com' } },
      },
    } as never)
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'fallback@example.com' }),
    )
  })

  it('skips when returned is an APIError', async () => {
    const { APIError } = await import('better-auth/api')
    const after = realAuthModule.auth.options.hooks!.after!
    await (after as (ctx: unknown) => Promise<void>)({
      path: '/change-password',
      context: {
        returned: new APIError('BAD_REQUEST', {
          message: 'Invalid password',
          code: 'INVALID_PASSWORD',
        }),
        session: { user: { email: 'alice@example.com' } },
      },
    } as never)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('skips placeholder emails', async () => {
    const after = realAuthModule.auth.options.hooks!.after!
    await (after as (ctx: unknown) => Promise<void>)({
      path: '/change-password',
      context: {
        returned: { user: { email: '123@github.placeholder.local' } },
        session: null,
      },
    } as never)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('skips non-change-password paths', async () => {
    const after = realAuthModule.auth.options.hooks!.after!
    await (after as (ctx: unknown) => Promise<void>)({
      path: '/sign-in/email',
      context: {
        returned: { user: { email: 'alice@example.com' } },
        session: null,
      },
    } as never)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it('parses a 200 Response clone', async () => {
    const after = realAuthModule.auth.options.hooks!.after!
    const response = new Response(
      JSON.stringify({ user: { email: 'response@example.com' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
    await (after as (ctx: unknown) => Promise<void>)({
      path: '/change-password',
      context: { returned: response, session: null },
    } as never)
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'response@example.com' }),
    )
  })

  it('skips non-200 Response', async () => {
    const after = realAuthModule.auth.options.hooks!.after!
    const response = new Response('error', { status: 400 })
    await (after as (ctx: unknown) => Promise<void>)({
      path: '/change-password',
      context: { returned: response, session: null },
    } as never)
    expect(sendEmailMock).not.toHaveBeenCalled()
  })
})
