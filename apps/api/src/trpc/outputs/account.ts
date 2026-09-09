import { z } from 'zod'

import { accountPreferenceSchema } from '@spliit/domain'

import {
  accountContactSchema,
  accountProfileSchema,
  accountSummarySchema,
  groupRoleSchema,
  groupTypeSchema,
} from './common'

export { accountProfileSchema }

export const accountGroupPreferenceSchema = z.object({
  starred: z.boolean(),
  hidden: z.boolean(),
})

export const accountGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  information: z.string().nullable(),
  archived: z.boolean(),
  createdAt: z.string(),
  groupType: groupTypeSchema.default('GROUP'),
  ledger: z.object({
    currency: z.string(),
    currencyCode: z.string().nullable(),
  }),
  memberCount: z.number().int().nonnegative(),
  currentMemberRole: groupRoleSchema,
  preference: accountGroupPreferenceSchema,
  displayName: z.string(),
  friendAccount: accountSummarySchema.nullable(),
  memberAccounts: z.array(accountSummarySchema),
})

export const accountMemberSchema = z.object({
  id: z.string(),
  groupId: z.string(),
  accountId: z.string(),
  role: z.enum(['ADMIN', 'MEMBER']),
  status: z.enum(['PENDING', 'ACTIVE', 'LEFT', 'REMOVED', 'SUSPENDED']),
  joinedAt: z.date().nullable(),
  leftAt: z.date().nullable(),
  account: accountContactSchema,
  ledgerParticipant: z.object({ id: z.string() }).nullable(),
})

export const accountGroupPreferencesOutputSchema = z.object({
  preferences: accountGroupPreferenceSchema,
})

export const accountPreferenceOutputSchema = z.object({
  preferences: accountPreferenceSchema,
})

export const accountGroupWithLatestExpenseSchema = accountGroupSchema.extend({
  latestExpenseCreatedAt: z.string().nullable(),
})

export const accountGroupsOutputSchema = z.object({
  groups: z.array(accountGroupWithLatestExpenseSchema),
})

export const accountMembersOutputSchema = z.object({
  members: z.array(accountMemberSchema),
})

export const accountFriendsOutputSchema = z.object({
  friends: z.array(
    z.object({
      accountId: z.string(),
      name: z.string(),
      email: z.string(),
      sharedGroupCount: z.number().int(),
      isMember: z.boolean(),
      isPendingInvite: z.boolean(),
      hasFriendLedger: z.boolean(),
      friendLedgerStatus: z.enum(['NONE', 'INVITED', 'ACTIVE']),
    }),
  ),
})

export const authorizedClientSchema = z.object({
  consentId: z.string(),
  clientId: z.string(),
  name: z.string().nullable(),
  icon: z.string().nullable(),
  scopes: z.array(z.string()),
  authorizedAt: z.date().nullable(),
  activeUntil: z.date().nullable(),
})

export const authorizedClientsOutputSchema = z.object({
  clients: z.array(authorizedClientSchema),
})

export const revokeAuthorizedClientOutputSchema = z.object({
  refreshTokensRevoked: z.number().int(),
  accessTokensDeleted: z.number().int(),
  authorizationCodesDeleted: z.number().int(),
})
