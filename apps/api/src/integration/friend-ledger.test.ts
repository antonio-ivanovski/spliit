import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  GroupInvitationStatus,
  GroupInvitationType,
  GroupMemberStatus,
  GroupRole,
  GroupType,
  prisma,
} from '@spliit/db'

import { autoAcceptPendingFriendInvitationsForAccount } from '../lib/api/friends'
import { getApiBaseUrl } from '../lib/auth/urls'
import { accountRouter } from '../trpc/routers/account'
import { friendsRouter } from '../trpc/routers/friends'
import { groupsRouter } from '../trpc/routers/groups'
import { invitationsRouter } from '../trpc/routers/invitations'
import { cleanupMaildevInbox } from './maildev-client'
import { checkDbConnection, testRunId } from './setup'

await checkDbConnection()

/**
 * Friend-ledger API tests against a real PostgreSQL database.
 *
 * Covers: - `friends.create` direct-accept path (peer is a known account) -
 * `friends.create` direct-accept via email of an existing account -
 * `friends.create` pending email path (peer is unknown) - `friends.create`
 * pending link path - Lookup-or-create idempotency - Auto-accept on signup
 * (Better Auth `databaseHooks.user.create.after`) - Auto-accept on link-open
 * (`groups.get` link-token branch) - `invitations.listForAccount` filtering -
 * Restricted actions on FRIEND-typed groups - `account.groups` displayName +
 * groupType - `account.friends` hasFriendLedger - `invitations.previewLink`
 * FRIEND-aware display name - Migration data verification (preference cleanup)
 */
describe('Friend ledger — real DB', () => {
  const runId = testRunId()
  const callerId = `acct-caller-${runId}`
  const callerEmail = `caller-${runId}@test.example`
  const peerId = `acct-peer-${runId}`
  const peerEmail = `peer-${runId}@test.example`
  const thirdId = `acct-third-${runId}`
  const thirdEmail = `third-${runId}@test.example`

  const ledgerIds: string[] = []
  function trackLedger(id: string) {
    ledgerIds.push(id)
  }

  // Every address this suite may deliver to; swept in afterAll so the
  // persistent MailDev store stays bounded. Keep in sync with new recipients.
  const mailRecipients = [
    callerEmail,
    peerEmail,
    thirdEmail,
    `pending-${runId}@unknown.example`,
    `invitee-${runId}@example.test`,
    ...[
      'a',
      'b',
      'autosignup',
      'linkrecv',
      'crud-a',
      'crud-b',
      'bal-a',
      'bal-b',
      'cd-a',
      'cd-new',
      'race',
      'dup-a',
      'dup-b',
      'pending-dn',
      'pending-dn2',
    ].map((prefix) => `${prefix}-${runId}@test.example`),
  ]
  const trackedGroupIds: string[] = []
  function trackGroup(id: string) {
    trackedGroupIds.push(id)
  }

  function makeCaller(overrides?: {
    accountId?: string
    email?: string
    name?: string
  }) {
    return friendsRouter.createCaller({
      auth: {
        session: { id: 'sess-test' },
        user: {
          id: overrides?.accountId ?? callerId,
          email: overrides?.email ?? callerEmail,
          emailVerified: true,
          name: overrides?.name ?? 'Test Caller',
        },
      },
    } as never)
  }

  function makeAccountCaller(overrides?: {
    accountId?: string
    email?: string
    name?: string
  }) {
    return accountRouter.createCaller({
      auth: {
        session: { id: 'sess-test' },
        user: {
          id: overrides?.accountId ?? callerId,
          email: overrides?.email ?? callerEmail,
          emailVerified: true,
          name: overrides?.name ?? 'Test Caller',
        },
      },
    } as never)
  }

  function makeGroupsCaller(overrides?: {
    accountId?: string
    email?: string
    name?: string
  }) {
    return groupsRouter.createCaller({
      auth: {
        session: { id: 'sess-test' },
        user: {
          id: overrides?.accountId ?? callerId,
          email: overrides?.email ?? callerEmail,
          emailVerified: true,
          name: overrides?.name ?? 'Test Caller',
        },
      },
    } as never)
  }

  function makeInvitationsCaller(overrides?: {
    accountId?: string
    email?: string
    name?: string
  }) {
    return invitationsRouter.createCaller({
      auth: {
        session: { id: 'sess-test' },
        user: {
          id: overrides?.accountId ?? callerId,
          email: overrides?.email ?? callerEmail,
          emailVerified: true,
          name: overrides?.name ?? 'Test Caller',
        },
      },
    } as never)
  }

  beforeAll(async () => {
    for (const [id, email, name] of [
      [callerId, callerEmail, 'Test Caller'],
      [peerId, peerEmail, 'Test Peer'],
      [thirdId, thirdEmail, 'Test Third'],
    ] as const) {
      await prisma.account.upsert({
        where: { email },
        update: {},
        create: {
          id,
          email,
          emailVerified: true,
          name,
        },
      })
    }
  })

  afterAll(async () => {
    // Friend groups + their ledgers (delete group cascades to ledger + members + invitations)
    for (const gid of trackedGroupIds) {
      await prisma.group.delete({ where: { id: gid } }).catch(() => {})
    }
    for (const lid of ledgerIds) {
      await prisma.ledger.delete({ where: { id: lid } }).catch(() => {})
    }
    // Wipe any untracked groups/ledgers created by this test file by account id
    const myGroupIds = await prisma.group
      .findMany({
        where: {
          members: { some: { accountId: { in: [callerId, peerId, thirdId] } } },
        },
        select: { id: true },
      })
      .then((rows) => rows.map((r) => r.id))
    for (const gid of myGroupIds) {
      await prisma.group.delete({ where: { id: gid } }).catch(() => {})
    }
    for (const aid of [callerId, peerId, thirdId]) {
      await prisma.account.delete({ where: { id: aid } }).catch(() => {})
    }

    await cleanupMaildevInbox(mailRecipients)
  })

  // ───────────────────────────────────────────────────────────────────
  // 13.1: friends.create direct-accept with a known account
  // ───────────────────────────────────────────────────────────────────
  it('direct-accept: creates friend ledger with two ADMIN/ACTIVE members and friendPairKey', async () => {
    const result = await makeCaller().create({
      requestId: crypto.randomUUID(),
      friendFormValues: {
        peerAccountId: peerId,
        currency: '€',
        currencyCode: 'EUR',
      },
    })

    expect(result.existed).toBe(false)
    expect(result.groupId).toBeTruthy()
    trackGroup(result.groupId)

    const group = await prisma.group.findUnique({
      where: { id: result.groupId },
    })
    expect(group).not.toBeNull()
    expect(group!.groupType).toBe(GroupType.FRIEND)
    // Group.name for FRIEND is randomId() (hex string, no dashes). Never
    // shown to users — displayName is computed per-viewer instead.
    expect(group!.name).toMatch(/^[a-f0-9]{32}$/)
    expect(group!.friendPairKey).not.toBeNull()
    // Friend pair key is normalized smaller-id-first
    const [smaller, larger] = [callerId, peerId].sort()
    expect(group!.friendPairKey).toBe(`${smaller}:${larger}`)

    const members = await prisma.groupMember.findMany({
      where: { groupId: result.groupId },
    })
    expect(members).toHaveLength(2)
    for (const m of members) {
      expect(m.role).toBe(GroupRole.ADMIN)
      expect(m.status).toBe(GroupMemberStatus.ACTIVE)
    }
    expect(members.map((m) => m.accountId).sort()).toEqual(
      [callerId, peerId].sort(),
    )

    // Both members have a LedgerParticipant
    const participants = await prisma.ledgerParticipant.findMany({
      where: { ledger: { group: { id: result.groupId } } },
    })
    expect(participants).toHaveLength(2)

    // No invitation row
    const invites = await prisma.groupInvitation.findMany({
      where: { groupId: result.groupId },
    })
    expect(invites).toHaveLength(0)
  })

  // ───────────────────────────────────────────────────────────────────
  // 13.2: direct-accept via email of an existing account
  // ───────────────────────────────────────────────────────────────────
  it('direct-accept via email: resolves existing accountId, no invitation row', async () => {
    const result = await makeCaller().create({
      requestId: crypto.randomUUID(),
      friendFormValues: {
        peerEmail: thirdEmail,
        currency: '$',
        currencyCode: 'USD',
      },
    })

    expect(result.existed).toBe(false)
    expect(result.groupId).toBeTruthy()
    trackGroup(result.groupId)

    const group = await prisma.group.findUnique({
      where: { id: result.groupId },
    })
    expect(group!.groupType).toBe(GroupType.FRIEND)
    expect(group!.friendPairKey).not.toBeNull()

    // No invitation row — direct accept path
    const invites = await prisma.groupInvitation.findMany({
      where: { groupId: result.groupId },
    })
    expect(invites).toHaveLength(0)

    const members = await prisma.groupMember.findMany({
      where: { groupId: result.groupId },
    })
    expect(members).toHaveLength(2)
    expect(members.map((m) => m.accountId).sort()).toEqual(
      [callerId, thirdId].sort(),
    )
  })

  // ───────────────────────────────────────────────────────────────────
  // 13.3: pending email path
  // ───────────────────────────────────────────────────────────────────
  it('pending email: creates group with caller only, PENDING EMAIL invitation, no friendPairKey', async () => {
    const pendingEmail = `pending-${runId}@unknown.example`

    const result = await makeCaller().create({
      requestId: crypto.randomUUID(),
      friendFormValues: {
        peerEmail: pendingEmail,
        temporaryName: 'Pending Friend',
        currency: '£',
        currencyCode: 'GBP',
      },
    })

    expect(result.existed).toBe(false)
    expect(result.groupId).toBeTruthy()
    expect(result.invitationId).toBeTruthy()
    trackGroup(result.groupId)

    const group = await prisma.group.findUnique({
      where: { id: result.groupId },
    })
    expect(group!.groupType).toBe(GroupType.FRIEND)
    expect(group!.friendPairKey).toBeNull()

    const members = await prisma.groupMember.findMany({
      where: { groupId: result.groupId },
    })
    expect(members).toHaveLength(1)
    expect(members[0]!.accountId).toBe(callerId)
    expect(members[0]!.role).toBe(GroupRole.ADMIN)
    expect(members[0]!.status).toBe(GroupMemberStatus.ACTIVE)

    const invitation = await prisma.groupInvitation.findUnique({
      where: { id: result.invitationId! },
    })
    expect(invitation).not.toBeNull()
    expect(invitation!.type).toBe(GroupInvitationType.EMAIL)
    expect(invitation!.status).toBe(GroupInvitationStatus.PENDING)
    expect(invitation!.email).toBe(pendingEmail)
    expect(invitation!.role).toBe(GroupRole.ADMIN)
    expect(invitation!.temporaryName).toBe('Pending Friend')
    expect(invitation!.invitedById).toBe(callerId)
  })

  // ───────────────────────────────────────────────────────────────────
  // 13.4: pending link path
  // ───────────────────────────────────────────────────────────────────
  it('pending link: creates group with caller only, PENDING LINK invitation, returns inviteUrl', async () => {
    const result = await makeCaller().create({
      requestId: crypto.randomUUID(),
      friendFormValues: {
        useLink: true,
        temporaryName: 'Link Friend',
        currency: '$',
        currencyCode: 'USD',
      },
    })

    expect(result.existed).toBe(false)
    expect(result.groupId).toBeTruthy()
    expect(result.inviteUrl).toBeTruthy()
    expect(result.token).toBeTruthy()
    expect(result.inviteUrl).toContain(result.token!)
    trackGroup(result.groupId)

    const group = await prisma.group.findUnique({
      where: { id: result.groupId },
    })
    expect(group!.groupType).toBe(GroupType.FRIEND)
    expect(group!.friendPairKey).toBeNull()

    const members = await prisma.groupMember.findMany({
      where: { groupId: result.groupId },
    })
    expect(members).toHaveLength(1)
    expect(members[0]!.accountId).toBe(callerId)

    const invitation = await prisma.groupInvitation.findFirst({
      where: { groupId: result.groupId, type: GroupInvitationType.LINK },
    })
    expect(invitation).not.toBeNull()
    expect(invitation!.status).toBe(GroupInvitationStatus.PENDING)
    expect(invitation!.temporaryName).toBe('Link Friend')
  })

  // ───────────────────────────────────────────────────────────────────
  // 13.5: lookup-or-create idempotency
  // ───────────────────────────────────────────────────────────────────
  it('idempotency: a second direct-accept with the same pair returns existed:true', async () => {
    // Set up a fresh pair so we don't disturb other tests
    const aId = `acct-a-${runId}`
    const aEmail = `a-${runId}@test.example`
    const bId = `acct-b-${runId}`
    const bEmail = `b-${runId}@test.example`
    await prisma.account.createMany({
      data: [
        { id: aId, email: aEmail, emailVerified: true, name: 'A' },
        { id: bId, email: bEmail, emailVerified: true, name: 'B' },
      ],
    })

    try {
      const first = await makeCaller({
        accountId: aId,
        email: aEmail,
        name: 'A',
      }).create({
        requestId: crypto.randomUUID(),
        friendFormValues: {
          peerAccountId: bId,
          currency: '$',
          currencyCode: 'USD',
        },
      })
      expect(first.existed).toBe(false)
      trackGroup(first.groupId)

      const second = await makeCaller({
        accountId: aId,
        email: aEmail,
        name: 'A',
      }).create({
        requestId: crypto.randomUUID(),
        friendFormValues: {
          peerAccountId: bId,
          currency: '$',
          currencyCode: 'USD',
        },
      })
      expect(second.existed).toBe(true)
      expect(second.groupId).toBe(first.groupId)
    } finally {
      await prisma.account.delete({ where: { id: aId } }).catch(() => {})
      await prisma.account.delete({ where: { id: bId } }).catch(() => {})
    }
  })

  // ───────────────────────────────────────────────────────────────────
  // 13.6: auto-accept on signup (Better Auth `databaseHooks.user.create.after`)
  // ───────────────────────────────────────────────────────────────────
  it('auto-accept on signup: pending FRIEND email invitation is reconciled for a new matching account', async () => {
    const newEmail = `autosignup-${runId}@test.example`

    // Create a pending FRIEND email invitation
    const created = await makeCaller().create({
      requestId: crypto.randomUUID(),
      friendFormValues: {
        peerEmail: newEmail,
        temporaryName: 'Auto-Accept Friend',
        currency: '$',
        currencyCode: 'USD',
      },
    })
    trackGroup(created.groupId)
    const invitationId = created.invitationId!

    // Simulate the Better Auth `databaseHooks.user.create.after` call.
    // In production this is invoked automatically when the user signs up
    // and the account row is created. Here we create the account then
    // run the same auto-accept helper.
    const newAccountId = `acct-new-${runId}`
    await prisma.account.create({
      data: {
        id: newAccountId,
        email: newEmail,
        emailVerified: true,
        name: 'Auto-Accept Friend',
      },
    })

    try {
      await autoAcceptPendingFriendInvitationsForAccount({
        accountId: newAccountId,
        accountEmail: newEmail,
      })

      // Invitation flipped to ACCEPTED
      const invitation = await prisma.groupInvitation.findUnique({
        where: { id: invitationId },
      })
      expect(invitation!.status).toBe(GroupInvitationStatus.ACCEPTED)
      expect(invitation!.acceptedById).toBe(newAccountId)
      expect(invitation!.acceptedAt).not.toBeNull()

      // New account is now a GroupMember
      const member = await prisma.groupMember.findUnique({
        where: {
          groupId_accountId: {
            groupId: created.groupId,
            accountId: newAccountId,
          },
        },
      })
      expect(member).not.toBeNull()
      expect(member!.status).toBe(GroupMemberStatus.ACTIVE)
      expect(member!.role).toBe(GroupRole.ADMIN)

      // friendPairKey is set on the group
      const group = await prisma.group.findUnique({
        where: { id: created.groupId },
      })
      expect(group!.friendPairKey).not.toBeNull()
      const [smaller, larger] = [callerId, newAccountId].sort()
      expect(group!.friendPairKey).toBe(`${smaller}:${larger}`)
    } finally {
      await prisma.account
        .delete({ where: { id: newAccountId } })
        .catch(() => {})
    }
  })

  // ───────────────────────────────────────────────────────────────────
  // 13.7: auto-accept on link-open
  // ───────────────────────────────────────────────────────────────────
  it('auto-accept on link-open: groups.get with a PENDING FRIEND link token accepts the invitation', async () => {
    // Use a fresh recipient so the partial unique index on
    // Group.friendPairKey does not collide with friend groups
    // already created earlier in this test file.
    const linkRecipientId = `acct-linkrecv-${runId}`
    const linkRecipientEmail = `linkrecv-${runId}@test.example`
    await prisma.account.create({
      data: {
        id: linkRecipientId,
        email: linkRecipientEmail,
        emailVerified: true,
        name: 'Link Recipient',
      },
    })

    try {
      // Caller creates a friend ledger with a link path
      const created = await makeCaller().create({
        requestId: crypto.randomUUID(),
        friendFormValues: {
          useLink: true,
          temporaryName: 'Link Open Friend',
          currency: '$',
          currencyCode: 'USD',
        },
      })
      trackGroup(created.groupId)
      const token = created.token!
      const groupId = created.groupId

      const before = await prisma.groupMember.findUnique({
        where: { groupId_accountId: { groupId, accountId: linkRecipientId } },
      })
      expect(before).toBeNull()

      // A read-scoped OAuth token may inspect the pending invitation, but a
      // query must never consume it or create membership as a side effect.
      const oauthView = await groupsRouter
        .createCaller({
          auth: {
            credentialKind: 'oauth',
            accessToken: 'oauth-link-read-test',
            scopes: ['spliit:groups:read'],
            audiences: [getApiBaseUrl()],
            session: { id: 'oauth-link-read-session' },
            user: {
              id: linkRecipientId,
              email: linkRecipientEmail,
              emailVerified: true,
              name: 'Link Recipient',
              anonymousOnboardingCompleted: true,
            },
          },
        } as never)
        .get({ groupId, linkInviteToken: token })

      expect(oauthView.viewer.canAcceptInvitation).toBe(false)

      expect(
        await prisma.groupMember.findUnique({
          where: { groupId_accountId: { groupId, accountId: linkRecipientId } },
        }),
      ).toBeNull()
      expect(
        await prisma.groupInvitation.findFirst({
          where: { groupId, type: GroupInvitationType.LINK },
        }),
      ).toMatchObject({ status: GroupInvitationStatus.PENDING })

      await makeGroupsCaller({
        accountId: linkRecipientId,
        email: linkRecipientEmail,
        name: 'Link Recipient',
      }).get({ groupId, linkInviteToken: token })

      const after = await prisma.groupMember.findUnique({
        where: { groupId_accountId: { groupId, accountId: linkRecipientId } },
      })
      expect(after).not.toBeNull()
      expect(after!.status).toBe(GroupMemberStatus.ACTIVE)
      expect(after!.role).toBe(GroupRole.ADMIN)

      const invitation = await prisma.groupInvitation.findFirst({
        where: { groupId, type: GroupInvitationType.LINK },
      })
      expect(invitation!.status).toBe(GroupInvitationStatus.ACCEPTED)
      expect(invitation!.acceptedById).toBe(linkRecipientId)

      const group = await prisma.group.findUnique({ where: { id: groupId } })
      expect(group!.friendPairKey).not.toBeNull()
    } finally {
      await prisma.account
        .delete({ where: { id: linkRecipientId } })
        .catch(() => {})
    }
  })

  // ───────────────────────────────────────────────────────────────────
  // 13.8: invitations.listForAccount excludes FRIEND invitations
  // ───────────────────────────────────────────────────────────────────
  it('listForAccount: FRIEND email invitations are filtered out', async () => {
    // pendingEmail from test 13.3 was created by the caller. Pretend the
    // unknown email belongs to a new account so listForAccount has
    // something to filter.
    const targetEmail = `pending-${runId}@unknown.example`
    const targetAccountId = `acct-listfilter-${runId}`
    await prisma.account.create({
      data: {
        id: targetAccountId,
        email: targetEmail,
        emailVerified: true,
        name: 'Target',
      },
    })

    try {
      const result = await makeInvitationsCaller({
        accountId: targetAccountId,
        email: targetEmail,
        name: 'Target',
      }).listForAccount()
      // No FRIEND invitation should appear
      const friendInvites = result.invitations.filter(
        (i) => i.group.groupType === GroupType.FRIEND,
      )
      expect(friendInvites).toHaveLength(0)
    } finally {
      await prisma.account
        .delete({ where: { id: targetAccountId } })
        .catch(() => {})
    }
  })

  // ───────────────────────────────────────────────────────────────────
  // 13.9: restricted actions on FRIEND groups
  // ───────────────────────────────────────────────────────────────────
  describe('restricted actions for FRIEND-typed groups', () => {
    let groupId: string
    let groupName: string

    beforeAll(async () => {
      // Create a fresh FRIEND group owned by the caller with peerId as the other member
      const result = await makeCaller().create({
        requestId: crypto.randomUUID(),
        friendFormValues: {
          peerAccountId: peerId,
          currency: '$',
          currencyCode: 'USD',
        },
      })
      groupId = result.groupId
      trackGroup(groupId)
      const group = await prisma.group.findUnique({
        where: { id: result.groupId },
      })
      groupName = group!.name
    })

    it('groups.update with name change is rejected (FORBIDDEN)', async () => {
      await expect(
        makeGroupsCaller().update({
          groupId,
          groupFormValues: {
            name: 'Renamed',
            currency: '$',
            currencyCode: 'USD',
            participants: [{ name: 'Caller' }],
          },
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    it('groups.update with information change is ALLOWED', async () => {
      await makeGroupsCaller().update({
        groupId,
        groupFormValues: {
          name: groupName,
          information: 'Some context',
          currency: '$',
          currencyCode: 'USD',
          participants: [{ name: 'Caller' }],
        },
      })
      const group = await prisma.group.findUnique({ where: { id: groupId } })
      expect(group!.information).toBe('Some context')
    })

    it('groups.update with currency change is ALLOWED', async () => {
      await makeGroupsCaller().update({
        groupId,
        groupFormValues: {
          name: groupName,
          currency: '€',
          currencyCode: 'EUR',
          participants: [{ name: 'Caller' }],
        },
      })
      const ledger = await prisma.ledger.findFirst({
        where: { group: { id: groupId } },
      })
      expect(ledger!.currency).toBe('€')
      expect(ledger!.currencyCode).toBe('EUR')
    })

    it('groups.archive is rejected (FORBIDDEN)', async () => {
      await expect(
        makeGroupsCaller().archive({ groupId, archived: true }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    it('groups.delete is rejected (FORBIDDEN)', async () => {
      await expect(
        makeGroupsCaller().delete({ groupId }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    it('groups.leave is rejected (FORBIDDEN)', async () => {
      await expect(makeGroupsCaller().leave({ groupId })).rejects.toMatchObject(
        { code: 'FORBIDDEN' },
      )
    })

    it('invitations.create is rejected (FORBIDDEN)', async () => {
      await expect(
        makeInvitationsCaller().create({
          requestId: crypto.randomUUID(),
          groupId,
          email: `invitee-${runId}@example.test`,
          role: 'MEMBER',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    it('invitations.createLink is rejected (FORBIDDEN)', async () => {
      await expect(
        makeInvitationsCaller().createLink({
          groupId,
          requestId: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    it('invitations.revoke is rejected (FORBIDDEN)', async () => {
      // Create a friend ledger with a link path so it has a real
      // PENDING LINK invitation we can target.
      const linkResult = await makeCaller().create({
        requestId: crypto.randomUUID(),
        friendFormValues: {
          useLink: true,
          temporaryName: 'Revoke Friend',
          currency: '$',
          currencyCode: 'USD',
        },
      })
      trackGroup(linkResult.groupId)
      const linkInvitation = await prisma.groupInvitation.findFirst({
        where: {
          groupId: linkResult.groupId,
          type: GroupInvitationType.LINK,
        },
      })
      expect(linkInvitation).not.toBeNull()

      await expect(
        makeInvitationsCaller().revoke({
          invitationId: linkInvitation!.id,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    it('members.remove is rejected (FORBIDDEN)', async () => {
      const members = await prisma.groupMember.findMany({
        where: { groupId, status: GroupMemberStatus.ACTIVE },
        select: { id: true, accountId: true },
      })
      const peerMember = members.find((m) => m.accountId !== callerId)
      expect(peerMember).toBeDefined()

      await expect(
        makeGroupsCaller().members.remove({
          groupId,
          memberId: peerMember!.id,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })

    it('members.updateRole is rejected (FORBIDDEN)', async () => {
      const members = await prisma.groupMember.findMany({
        where: { groupId, status: GroupMemberStatus.ACTIVE },
        select: { id: true, accountId: true },
      })
      const peerMember = members.find((m) => m.accountId !== callerId)
      expect(peerMember).toBeDefined()

      await expect(
        makeGroupsCaller().members.updateRole({
          groupId,
          memberId: peerMember!.id,
          role: 'MEMBER' as const,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    })
  })

  // ───────────────────────────────────────────────────────────────────
  // 13.10: account.groups returns groupType + displayName
  // ───────────────────────────────────────────────────────────────────
  it('account.groups: returns groupType and displayName for both GROUP and FRIEND', async () => {
    // Create a normal GROUP for the caller
    const { groupId: regularGroupId } = await makeGroupsCaller().create({
      requestId: crypto.randomUUID(),
      groupFormValues: {
        name: `Regular ${runId}`,
        currency: '$',
        currencyCode: 'USD',
        participants: [{ name: 'Caller' }],
      },
    })
    const regularGroup = await prisma.group.findUnique({
      where: { id: regularGroupId },
    })
    trackLedger(regularGroup!.ledgerId)

    // The friend group from test 13.1 already exists (caller+peer)
    const result = await makeAccountCaller().groups({ includeArchived: false })

    const regular = result.groups.find((g) => g.id === regularGroupId)
    expect(regular).toBeDefined()
    expect(regular!.groupType).toBe(GroupType.GROUP)
    expect(regular!.displayName).toBe(`Regular ${runId}`)

    const friendGroups = result.groups.filter(
      (g) => g.groupType === GroupType.FRIEND,
    )
    // Friend groups with only the caller as ACTIVE member and no
    // PENDING invitation (e.g. the invitee deleted their account) have
    // an empty displayName. Skip those orphan groups in the assertion.
    let verified = 0
    for (const fg of friendGroups) {
      const memberCount = await prisma.groupMember.count({
        where: { groupId: fg.id, status: GroupMemberStatus.ACTIVE },
      })
      const pendingCount = await prisma.groupInvitation.count({
        where: { groupId: fg.id, status: GroupInvitationStatus.PENDING },
      })
      if (memberCount <= 1 && pendingCount === 0) continue
      expect(fg.displayName).toBeTruthy()
      expect(fg.displayName).not.toBe('')
      verified++
    }
    expect(verified).toBeGreaterThan(0)
  })

  // ───────────────────────────────────────────────────────────────────
  // 13.11: account.friends hasFriendLedger
  // ───────────────────────────────────────────────────────────────────
  it('account.friends: hasFriendLedger is true when pair exists', async () => {
    // The caller has direct-accept ledgers with peer and third
    const result = await makeAccountCaller().friends({})

    const peerEntry = result.friends.find((f) => f.accountId === peerId)
    expect(peerEntry).toBeDefined()
    expect(peerEntry!.hasFriendLedger).toBe(true)
    expect(peerEntry!.friendLedgerStatus).toBe('ACTIVE')

    const thirdEntry = result.friends.find((f) => f.accountId === thirdId)
    expect(thirdEntry).toBeDefined()
    expect(thirdEntry!.hasFriendLedger).toBe(true)
    expect(thirdEntry!.friendLedgerStatus).toBe('ACTIVE')
  })

  // ───────────────────────────────────────────────────────────────────
  // 13.12: invitations.previewLink returns FRIEND-aware name
  // ───────────────────────────────────────────────────────────────────
  it('previewLink: FRIEND group returns "Friend ledger with {inviter}" instead of empty string', async () => {
    const linkResult = await makeCaller().create({
      requestId: crypto.randomUUID(),
      friendFormValues: {
        useLink: true,
        temporaryName: 'Preview Friend',
        currency: '$',
        currencyCode: 'USD',
      },
    })
    trackGroup(linkResult.groupId)
    const token = linkResult.token!

    const preview = await makeInvitationsCaller().previewLink({ token })
    expect(preview.preview).not.toBeNull()
    expect(preview.preview!.group.name).toMatch(/Friend ledger with /)
    expect(preview.preview!.group.name).toContain('Test Caller')
    expect(preview.preview!.temporaryName).toBe('Preview Friend')
  })

  // ───────────────────────────────────────────────────────────────────
  // TODO: Additional test coverage needed (unimplemented)
  //
  // These stub tests document gaps identified in code review. They
  // validate important edge cases that are currently uncovered. A
  // follow-up agent should implement them by replacing this section
  // with fully-implemented tests.
  // ───────────────────────────────────────────────────────────────────

  // TODO (task 13.21): friendFormSchema domain validation is tested in
  // packages/domain/src/schemas.test.ts — not here.

  // ───────────────────────────────────────────────────────────────────
  // 13.22: Self-ledger rejection
  // ───────────────────────────────────────────────────────────────────
  it('self-ledger rejection: peerAccountId === callerAccountId throws BAD_REQUEST', async () => {
    await expect(
      makeCaller().create({
        requestId: crypto.randomUUID(),
        friendFormValues: {
          peerAccountId: callerId,
          currency: '$',
          currencyCode: 'USD',
        },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('self-ledger rejection: peerEmail resolves to caller own account throws BAD_REQUEST', async () => {
    await expect(
      makeCaller().create({
        requestId: crypto.randomUUID(),
        friendFormValues: {
          peerEmail: callerEmail,
          currency: '$',
          currencyCode: 'USD',
        },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  // ───────────────────────────────────────────────────────────────────
  // 13.23: Expense CRUD on FRIEND group
  // ───────────────────────────────────────────────────────────────────
  it('expense CRUD: create, list, get, update, delete on a FRIEND group', async () => {
    const aId = `acct-crud-a-${runId}`
    const aEmail = `crud-a-${runId}@test.example`
    const bId = `acct-crud-b-${runId}`
    const bEmail = `crud-b-${runId}@test.example`
    await prisma.account.createMany({
      data: [
        { id: aId, email: aEmail, emailVerified: true, name: 'CRUD A' },
        { id: bId, email: bEmail, emailVerified: true, name: 'CRUD B' },
      ],
    })

    try {
      const result = await makeCaller({
        accountId: aId,
        email: aEmail,
        name: 'CRUD A',
      }).create({
        requestId: crypto.randomUUID(),
        friendFormValues: {
          peerAccountId: bId,
          currency: '$',
          currencyCode: 'USD',
        },
      })
      expect(result.existed).toBe(false)
      trackGroup(result.groupId)

      const participants = await prisma.ledgerParticipant.findMany({
        where: { ledger: { group: { id: result.groupId } } },
        select: { id: true, groupMember: { select: { accountId: true } } },
      })
      expect(participants).toHaveLength(2)
      const aP = participants.find((p) => p.groupMember.accountId === aId)!
      const bP = participants.find((p) => p.groupMember.accountId === bId)!

      const gc = makeGroupsCaller({
        accountId: aId,
        email: aEmail,
        name: 'CRUD A',
      })
      const baseExpense = {
        paidByList: [{ participant: aP.id, shares: 5000 }],
        paidBySplitMode: 'BY_AMOUNT' as const,
        isMultiPayer: false,
        paidFor: [
          { participant: aP.id, shares: 1 },
          { participant: bP.id, shares: 1 },
        ],
        category: 'general' as const,
        splitMode: 'EVENLY' as const,
        expenseDate: new Date().toISOString(),
        expenseTimeZone: 'UTC',
        documents: [],
        recurrenceRule: 'NONE' as const,
      }

      // Create
      const { expenseId } = await gc.expenses.create({
        requestId: crypto.randomUUID(),
        groupId: result.groupId,
        expense: { ...baseExpense, title: 'Dinner', amount: 5000 },
      })
      expect(expenseId).toBeTruthy()

      // List
      const listResult = await gc.expenses.list({ groupId: result.groupId })
      expect(listResult.expenses).toHaveLength(1)
      expect(listResult.expenses[0].id).toBe(expenseId)

      // Get
      const getResult = await gc.expenses.get({
        groupId: result.groupId,
        expenseId,
      })
      expect(getResult.expense.title).toBe('Dinner')
      expect(getResult.expense.amount).toBe(5000)

      // Update
      await gc.expenses.update({
        expectedVersion: (
          await prisma.expense.findUniqueOrThrow({
            where: { id: expenseId },
            select: { version: true },
          })
        ).version,
        groupId: result.groupId,
        expenseId,
        expense: { ...baseExpense, title: 'Dinner Updated', amount: 5000 },
      })

      const updated = await gc.expenses.get({
        groupId: result.groupId,
        expenseId,
      })
      expect(updated.expense.title).toBe('Dinner Updated')

      // Delete
      await gc.expenses.delete({ groupId: result.groupId, expenseId })
      const afterDelete = await gc.expenses.list({ groupId: result.groupId })
      expect(afterDelete.expenses).toHaveLength(0)
    } finally {
      await prisma.account.delete({ where: { id: aId } }).catch(() => {})
      await prisma.account.delete({ where: { id: bId } }).catch(() => {})
    }
  })

  // ───────────────────────────────────────────────────────────────────
  // 13.24: Balance calculation on FRIEND group
  // ───────────────────────────────────────────────────────────────────
  it('balance calculation: create expense, verify balances return correct owed amounts', async () => {
    const aId = `acct-bal-a-${runId}`
    const aEmail = `bal-a-${runId}@test.example`
    const bId = `acct-bal-b-${runId}`
    const bEmail = `bal-b-${runId}@test.example`
    await prisma.account.createMany({
      data: [
        { id: aId, email: aEmail, emailVerified: true, name: 'Bal A' },
        { id: bId, email: bEmail, emailVerified: true, name: 'Bal B' },
      ],
    })

    try {
      const result = await makeCaller({
        accountId: aId,
        email: aEmail,
        name: 'Bal A',
      }).create({
        requestId: crypto.randomUUID(),
        friendFormValues: {
          peerAccountId: bId,
          currency: '$',
          currencyCode: 'USD',
        },
      })
      trackGroup(result.groupId)

      const participants = await prisma.ledgerParticipant.findMany({
        where: { ledger: { group: { id: result.groupId } } },
        select: { id: true, groupMember: { select: { accountId: true } } },
      })
      const aP = participants.find((p) => p.groupMember.accountId === aId)!
      const bP = participants.find((p) => p.groupMember.accountId === bId)!

      const gc = makeGroupsCaller({
        accountId: aId,
        email: aEmail,
        name: 'Bal A',
      })
      await gc.expenses.create({
        requestId: crypto.randomUUID(),
        groupId: result.groupId,
        expense: {
          title: 'Dinner',
          amount: 5000,
          paidByList: [{ participant: aP.id, shares: 5000 }],
          paidBySplitMode: 'BY_AMOUNT',
          isMultiPayer: false,
          paidFor: [
            { participant: aP.id, shares: 1 },
            { participant: bP.id, shares: 1 },
          ],
          category: 'general',
          splitMode: 'EVENLY',
          expenseDate: new Date().toISOString(),
          expenseTimeZone: 'UTC',
          documents: [],
          recurrenceRule: 'NONE',
        },
      })

      const balancesResult = await gc.balances.list({
        groupId: result.groupId,
      })

      // B owes A $25 (half of $50). Result is a map of participantId → { paid, paidFor, total }
      expect(balancesResult.balances[aP.id]).toBeDefined()
      expect(balancesResult.balances[bP.id]).toBeDefined()
      expect(balancesResult.balances[aP.id].paid).toBe(2500)
      expect(balancesResult.balances[aP.id].paidFor).toBe(0)
      expect(balancesResult.balances[aP.id].total).toBe(2500)
      expect(balancesResult.balances[bP.id].paid).toBe(0)
      expect(balancesResult.balances[bP.id].paidFor).toBe(2500)
      expect(balancesResult.balances[bP.id].total).toBe(-2500)
    } finally {
      await prisma.account.delete({ where: { id: aId } }).catch(() => {})
      await prisma.account.delete({ where: { id: bId } }).catch(() => {})
    }
  })

  // ───────────────────────────────────────────────────────────────────
  // 13.25: Cross-direction lookup-or-create
  // ───────────────────────────────────────────────────────────────────
  it('cross-direction lookup-or-create: pending email from A→B, then B creates friend ledger with A by accountId returns existed:true', async () => {
    const aId = `acct-cd-a-${runId}`
    const aEmail = `cd-a-${runId}@test.example`
    const newEmail = `cd-new-${runId}@test.example`

    await prisma.account.create({
      data: { id: aId, email: aEmail, emailVerified: true, name: 'Cross A' },
    })

    try {
      const aResult = await makeCaller({
        accountId: aId,
        email: aEmail,
        name: 'Cross A',
      }).create({
        requestId: crypto.randomUUID(),
        friendFormValues: {
          peerEmail: newEmail,
          currency: '$',
          currencyCode: 'USD',
        },
      })
      expect(aResult.existed).toBe(false)
      trackGroup(aResult.groupId)

      const bId = `acct-cd-b-${runId}`
      await prisma.account.create({
        data: {
          id: bId,
          email: newEmail,
          emailVerified: true,
          name: 'Cross B',
        },
      })

      try {
        const bResult = await makeCaller({
          accountId: bId,
          email: newEmail,
          name: 'Cross B',
        }).create({
          requestId: crypto.randomUUID(),
          friendFormValues: {
            peerAccountId: aId,
            currency: '$',
            currencyCode: 'USD',
          },
        })
        expect(bResult.existed).toBe(true)
        expect(bResult.groupId).toBe(aResult.groupId)
      } finally {
        await prisma.account.delete({ where: { id: bId } }).catch(() => {})
      }
    } finally {
      await prisma.account.delete({ where: { id: aId } }).catch(() => {})
    }
  })

  // ───────────────────────────────────────────────────────────────────
  // 13.26: friendPairKey race safety
  // ───────────────────────────────────────────────────────────────────
  it('friendPairKey race safety: P2002 catch handles concurrent auto-accept gracefully', async () => {
    const newEmail = `race-${runId}@test.example`

    const created = await makeCaller().create({
      requestId: crypto.randomUUID(),
      friendFormValues: {
        peerEmail: newEmail,
        currency: '$',
        currencyCode: 'USD',
      },
    })
    trackGroup(created.groupId)

    const newAccountId = `acct-race-${runId}`
    await prisma.account.create({
      data: {
        id: newAccountId,
        email: newEmail,
        emailVerified: true,
        name: 'Race Target',
      },
    })

    try {
      // Manually set friendPairKey to simulate a concurrent auto-accept
      const pairKey =
        callerId < newAccountId
          ? `${callerId}:${newAccountId}`
          : `${newAccountId}:${callerId}`
      await prisma.group.update({
        where: { id: created.groupId },
        data: { friendPairKey: pairKey },
      })

      await expect(
        autoAcceptPendingFriendInvitationsForAccount({
          accountId: newAccountId,
          accountEmail: newEmail,
        }),
      ).resolves.toBeUndefined()
    } finally {
      await prisma.account
        .delete({ where: { id: newAccountId } })
        .catch(() => {})
    }
  })

  it('duplicate auto-accept cleanup: removes stale pending friend invite when pair key already exists', async () => {
    const aId = `acct-dup-a-${runId}`
    const aEmail = `dup-a-${runId}@test.example`
    const bId = `acct-dup-b-${runId}`
    const bEmail = `dup-b-${runId}@test.example`
    await prisma.account.createMany({
      data: [
        { id: aId, email: aEmail, emailVerified: true, name: 'Dup A' },
        { id: bId, email: bEmail, emailVerified: true, name: 'Dup B' },
      ],
    })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const existing = await makeCaller({
        accountId: aId,
        email: aEmail,
        name: 'Dup A',
      }).create({
        requestId: crypto.randomUUID(),
        friendFormValues: {
          peerAccountId: bId,
          currency: '$',
          currencyCode: 'USD',
        },
      })
      trackGroup(existing.groupId)

      const staleLedger = await prisma.ledger.create({
        data: {
          id: `ldg-dup-stale-${runId}`,
          currency: '$',
          currencyCode: 'USD',
        },
      })
      const staleGroup = await prisma.group.create({
        data: {
          id: `grp-dup-stale-${runId}`,
          name: `stale-${runId}`,
          groupType: GroupType.FRIEND,
          ledgerId: staleLedger.id,
        },
      })
      const staleMember = await prisma.groupMember.create({
        data: {
          id: `mbr-dup-stale-${runId}`,
          groupId: staleGroup.id,
          accountId: aId,
          role: GroupRole.ADMIN,
          status: GroupMemberStatus.ACTIVE,
          joinedAt: new Date(),
        },
      })
      await prisma.ledgerParticipant.create({
        data: {
          id: `lp-dup-a-${runId}`,
          ledgerId: staleLedger.id,
          groupMemberId: staleMember.id,
        },
      })
      const pendingParticipant = await prisma.ledgerParticipant.create({
        data: {
          id: `lp-dup-b-pending-${runId}`,
          ledgerId: staleLedger.id,
        },
      })
      const staleInvitation = await prisma.groupInvitation.create({
        data: {
          id: `inv-dup-stale-${runId}`,
          type: GroupInvitationType.EMAIL,
          groupId: staleGroup.id,
          email: bEmail,
          role: GroupRole.ADMIN,
          invitedById: aId,
          ledgerParticipantId: pendingParticipant.id,
        },
      })

      await expect(
        autoAcceptPendingFriendInvitationsForAccount({
          accountId: bId,
          accountEmail: bEmail,
        }),
      ).resolves.toBeUndefined()

      expect(warnSpy).toHaveBeenCalled()
      const removedInvitation = await prisma.groupInvitation.findUnique({
        where: { id: staleInvitation.id },
      })
      const removedGroup = await prisma.group.findUnique({
        where: { id: staleGroup.id },
      })
      expect(removedInvitation).toBeNull()
      expect(removedGroup).toBeNull()
      const existingGroup = await prisma.group.findUnique({
        where: { id: existing.groupId },
      })
      expect(existingGroup?.friendPairKey).toBe([aId, bId].sort().join(':'))
    } finally {
      warnSpy.mockRestore()
      await prisma.group
        .delete({ where: { id: `grp-dup-stale-${runId}` } })
        .catch(() => {})
      await prisma.ledger
        .delete({ where: { id: `ldg-dup-stale-${runId}` } })
        .catch(() => {})
      await prisma.account.delete({ where: { id: aId } }).catch(() => {})
      await prisma.account.delete({ where: { id: bId } }).catch(() => {})
    }
  })

  // ───────────────────────────────────────────────────────────────────
  // 13.27 + 13.32: displayName fallback priority + specific peer name
  // ───────────────────────────────────────────────────────────────────
  it('displayName: direct-accept peer name → invitation temporaryName → invitation email, and equals specific peer name', async () => {
    // Level 1: Direct-accept — displayName equals the peer's Account.name
    // Uses the existing direct-accept group from test 13.1 (caller + peer)
    const result13_1 = await makeCaller().create({
      requestId: crypto.randomUUID(),
      friendFormValues: {
        peerAccountId: peerId,
        currency: '$',
        currencyCode: 'USD',
      },
    })
    expect(result13_1.existed).toBe(true) // already created by test 13.1

    // Level 2: Pending email with temporaryName
    const pendingNameEmail = `pending-dn-${runId}@test.example`
    const pendingNameResult = await makeCaller().create({
      requestId: crypto.randomUUID(),
      friendFormValues: {
        peerEmail: pendingNameEmail,
        temporaryName: 'Temp Named Friend',
        currency: '$',
        currencyCode: 'USD',
      },
    })
    trackGroup(pendingNameResult.groupId)

    // Level 3: Pending email without temporaryName
    const pendingNoNameEmail = `pending-dn2-${runId}@test.example`
    const pendingNoNameResult = await makeCaller().create({
      requestId: crypto.randomUUID(),
      friendFormValues: {
        peerEmail: pendingNoNameEmail,
        currency: '$',
        currencyCode: 'USD',
      },
    })
    trackGroup(pendingNoNameResult.groupId)

    const groupsResult = await makeAccountCaller().groups({
      includeArchived: false,
    })

    // Level 1 + 13.32: verify displayName is the peer's specific account name
    const directGroup = groupsResult.groups.find(
      (g) => g.id === result13_1.groupId,
    )
    expect(directGroup).toBeDefined()
    expect(directGroup!.displayName).toBe('Test Peer')

    // Level 2: verify displayName is the temporaryName
    const withName = groupsResult.groups.find(
      (g) => g.id === pendingNameResult.groupId,
    )
    expect(withName).toBeDefined()
    expect(withName!.displayName).toBe('Temp Named Friend')

    // Level 3: verify displayName is the invitation email
    const noName = groupsResult.groups.find(
      (g) => g.id === pendingNoNameResult.groupId,
    )
    expect(noName).toBeDefined()
    expect(noName!.displayName).toBe(pendingNoNameEmail)
  })
})
