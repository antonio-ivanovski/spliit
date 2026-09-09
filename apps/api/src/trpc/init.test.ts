import { beforeEach, describe, expect, it, vi } from 'vitest'

import '../test/mocks'
import { clearAccountCache } from '../lib/auth/account-cache'
import { getApiBaseUrl } from '../lib/auth/urls'
import { generateGroupViewKey } from '../lib/group-view'
import { authState, prismaMock } from '../test/state'
import {
  apiProcedure,
  assertOAuthScope,
  assertScopeForDestructiveEdit,
  assistantProcedure,
  createTRPCContext,
  loadGroupMutationContext,
  loadGroupViewer,
  protectedProcedure,
  scopedGroupReadProcedure,
} from './init'

function makeRequest(): Request {
  return new Request('http://localhost/api/test', {
    headers: new Headers({ cookie: 'spliit.session=test-token' }),
  })
}

beforeEach(() => {
  clearAccountCache()
})

describe('createTRPCContext', () => {
  it('returns null auth when better-auth reports no session', async () => {
    authState.session = null

    const ctx = await createTRPCContext({ req: makeRequest() })

    expect(ctx.auth).toBeNull()
  })

  it('does not derive group credentials from request headers', async () => {
    authState.session = null
    const request = new Request('http://localhost/api/test', {
      headers: {
        'x-spliit-public-view-key': 'ignored',
        'x-spliit-link-invite-token': 'invite-token',
      },
    })

    const ctx = await createTRPCContext({ req: request })

    expect(ctx).not.toHaveProperty('publicGroupViewKey')
    expect(ctx).not.toHaveProperty('groupLinkInviteToken')
  })

  it('returns the resolved auth when the session is valid', async () => {
    authState.session = {
      user: { id: 'acct-1' },
      session: { id: 'sess-1' },
    }
    const refreshedAccount = {
      id: 'acct-1',
      email: 'alice@example.com',
      emailVerified: true,
      name: 'Alice',
    }
    prismaMock.account.findUnique.mockResolvedValue(refreshedAccount)

    const ctx = await createTRPCContext({ req: makeRequest() })

    expect(ctx.auth).not.toBeNull()
    expect(ctx.auth?.user).toMatchObject(refreshedAccount)
    expect(ctx.auth?.user.anonymousOnboardingCompleted).toBe(true)
  })
})

describe('protectedProcedure', () => {
  // Build a tiny test-only procedure whose handler returns the auth context.
  // This exercises the real protectedProcedure middleware wiring.
  const probe = protectedProcedure.query(({ ctx }) => ({
    authUserId: ctx.auth.user.id,
  }))

  async function callProbe(ctx: Awaited<ReturnType<typeof createTRPCContext>>) {
    return probe({
      ctx,
      type: 'query',
      path: 'probe',
      getRawInput: async () => undefined,
      meta: undefined,
      signal: undefined,
    } as never)
  }

  it('rejects unauthenticated callers with UNAUTHORIZED', async () => {
    authState.session = null
    const ctx = await createTRPCContext({ req: makeRequest() })

    await expect(callProbe(ctx)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })

  it('returns the authenticated account through the resolved context', async () => {
    authState.session = {
      user: { id: 'acct-1' },
      session: { id: 'sess-1' },
    }
    const refreshedAccount = {
      id: 'acct-1',
      email: 'alice@example.com',
      emailVerified: true,
      name: 'Alice',
    }
    prismaMock.account.findUnique.mockResolvedValue(refreshedAccount)
    const ctx = await createTRPCContext({ req: makeRequest() })

    const result = await callProbe(ctx)

    expect(result).toEqual({ authUserId: 'acct-1' })
    expect(ctx.auth).not.toBeNull()
    expect(prismaMock.account.findUnique).toHaveBeenCalledWith({
      where: { id: 'acct-1' },
    })
  })

  it('blocks an anonymous account until its recovery key is acknowledged', async () => {
    authState.session = {
      user: { id: 'anonymous-1' },
      session: { id: 'sess-anonymous' },
    }
    prismaMock.account.findUnique.mockResolvedValue({
      id: 'anonymous-1',
      email: 'guest@test.anonymous.placeholder.local',
      emailVerified: false,
      isAnonymous: true,
      name: 'Anonymous',
    } as never)
    prismaMock.anonymousRecoveryCredential.findUnique.mockResolvedValue(null)
    const ctx = await createTRPCContext({ req: makeRequest() })

    await expect(callProbe(ctx)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'ANONYMOUS_SETUP_REQUIRED',
    })
  })

  it('allows an anonymous account after recovery onboarding completes', async () => {
    authState.session = {
      user: { id: 'anonymous-2' },
      session: { id: 'sess-anonymous-2' },
    }
    prismaMock.account.findUnique.mockResolvedValue({
      id: 'anonymous-2',
      email: 'guest2@test.anonymous.placeholder.local',
      emailVerified: false,
      isAnonymous: true,
      name: 'Guest name',
    } as never)
    prismaMock.anonymousRecoveryCredential.findUnique.mockResolvedValue({
      acknowledgedAt: new Date(),
      onboardingCompletedAt: new Date(),
    } as never)
    const ctx = await createTRPCContext({ req: makeRequest() })

    await expect(callProbe(ctx)).resolves.toEqual({ authUserId: 'anonymous-2' })
  })

  it('does not accept OAuth bearer credentials on existing procedures', async () => {
    await expect(
      callProbe({
        auth: {
          credentialKind: 'oauth',
          accessToken: 'redacted',
          scopes: ['spliit:groups:read'],
          user: { id: 'acct-1' },
          session: { id: 'oauth-session' },
        } as never,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('limits authenticated mutations per account and returns Retry-After', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const resHeaders = new Headers()
    const mutation = protectedProcedure.mutation(() => 'ok')
    const ctx = {
      auth: {
        session: { id: 'mutation-limit-session' },
        user: {
          id: 'mutation-limit-account',
          email: 'mutation-limit@example.test',
          emailVerified: true,
          name: 'Mutation Limit',
        },
      },
      resHeaders,
    }
    const callMutation = () =>
      mutation({
        ctx,
        type: 'mutation',
        path: 'mutationProbe',
        getRawInput: async () => undefined,
        meta: undefined,
        signal: undefined,
      } as never)

    for (let count = 0; count < 120; count += 1) {
      await expect(callMutation()).resolves.toBe('ok')
    }
    await expect(callMutation()).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    })

    expect(Number(resHeaders.get('Retry-After'))).toBeGreaterThan(0)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('authenticated-mutation'),
    )
  })
})

describe('assistantProcedure', () => {
  const probe = assistantProcedure('spliit:groups:read').query(({ ctx }) => ({
    accountId: ctx.auth.user.id,
  }))

  function callProbe(auth: Record<string, unknown>) {
    return probe({
      ctx: { auth },
      type: 'query',
      path: 'assistantProbe',
      getRawInput: async () => undefined,
      meta: undefined,
      signal: undefined,
    } as never)
  }

  it('requires an OAuth credential with the requested scope', async () => {
    await expect(
      callProbe({
        credentialKind: 'oauth',
        accessToken: 'redacted',
        scopes: [],
        user: { id: 'acct-1' },
        session: { id: 'oauth-session' },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('accepts the verified OAuth account, not host identity metadata', async () => {
    await expect(
      callProbe({
        credentialKind: 'oauth',
        accessToken: 'redacted',
        scopes: ['spliit:groups:read'],
        user: { id: 'verified-spliit-account' },
        session: { id: 'oauth-session' },
      }),
    ).resolves.toEqual({ accountId: 'verified-spliit-account' })
  })

  it('blocks an OAuth account whose anonymous setup is incomplete', async () => {
    await expect(
      callProbe({
        credentialKind: 'oauth',
        accessToken: 'redacted',
        scopes: ['spliit:groups:read'],
        user: {
          id: 'anonymous-oauth-assistant',
          isAnonymous: true,
          anonymousOnboardingCompleted: false,
        },
        session: { id: 'oauth-session' },
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'ANONYMOUS_SETUP_REQUIRED',
    })
  })
})

describe('apiProcedure', () => {
  const probe = apiProcedure('spliit:expenses:read').query(({ ctx }) => ({
    accountId: ctx.auth.user.id,
  }))

  function callProbe(auth: Record<string, unknown> | null) {
    return probe({
      ctx: { auth },
      type: 'query',
      path: 'apiProbe',
      getRawInput: async () => undefined,
      meta: undefined,
      signal: undefined,
    } as never)
  }

  function oauthAuth(scopes: string[], audiences = [getApiBaseUrl()]) {
    return {
      credentialKind: 'oauth',
      accessToken: 'redacted',
      scopes,
      audiences,
      user: { id: 'acct-oauth' },
      session: { id: 'oauth-session' },
    }
  }

  it('rejects an unauthenticated caller', async () => {
    await expect(callProbe(null)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })

  it('rejects a token minted for the MCP resource only', async () => {
    // The MCP hop forwards its callers' bearer tokens to the assistant
    // surface. RFC 8707 audience separation means that same token must never
    // double as a credential for the direct API.
    await expect(
      callProbe(
        oauthAuth(['spliit:expenses:read'], ['http://localhost:3002/mcp']),
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('rejects a forged OAuth auth carrying no audience list', async () => {
    const { audiences: _dropped, ...withoutAudiences } = oauthAuth([
      'spliit:expenses:read',
    ])
    await expect(callProbe(withoutAudiences)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    })
  })

  it('accepts a token whose audience list includes the API among others', async () => {
    await expect(
      callProbe(
        oauthAuth(
          ['spliit:expenses:read'],
          [getApiBaseUrl(), 'http://localhost:3002/mcp'],
        ),
      ),
    ).resolves.toEqual({ accountId: 'acct-oauth' })
  })

  it('accepts a signed-in session without any scope', async () => {
    await expect(
      callProbe({ user: { id: 'acct-session' }, session: { id: 'sess-1' } }),
    ).resolves.toEqual({ accountId: 'acct-session' })
  })

  it('accepts an OAuth token carrying the required scope', async () => {
    await expect(
      callProbe(oauthAuth(['spliit:expenses:read'])),
    ).resolves.toEqual({ accountId: 'acct-oauth' })
  })

  it('rejects an OAuth token missing the required scope', async () => {
    await expect(
      callProbe(oauthAuth(['spliit:groups:read'])),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('refuses a live assistant grant', async () => {
    // `spliit:expenses:write` was published for the assistant's preview and
    // confirmation flow. Honouring it here would hand every existing grant a
    // direct write its holder never consented to.
    await expect(
      callProbe(oauthAuth(['spliit:groups:read', 'spliit:expenses:write'])),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('accepts the manage scope, which implies read on the same resource', async () => {
    await expect(
      callProbe(oauthAuth(['spliit:expenses:manage'])),
    ).resolves.toEqual({ accountId: 'acct-oauth' })
  })

  it('rejects an OAuth token with no scopes at all', async () => {
    await expect(callProbe(oauthAuth([]))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('still gates a session whose anonymous setup is incomplete', async () => {
    await expect(
      callProbe({
        user: {
          id: 'anonymous-1',
          isAnonymous: true,
          anonymousOnboardingCompleted: false,
        },
        session: { id: 'sess-anon' },
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'ANONYMOUS_SETUP_REQUIRED',
    })
  })

  it('gates an OAuth token whose anonymous setup is incomplete', async () => {
    await expect(
      callProbe({
        ...oauthAuth(['spliit:expenses:read']),
        user: {
          id: 'anonymous-oauth-api',
          isAnonymous: true,
          anonymousOnboardingCompleted: false,
        },
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'ANONYMOUS_SETUP_REQUIRED',
    })
  })
})

describe('token rate limits', () => {
  const mutate = apiProcedure('spliit:expenses:manage').mutation(({ ctx }) => ({
    accountId: ctx.auth.user.id,
  }))

  function callMutation(accountId: string) {
    return mutate({
      ctx: {
        auth: {
          credentialKind: 'oauth',
          accessToken: 'redacted',
          scopes: ['spliit:expenses:manage'],
          audiences: [getApiBaseUrl()],
          user: { id: accountId },
          session: { id: 'oauth-session' },
        },
      },
      type: 'mutation',
      path: 'rateProbe',
      getRawInput: async () => undefined,
      meta: undefined,
      signal: undefined,
    } as never)
  }

  it('caps token mutations at the same rate as the account own sessions', async () => {
    // 120/min is the session cap. A token must not get a looser bucket, or a
    // leaked one could out-mutate the account it acts for.
    const accountId = `acct-rate-${Math.random()}`
    for (let i = 0; i < 120; i++) {
      await expect(callMutation(accountId)).resolves.toEqual({ accountId })
    }

    await expect(callMutation(accountId)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    })
  })
})

describe('scopedGroupReadProcedure', () => {
  const probe = scopedGroupReadProcedure('spliit:expenses:read').query(
    ({ ctx }) => ({ accountId: ctx.auth?.user.id ?? null }),
  )

  function callProbe(auth: Record<string, unknown> | null) {
    return probe({
      ctx: { auth },
      type: 'query',
      path: 'groupReadProbe',
      getRawInput: async () => undefined,
      meta: undefined,
      signal: undefined,
    } as never)
  }

  function oauthAuth(scopes: string[], audiences = [getApiBaseUrl()]) {
    return {
      credentialKind: 'oauth',
      accessToken: 'redacted',
      scopes,
      audiences,
      user: { id: 'acct-oauth' },
      session: { id: 'oauth-session' },
    }
  }

  it('rejects a token minted for the MCP resource only', async () => {
    await expect(
      callProbe(
        oauthAuth(['spliit:expenses:read'], ['http://localhost:3002/mcp']),
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('still allows an unauthenticated view-key caller through', async () => {
    // `viewKey` and `linkInviteToken` holders carry no credential; the
    // resolver authorises them via loadGroupViewer.
    await expect(callProbe(null)).resolves.toEqual({ accountId: null })
  })

  it('still allows a signed-in session through', async () => {
    await expect(
      callProbe({ user: { id: 'acct-session' }, session: { id: 'sess-1' } }),
    ).resolves.toEqual({ accountId: 'acct-session' })
  })

  it('accepts an OAuth token carrying the required scope', async () => {
    await expect(
      callProbe(oauthAuth(['spliit:expenses:read'])),
    ).resolves.toEqual({ accountId: 'acct-oauth' })
  })

  it('rejects an OAuth token missing the required scope', async () => {
    await expect(
      callProbe(oauthAuth(['spliit:groups:read'])),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('refuses a live assistant grant', async () => {
    await expect(
      callProbe(oauthAuth(['spliit:expenses:write'])),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('accepts the manage scope, which implies read on the same resource', async () => {
    await expect(
      callProbe(oauthAuth(['spliit:expenses:manage'])),
    ).resolves.toEqual({ accountId: 'acct-oauth' })
  })

  it('still gates a session whose anonymous setup is incomplete', async () => {
    await expect(
      callProbe({
        user: {
          id: 'anonymous-1',
          isAnonymous: true,
          anonymousOnboardingCompleted: false,
        },
        session: { id: 'sess-anon' },
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'ANONYMOUS_SETUP_REQUIRED',
    })
  })

  it('gates an OAuth token whose anonymous setup is incomplete', async () => {
    await expect(
      callProbe({
        ...oauthAuth(['spliit:expenses:read']),
        user: {
          id: 'anonymous-oauth-group-read',
          isAnonymous: true,
          anonymousOnboardingCompleted: false,
        },
      }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'ANONYMOUS_SETUP_REQUIRED',
    })
  })
})

describe('assertScopeForDestructiveEdit', () => {
  function oauth(scopes: string[]) {
    return {
      credentialKind: 'oauth',
      accessToken: 'redacted',
      scopes,
      user: { id: 'acct-oauth' },
      session: { id: 'oauth-session' },
    } as never
  }

  it('lets a session through untouched', () => {
    // Scopes constrain tokens; a signed-in member is bound by group role
    // rules instead.
    expect(() =>
      assertScopeForDestructiveEdit({
        user: { id: 'acct-session' },
        session: { id: 'sess-1' },
      } as never),
    ).not.toThrow()
  })

  it('refuses a token holding only the manage scope', () => {
    // Shortening a series drops occurrences and their stored documents, so
    // the manage scope alone must not reach it.
    expect(() =>
      assertScopeForDestructiveEdit(oauth(['spliit:expenses:manage'])),
    ).toThrow(/spliit:expenses:delete/)
  })

  it('accepts a token holding the delete scope', () => {
    expect(() =>
      assertScopeForDestructiveEdit(
        oauth(['spliit:expenses:manage', 'spliit:expenses:delete']),
      ),
    ).not.toThrow()
  })
})

describe('assertOAuthScope', () => {
  it('keeps additional resource scopes separate for OAuth callers', () => {
    expect(() =>
      assertOAuthScope(
        {
          credentialKind: 'oauth',
          accessToken: 'redacted',
          scopes: ['spliit:groups:delete'],
          user: { id: 'acct-oauth' },
          session: { id: 'oauth-session' },
        } as never,
        'spliit:expenses:manage',
      ),
    ).toThrow(/spliit:expenses:manage/)
  })

  it('does not impose token scopes on a browser session', () => {
    expect(() =>
      assertOAuthScope(
        {
          user: { id: 'acct-session' },
          session: { id: 'session' },
        } as never,
        'spliit:expenses:manage',
      ),
    ).not.toThrow()
  })
})

describe('loadGroupMutationContext', () => {
  const groupId = 'grp-1'
  const accountId = 'acct-1'

  it('throws NOT_FOUND when the group does not exist', async () => {
    prismaMock.group.findUnique.mockResolvedValue(null)
    prismaMock.groupMember.findUnique.mockResolvedValue(null)

    await expect(
      loadGroupMutationContext({ groupId, accountId }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('throws FORBIDDEN when the account is not a member of the group', async () => {
    prismaMock.group.findUnique.mockResolvedValue({
      id: groupId,
      ledgerId: 'ledger-1',
      ledger: { id: 'ledger-1' },
    } as never)
    prismaMock.groupMember.findUnique.mockResolvedValue(null)

    await expect(
      loadGroupMutationContext({ groupId, accountId }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('throws FORBIDDEN when the membership status is not ACTIVE', async () => {
    prismaMock.group.findUnique.mockResolvedValue({
      id: groupId,
      ledgerId: 'ledger-1',
      ledger: { id: 'ledger-1' },
    } as never)
    prismaMock.groupMember.findUnique.mockResolvedValue({
      groupId,
      accountId,
      role: 'MEMBER',
      status: 'LEFT',
    } as never)

    await expect(
      loadGroupMutationContext({ groupId, accountId }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('returns the group, member, and ledger for an ACTIVE member', async () => {
    const group = {
      id: groupId,
      ledgerId: 'ledger-1',
      ledger: { id: 'ledger-1', currency: '$', currencyCode: 'USD' },
    }
    const member = { groupId, accountId, role: 'ADMIN', status: 'ACTIVE' }
    prismaMock.group.findUnique.mockResolvedValue(group as never)
    prismaMock.groupMember.findUnique.mockResolvedValue(member as never)

    const result = await loadGroupMutationContext({ groupId, accountId })

    expect(result.group).toEqual(group)
    expect(result.member).toEqual(member)
    expect(result.ledger).toEqual(group.ledger)
  })
})

describe('loadGroupViewer', () => {
  const groupId = 'grp-1'
  const accountId = 'acct-1'
  const accountEmail = 'alice@example.com'

  it('returns NOT_FOUND when the canonical group id does not exist', async () => {
    prismaMock.group.findUnique.mockResolvedValue(null)
    prismaMock.groupMember.findUnique.mockResolvedValue(null)

    await expect(
      loadGroupViewer({ groupId, accountId, accountEmail }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('returns an ACTIVE viewer with member and ledger for an ACTIVE member', async () => {
    const group = {
      id: groupId,
      ledgerId: 'ledger-1',
      ledger: { id: 'ledger-1', currency: '$', currencyCode: 'USD' },
    }
    const member = { groupId, accountId, role: 'ADMIN', status: 'ACTIVE' }
    prismaMock.group.findUnique.mockResolvedValue(group as never)
    prismaMock.groupMember.findUnique.mockResolvedValue(member as never)

    const result = await loadGroupViewer({ groupId, accountId, accountEmail })

    expect(result.group).toEqual(group)
    expect(result.member).toEqual(member)
    expect(result.ledger).toEqual(group.ledger)
    expect(result.viewer).toEqual({
      kind: 'ACTIVE',
      access: 'READ_WRITE',
    })
  })

  it('returns a PENDING_INVITEE viewer when a PENDING invitation matches the account email', async () => {
    const group = {
      id: groupId,
      ledgerId: 'ledger-1',
      ledger: { id: 'ledger-1', currency: '$', currencyCode: 'USD' },
    }
    prismaMock.group.findUnique.mockResolvedValue(group as never)
    prismaMock.groupMember.findUnique.mockResolvedValue(null)
    prismaMock.groupInvitation.findFirst.mockResolvedValue({
      id: 'inv-1',
      role: 'MEMBER',
      type: 'EMAIL',
    } as never)

    const result = await loadGroupViewer({ groupId, accountId, accountEmail })

    expect(result.member).toBeNull()
    expect(result.ledger).toEqual(group.ledger)
    expect(result.viewer).toEqual({
      kind: 'PENDING_INVITEE',
      access: 'READ_ONLY',
      invitation: { id: 'inv-1', role: 'MEMBER', type: 'EMAIL' },
    })
  })

  it('falls back to a PENDING invitation when the account membership is not ACTIVE', async () => {
    const group = {
      id: groupId,
      ledgerId: 'ledger-1',
      ledger: { id: 'ledger-1', currency: '$', currencyCode: 'USD' },
    }
    prismaMock.group.findUnique.mockResolvedValue(group as never)
    prismaMock.groupMember.findUnique.mockResolvedValue({
      groupId,
      accountId,
      role: 'MEMBER',
      status: 'PENDING',
    } as never)
    prismaMock.groupInvitation.findFirst.mockResolvedValue({
      id: 'inv-2',
      role: 'ADMIN',
      type: 'EMAIL',
    } as never)

    const result = await loadGroupViewer({ groupId, accountId, accountEmail })

    expect(result.member).toBeNull()
    expect(result.viewer).toEqual({
      kind: 'PENDING_INVITEE',
      access: 'READ_ONLY',
      invitation: { id: 'inv-2', role: 'ADMIN', type: 'EMAIL' },
    })
  })

  it('accepts a matching public view key on a regular group', async () => {
    const viewKey = generateGroupViewKey()
    prismaMock.group.findUnique.mockResolvedValue({
      id: groupId,
      groupType: 'GROUP',
      publicViewKey: viewKey,
      ledger: { id: 'ledger-1' },
    } as never)
    prismaMock.groupMember.findUnique.mockResolvedValue(null)

    await expect(loadGroupViewer({ groupId, viewKey })).resolves.toMatchObject({
      viewer: { kind: 'PUBLIC_VIEW', access: 'READ_ONLY' },
    })

    await expect(
      loadGroupViewer({ groupId, viewKey: generateGroupViewKey() }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })

    prismaMock.group.findUnique.mockResolvedValue({
      id: groupId,
      groupType: 'FRIEND',
      publicViewKey: viewKey,
      ledger: { id: 'ledger-1' },
    } as never)
    await expect(loadGroupViewer({ groupId, viewKey })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })

  it('throws FORBIDDEN when there is no ACTIVE member and no matching PENDING invitation', async () => {
    prismaMock.group.findUnique.mockResolvedValue({
      id: groupId,
      ledgerId: 'ledger-1',
      ledger: { id: 'ledger-1' },
    } as never)
    prismaMock.groupMember.findUnique.mockResolvedValue(null)
    prismaMock.groupInvitation.findFirst.mockResolvedValue(null)

    await expect(
      loadGroupViewer({ groupId, accountId, accountEmail }),
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
    })
  })
})
