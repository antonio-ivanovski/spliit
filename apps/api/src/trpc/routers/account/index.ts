import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  GroupInvitationStatus,
  GroupInvitationType,
  GroupMemberStatus,
  GroupRole,
  GroupType,
  prisma,
} from '@spliit/db'
import {
  accountLocaleSchema,
  accountMascotSchema,
  accountPreferenceSchema,
  accountThemeSchema,
  supportedCurrencyCodeSchema,
  timeZoneSchema,
} from '@spliit/domain'

import { randomId } from '../../../lib/api'
import { accountSummarySelect } from '../../../lib/api/selects/account-summary'
import { invalidateAccountCache } from '../../../lib/auth/account-cache'
import {
  listAuthorizedClients,
  revokeAuthorizedClient,
} from '../../../lib/auth/authorized-clients'
import { env } from '../../../lib/env'
import {
  getInvitationDisplayName,
  isPlaceholderEmail,
} from '../../../lib/invitations'
import {
  deleteS3Object,
  isProfileImageUrlForAccount,
  validateProfileImageUpload,
} from '../../../routes/upload'
import { createTRPCRouter, protectedProcedure } from '../../init'
import {
  accountFriendsOutputSchema,
  accountGroupPreferencesOutputSchema,
  accountGroupsOutputSchema,
  accountMembersOutputSchema,
  accountPreferenceOutputSchema,
  accountProfileSchema,
  authorizedClientsOutputSchema,
  revokeAuthorizedClientOutputSchema,
} from '../../outputs/account'

const accountPreferenceSelect = {
  defaultCurrencyCode: true,
  timeZone: true,
  locale: true,
  theme: true,
  mascot: true,
  notificationsEnabled: true,
  aiFeaturesEnabled: true,
  aiCategoryExtractEnabled: true,
  aiReceiptScanEnabled: true,
  aiVoiceExpenseEnabled: true,
} as const

const emptyAccountPreference = {
  defaultCurrencyCode: null,
  timeZone: null,
  locale: null,
  theme: null,
  mascot: 'bill',
  notificationsEnabled: null,
  aiFeaturesEnabled: null,
  aiCategoryExtractEnabled: null,
  aiReceiptScanEnabled: null,
  aiVoiceExpenseEnabled: null,
}

function parseAccountPreference(preferences: unknown) {
  const parsed = accountPreferenceSchema.parse(
    preferences ?? emptyAccountPreference,
  )
  // Normalize nullable toggles to real booleans: `null` ≡ enabled so the
  // web sees a consistent shape and the gating hooks can compare directly.
  return {
    ...parsed,
    mascot: parsed.mascot ?? 'bill',
    notificationsEnabled: parsed.notificationsEnabled ?? true,
    aiFeaturesEnabled: parsed.aiFeaturesEnabled ?? true,
    aiCategoryExtractEnabled: parsed.aiCategoryExtractEnabled ?? true,
    aiReceiptScanEnabled: parsed.aiReceiptScanEnabled ?? true,
    aiVoiceExpenseEnabled: parsed.aiVoiceExpenseEnabled ?? true,
  }
}

const initializePreferencesInputSchema = z.object({
  locale: accountLocaleSchema.optional(),
  theme: accountThemeSchema.optional(),
  timeZone: timeZoneSchema.optional(),
})

const updatePreferencesInputSchema = z.object({
  defaultCurrencyCode: supportedCurrencyCodeSchema.nullable().optional(),
  timeZone: timeZoneSchema.nullable().optional(),
  locale: accountLocaleSchema.nullable().optional(),
  theme: accountThemeSchema.nullable().optional(),
  mascot: accountMascotSchema.optional(),
  notificationsEnabled: z.boolean().optional(),
  aiFeaturesEnabled: z.boolean().optional(),
  aiCategoryExtractEnabled: z.boolean().nullable().optional(),
  aiReceiptScanEnabled: z.boolean().nullable().optional(),
  aiVoiceExpenseEnabled: z.boolean().nullable().optional(),
})

type CurrencyMembership = {
  role: GroupRole
  group: {
    createdAt: Date
    ledger: { currencyCode: string | null }
  }
}

function mostCommonCurrency(memberships: CurrencyMembership[]) {
  const ranked = new Map<string, { count: number; newestGroup: number }>()

  for (const membership of memberships) {
    const parsed = supportedCurrencyCodeSchema.safeParse(
      membership.group.ledger.currencyCode,
    )
    if (!parsed.success) continue

    const current = ranked.get(parsed.data)
    const createdAt = membership.group.createdAt.getTime()
    ranked.set(parsed.data, {
      count: (current?.count ?? 0) + 1,
      newestGroup: Math.max(current?.newestGroup ?? 0, createdAt),
    })
  }

  return [...ranked.entries()].toSorted(
    ([currencyA, rankA], [currencyB, rankB]) =>
      rankB.count - rankA.count ||
      rankB.newestGroup - rankA.newestGroup ||
      currencyA.localeCompare(currencyB),
  )[0]?.[0]
}

function inferDefaultCurrency(memberships: CurrencyMembership[]) {
  const adminCurrency = mostCommonCurrency(
    memberships.filter((membership) => membership.role === GroupRole.ADMIN),
  )
  if (adminCurrency) return adminCurrency

  return (
    mostCommonCurrency(
      memberships.filter((membership) => membership.role === GroupRole.MEMBER),
    ) ?? env.PUBLIC_DEFAULT_CURRENCY_CODE
  )
}

/**
 * Account-scoped router. Used by the web client to bootstrap an authenticated
 * session (profile, group memberships, pending invitations) without exposing
 * legacy anonymous behaviour.
 */
export const accountRouter = createTRPCRouter({
  // Current account profile.
  me: protectedProcedure
    .output(z.object({ account: accountProfileSchema }))
    .query(async ({ ctx }) => {
      return {
        account: {
          ...ctx.auth.user,
          image: ctx.auth.user.image ?? null,
          isAnonymous: ctx.auth.user.isAnonymous === true,
        },
      }
    }),

  /**
   * OAuth clients this account has authorized, so they can be reviewed and
   * withdrawn from the settings page.
   */
  authorizedClients: protectedProcedure
    .output(authorizedClientsOutputSchema)
    .query(async ({ ctx }) => {
      return { clients: await listAuthorizedClients(ctx.auth.user.id) }
    }),

  /**
   * Withdraw an authorization. Invalidates pending authorization codes and
   * revokes the client's refresh tokens on top of deleting the consent, so
   * access actually ends instead of lasting until the refresh token would have
   * expired. An access token already issued stays valid until it expires, at
   * most an hour.
   */
  revokeAuthorizedClient: protectedProcedure
    .input(z.object({ consentId: z.string().min(1) }))
    .output(revokeAuthorizedClientOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const result = await revokeAuthorizedClient({
        accountId: ctx.auth.user.id,
        consentId: input.consentId,
      })
      if (!result) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Authorization not found',
        })
      }
      return result
    }),

  /** Read the caller's server-synced account preferences. */
  getPreferences: protectedProcedure
    .output(accountPreferenceOutputSchema)
    .query(async ({ ctx }) => {
      const preferences = await prisma.accountPreference.findUnique({
        where: { accountId: ctx.auth.user.id },
        select: accountPreferenceSelect,
      })
      return { preferences: parseAccountPreference(preferences) }
    }),

  /**
   * Adopt explicit device values for preferences that have never been set.
   * Every field is guarded independently so subsequent devices cannot replace a
   * preference already established by the account.
   */
  initializePreferences: protectedProcedure
    .input(initializePreferencesInputSchema)
    .output(accountPreferenceOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const preferences = await prisma.$transaction(async (tx) => {
        await tx.accountPreference.upsert({
          where: { accountId: ctx.auth.user.id },
          create: {
            id: randomId(),
            accountId: ctx.auth.user.id,
            locale: input.locale,
            theme: input.theme,
            timeZone: input.timeZone,
          },
          update: {},
        })

        const currentPreferences = await tx.accountPreference.findUnique({
          where: { accountId: ctx.auth.user.id },
          select: accountPreferenceSelect,
        })
        if (!currentPreferences?.defaultCurrencyCode) {
          const memberships = await tx.groupMember.findMany({
            where: {
              accountId: ctx.auth.user.id,
              status: GroupMemberStatus.ACTIVE,
              group: { archived: false },
            },
            select: {
              role: true,
              group: {
                select: {
                  createdAt: true,
                  ledger: { select: { currencyCode: true } },
                },
              },
            },
          })
          await tx.accountPreference.updateMany({
            where: {
              accountId: ctx.auth.user.id,
              defaultCurrencyCode: null,
            },
            data: {
              defaultCurrencyCode: inferDefaultCurrency(
                Array.isArray(memberships) ? memberships : [],
              ),
            },
          })
        }

        if (input.locale !== undefined) {
          await tx.accountPreference.updateMany({
            where: { accountId: ctx.auth.user.id, locale: null },
            data: { locale: input.locale },
          })
        }
        if (input.theme !== undefined) {
          await tx.accountPreference.updateMany({
            where: { accountId: ctx.auth.user.id, theme: null },
            data: { theme: input.theme },
          })
        }
        if (input.timeZone !== undefined) {
          await tx.accountPreference.updateMany({
            where: { accountId: ctx.auth.user.id, timeZone: null },
            data: { timeZone: input.timeZone },
          })
        }

        return tx.accountPreference.findUnique({
          where: { accountId: ctx.auth.user.id },
          select: accountPreferenceSelect,
        })
      })

      invalidateAccountCache(ctx.auth.user.id)
      return { preferences: parseAccountPreference(preferences) }
    }),

  /** Patch only the supplied account-preference fields. */
  updatePreferences: protectedProcedure
    .input(updatePreferencesInputSchema)
    .output(accountPreferenceOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const preferences = await prisma.accountPreference.upsert({
        where: { accountId: ctx.auth.user.id },
        create: {
          id: randomId(),
          accountId: ctx.auth.user.id,
          ...input,
        },
        update: input,
        select: accountPreferenceSelect,
      })
      invalidateAccountCache(ctx.auth.user.id)
      return { preferences: parseAccountPreference(preferences) }
    }),

  /** Update the display name. Used by the post-signup complete-profile flow. */
  // Update the current account's display name. Used by the
  // `complete-profile` flow that runs after a magic-link sign-up (or any
  // other first-time sign-in) when the account has no display name yet.
  updateProfile: protectedProcedure
    .input(
      z.object({
        name: z
          .string()
          .trim()
          .min(2, { error: 'nameTooShort' })
          .max(50, { error: 'max50' }),
      }),
    )
    .output(z.object({ account: accountProfileSchema }))
    .mutation(async ({ input, ctx }) => {
      const account = await prisma.account.update({
        where: { id: ctx.auth.user.id },
        data: { name: input.name },
        select: {
          id: true,
          name: true,
          email: true,
          emailVerified: true,
          isAnonymous: true,
          image: true,
        },
      })
      invalidateAccountCache(ctx.auth.user.id)
      return { account }
    }),

  /** Delete the profile avatar and clean up the S3 object. */
  removeProfileImage: protectedProcedure
    .output(z.object({ account: accountProfileSchema }))
    .mutation(async ({ ctx }) => {
      const existing = await prisma.account.findUnique({
        where: { id: ctx.auth.user.id },
        select: { image: true },
      })
      const account = await prisma.account.update({
        where: { id: ctx.auth.user.id },
        data: { image: null },
        select: {
          id: true,
          name: true,
          email: true,
          emailVerified: true,
          isAnonymous: true,
          image: true,
        },
      })
      invalidateAccountCache(ctx.auth.user.id)
      if (
        existing?.image &&
        isProfileImageUrlForAccount(existing.image, ctx.auth.user.id)
      ) {
        try {
          await deleteS3Object(existing.image)
        } catch (error) {
          console.warn('Failed to delete profile image:', error)
        }
      }
      return { account }
    }),

  /**
   * Set the profile avatar. `fileUrl` must come from
   * `uploads.profileImagePresign`.
   */
  setProfileImage: protectedProcedure
    .input(z.object({ fileUrl: z.string().url() }))
    .output(z.object({ account: accountProfileSchema }))
    .mutation(async ({ input, ctx }) => {
      if (
        !(await validateProfileImageUpload(input.fileUrl, ctx.auth.user.id))
      ) {
        if (isProfileImageUrlForAccount(input.fileUrl, ctx.auth.user.id)) {
          await deleteS3Object(input.fileUrl).catch(() => undefined)
        }
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Profile image upload is invalid',
        })
      }
      const existing = await prisma.account.findUnique({
        where: { id: ctx.auth.user.id },
        select: { image: true },
      })
      const account = await prisma.account.update({
        where: { id: ctx.auth.user.id },
        data: { image: input.fileUrl },
        select: {
          id: true,
          name: true,
          email: true,
          emailVerified: true,
          isAnonymous: true,
          image: true,
        },
      })
      invalidateAccountCache(ctx.auth.user.id)
      if (
        existing?.image &&
        isProfileImageUrlForAccount(existing.image, ctx.auth.user.id)
      ) {
        await deleteS3Object(existing.image).catch((error) =>
          console.warn('Failed to delete previous profile image:', error),
        )
      }
      return { account }
    }),

  /**
   * List the caller's groups. Skips archived and hidden unless
   * `includeArchived` is true.
   */
  // Account group memberships (active ones by default).
  groups: protectedProcedure
    .input(
      z
        .object({
          includeArchived: z
            .boolean()
            .describe('Include archived and hidden groups in the result.')
            .default(false),
        })
        .default({ includeArchived: false }),
    )
    .output(accountGroupsOutputSchema)
    .query(async ({ input: { includeArchived }, ctx }) => {
      const memberships = await prisma.groupMember.findMany({
        where: {
          accountId: ctx.auth.user.id,
          status: GroupMemberStatus.ACTIVE,
        },
        select: {
          groupId: true,
          role: true,
          group: {
            include: {
              ledger: {
                select: { id: true, currency: true, currencyCode: true },
              },
              _count: { select: { members: true } },
              members: {
                where: { status: GroupMemberStatus.ACTIVE },
                orderBy: { joinedAt: 'asc' },
                take: 4,
                select: {
                  account: { select: accountSummarySelect },
                },
              },
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }],
      })

      const groupIds = memberships.map((m) => m.groupId)
      const ledgerIds = memberships.map(
        (membership) => membership.group.ledger.id,
      )
      const [prefRecords, latestExpenseRows] = await Promise.all([
        prisma.accountGroupPreference.findMany({
          where: {
            accountId: ctx.auth.user.id,
            groupId: { in: groupIds },
          },
          select: {
            groupId: true,
            starred: true,
            hidden: true,
          },
        }),
        ledgerIds.length === 0
          ? Promise.resolve([])
          : prisma.expense.groupBy({
              by: ['ledgerId'],
              where: { ledgerId: { in: ledgerIds } },
              _max: { createdAt: true },
            }),
      ])
      const latestExpenseByLedgerId = new Map(
        latestExpenseRows.map((row) => [row.ledgerId, row._max.createdAt]),
      )
      const prefByGroupId = new Map(
        prefRecords.map((p) => [
          p.groupId,
          {
            starred: p.starred,
            hidden: p.hidden,
          },
        ]),
      )
      const defaultPref = {
        starred: false,
        hidden: false,
      }

      const friendGroupIds = memberships
        .filter((m) => m.group.groupType === GroupType.FRIEND)
        .map((m) => m.groupId)
      const friendPendingByGroupId = new Map<
        string,
        { name: string | null; email: string } | null
      >()
      if (friendGroupIds.length > 0) {
        const friendInvitations = await prisma.groupInvitation.findMany({
          where: {
            groupId: { in: friendGroupIds },
            status: GroupInvitationStatus.PENDING,
          },
          orderBy: { createdAt: 'desc' },
          select: {
            groupId: true,
            temporaryName: true,
            email: true,
          },
        })
        for (const inv of friendInvitations) {
          if (!friendPendingByGroupId.has(inv.groupId)) {
            friendPendingByGroupId.set(inv.groupId, {
              name: inv.temporaryName,
              email: inv.email,
            })
          }
        }
      }

      const entries = memberships.map((m) => {
        const isFriend = m.group.groupType === GroupType.FRIEND
        const friendAccount = isFriend
          ? (m.group.members.find(
              (member) => member.account.id !== ctx.auth.user.id,
            )?.account ?? null)
          : null
        const pendingInv = friendPendingByGroupId.get(m.groupId)
        const displayName = isFriend
          ? friendAccount?.name ||
            pendingInv?.name ||
            (pendingInv?.email
              ? getInvitationDisplayName({
                  email: pendingInv.email,
                  temporaryName: pendingInv.name,
                })
              : undefined) ||
            ''
          : m.group.name
        const { _count, members, ledger, ...group } = m.group
        return {
          ...group,
          createdAt: group.createdAt.toISOString(),
          latestExpenseCreatedAt:
            latestExpenseByLedgerId.get(ledger.id)?.toISOString() ?? null,
          ledger: {
            currency: ledger.currency,
            currencyCode: ledger.currencyCode,
          },
          // Prisma's relation-count key is `_count`; expose a plain public field.
          memberCount: _count.members,
          // The caller's role on this group. The web client uses it to gate
          // the group-level archive action (ADMIN only).
          currentMemberRole: m.role,
          preference: prefByGroupId.get(m.groupId) ?? defaultPref,
          displayName,
          friendAccount,
          memberAccounts: (members ?? [])
            .map((member) => member.account)
            // Friend ledgers: only show the other person's avatar, not the caller's.
            .filter((account) => !isFriend || account.id !== ctx.auth.user.id),
        }
      })

      // Default view: only non-archived groups that the user has not hidden.
      // When `includeArchived` is true, also return group-archived groups
      // and groups the user has hidden (both surface under the same toggle
      // on the /groups page). The FE sorts/groups them into the right
      // sections.
      const visible = entries.filter((entry) => {
        if (entry.preference.hidden && !includeArchived) return false
        if (entry.archived && !includeArchived) return false
        return true
      })

      return { groups: visible }
    }),

  // Server-backed preferences for a single group. The response uses `hidden`
  // for the per-account "hide" preference, which lives on the same-named
  // `AccountGroupPreference.hidden` column.
  preferences: protectedProcedure
    .input(z.object({ groupId: z.string().min(1) }))
    .output(accountGroupPreferencesOutputSchema)
    .query(async ({ input: { groupId }, ctx }) => {
      const pref = await prisma.accountGroupPreference.findUnique({
        where: {
          accountId_groupId: { accountId: ctx.auth.user.id, groupId },
        },
      })
      return {
        preferences: pref
          ? {
              starred: pref.starred,
              hidden: pref.hidden,
            }
          : { starred: false, hidden: false },
      }
    }),

  /** Set per-group UI preferences (starred, hidden) for the caller. */
  setPreference: protectedProcedure
    .input(
      z.object({
        groupId: z.string().min(1),
        starred: z.boolean().optional(),
        hidden: z.boolean().optional(),
      }),
    )
    .output(accountGroupPreferencesOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const data: { starred?: boolean; hidden?: boolean } = {}
      if (input.starred !== undefined) data.starred = input.starred
      if (input.hidden !== undefined) data.hidden = input.hidden
      const preference = await prisma.accountGroupPreference.upsert({
        where: {
          accountId_groupId: {
            accountId: ctx.auth.user.id,
            groupId: input.groupId,
          },
        },
        create: {
          id: randomId(),
          accountId: ctx.auth.user.id,
          groupId: input.groupId,
          ...data,
        },
        update: data,
      })
      return {
        preferences: {
          starred: preference.starred,
          hidden: preference.hidden,
        },
      }
    }),

  /** List active members of a group. Used by split-preset management. */
  // Members list for a group (active members). Used to render member
  // management UI.
  members: protectedProcedure
    .input(z.object({ groupId: z.string().min(1) }))
    .output(accountMembersOutputSchema)
    .query(async ({ input: { groupId }, ctx }) => {
      // Authorise as a member of the group.
      const member = await prisma.groupMember.findUnique({
        where: {
          groupId_accountId: { groupId, accountId: ctx.auth.user.id },
        },
      })
      if (!member || member.status !== GroupMemberStatus.ACTIVE) {
        return { members: [] }
      }
      const members = await prisma.groupMember.findMany({
        where: { groupId, status: GroupMemberStatus.ACTIVE },
        include: {
          account: {
            select: { id: true, name: true, email: true, image: true },
          },
          ledgerParticipant: { select: { id: true } },
        },
        orderBy: [{ joinedAt: 'asc' }, { createdAt: 'asc' }],
      })
      return { members }
    }),

  /**
   * List accounts the caller has shared groups with, ordered by shared group
   * count. When `groupId` is provided, each friend carries an `isMember` flag.
   */
  // Friends: accounts the current user has shared groups with,
  // ordered by number of shared groups descending. Excludes accounts
  // whose only email is a synthetic placeholder (cannot be invited
  // via email). When `groupId` is provided, each friend also carries
  // an `isMember` flag for "already a member" marking in the UI.
  friends: protectedProcedure
    .input(
      z
        .object({
          groupId: z.string().min(1).optional(),
        })
        .default({}),
    )
    .output(accountFriendsOutputSchema)
    .query(async ({ input: { groupId }, ctx }) => {
      const currentId = ctx.auth.user.id

      // All groups the current account has ever joined (excludes
      // PENDING invitations that never materialised).
      const myMemberships = await prisma.groupMember.findMany({
        where: {
          accountId: currentId,
          status: {
            in: [
              GroupMemberStatus.ACTIVE,
              GroupMemberStatus.LEFT,
              GroupMemberStatus.REMOVED,
            ],
          },
        },
        select: { groupId: true },
      })
      const myGroupIds = myMemberships.map((m) => m.groupId)

      if (myGroupIds.length === 0) {
        return { friends: [] }
      }

      // Other accounts that have also joined those groups.
      const coMembers = await prisma.groupMember.groupBy({
        by: ['accountId'],
        where: {
          groupId: { in: myGroupIds },
          accountId: { not: currentId },
          status: {
            in: [
              GroupMemberStatus.ACTIVE,
              GroupMemberStatus.LEFT,
              GroupMemberStatus.REMOVED,
            ],
          },
        },
        _count: { groupId: true },
        orderBy: { _count: { groupId: 'desc' } },
      })

      const accountIds = coMembers.map((c) => c.accountId)
      const accounts = await prisma.account.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, name: true, email: true, image: true },
      })
      const accountMap = new Map(accounts.map((a) => [a.id, a]))

      // Already-member lookup (ACTIVE memberships in the target group).
      let memberAccountIds = new Set<string>()
      // Pending invitations for contacts in the target group.
      let pendingInviteEmails = new Set<string>()
      if (groupId) {
        const existingMembers = await prisma.groupMember.findMany({
          where: {
            groupId,
            accountId: { in: accountIds },
            status: GroupMemberStatus.ACTIVE,
          },
          select: { accountId: true },
        })
        memberAccountIds = new Set(existingMembers.map((m) => m.accountId))

        const contactEmails = accounts
          .filter((a) => !isPlaceholderEmail(a.email))
          .map((a) => a.email.toLowerCase())
        if (contactEmails.length > 0) {
          const pendingInvites = await prisma.groupInvitation.findMany({
            where: {
              groupId,
              status: GroupInvitationStatus.PENDING,
              email: { in: contactEmails, mode: 'insensitive' },
            },
            select: { email: true },
          })
          pendingInviteEmails = new Set(
            pendingInvites.map((i) => i.email.toLowerCase()),
          )
        }
      }

      // Friend-ledger lookup. A friend is considered "ledgered" if there
      // is either a FRIEND-typed group whose friendPairKey matches the
      // caller+friend pair, or a PENDING FRIEND email invitation from the
      // caller targeting the friend's email.
      const friendEmailPairs = accounts
        .filter((a) => !isPlaceholderEmail(a.email))
        .map((a) => {
          const key =
            currentId < a.id ? `${currentId}:${a.id}` : `${a.id}:${currentId}`
          return { accountId: a.id, pairKey: key, email: a.email.toLowerCase() }
        })
      const activeLedgerByAccountId = new Map<string, boolean>()
      const pendingLedgerByAccountId = new Map<string, boolean>()
      if (friendEmailPairs.length > 0) {
        const pairKeys = friendEmailPairs.map((p) => p.pairKey)
        const friendGroups = await prisma.group.findMany({
          where: {
            groupType: GroupType.FRIEND,
            friendPairKey: { in: pairKeys },
          },
          select: { friendPairKey: true },
        })
        const linkedPairKeys = new Set(
          friendGroups.map((g) => g.friendPairKey!).filter(Boolean),
        )
        for (const pair of friendEmailPairs) {
          if (linkedPairKeys.has(pair.pairKey)) {
            activeLedgerByAccountId.set(pair.accountId, true)
          }
        }
        const emailsToCheck = friendEmailPairs.filter(
          (p) => !activeLedgerByAccountId.has(p.accountId),
        )
        if (emailsToCheck.length > 0) {
          const pendingFriendInvites = await prisma.groupInvitation.findMany({
            where: {
              type: GroupInvitationType.EMAIL,
              status: GroupInvitationStatus.PENDING,
              invitedById: currentId,
              group: { groupType: GroupType.FRIEND },
              email: {
                in: emailsToCheck.map((p) => p.email),
                mode: 'insensitive',
              },
            },
            select: { email: true },
          })
          const pendingEmails = new Set(
            pendingFriendInvites.map((i) => i.email.toLowerCase()),
          )
          for (const pair of emailsToCheck) {
            if (pendingEmails.has(pair.email)) {
              pendingLedgerByAccountId.set(pair.accountId, true)
            }
          }
        }
      }

      const friends = coMembers
        .map((c) => {
          const account = accountMap.get(c.accountId)
          if (!account || isPlaceholderEmail(account.email)) return null
          let friendLedgerStatus: 'NONE' | 'INVITED' | 'ACTIVE' = 'NONE'
          if (activeLedgerByAccountId.has(account.id)) {
            friendLedgerStatus = 'ACTIVE'
          } else if (pendingLedgerByAccountId.has(account.id)) {
            friendLedgerStatus = 'INVITED'
          }
          return {
            accountId: account.id,
            name: account.name,
            email: account.email,
            sharedGroupCount: c._count.groupId,
            isMember: memberAccountIds.has(account.id),
            isPendingInvite: pendingInviteEmails.has(
              account.email.toLowerCase(),
            ),
            hasFriendLedger:
              activeLedgerByAccountId.has(account.id) ||
              pendingLedgerByAccountId.has(account.id),
            friendLedgerStatus,
          }
        })
        .filter((c): c is NonNullable<typeof c> => c !== null)

      return { friends }
    }),
})
