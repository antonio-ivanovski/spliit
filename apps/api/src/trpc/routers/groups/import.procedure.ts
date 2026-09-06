import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { GroupRole, GroupType } from '@spliit/db'
import { expenseApiSchema, groupFormSchema } from '@spliit/domain'

import {
  CREATE_OPERATIONS,
  createRequestIdSchema,
  deriveCreateToken,
  runIdempotentCreate,
} from '../../../lib/api/idempotency'
import { importGroup, prepareImportGroup } from '../../../lib/api/import'
import { getWebBaseUrl } from '../../../lib/auth/urls'
import { enqueueBudgetEvaluation } from '../../../lib/budgets/enqueue'
import { ConversionError } from '../../../lib/expense-conversion'
import { sendInvitationEmail } from '../../../lib/invitations'
import { deleteS3Object } from '../../../routes/upload'
import { importProcedure, loadGroupMutationContext } from '../../init'
import { importGroupOutputSchema } from '../../outputs/imports'

// `sourceName` is the imported participant's display label. It is required for
// every mapping mode because unlinked/import-created rows use it as their
// LedgerParticipant.displayName (the same 120-character boundary as the
// direct name-only participant mutation).
const importParticipantMappingSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('LINK_ACCOUNT'),
    sourceName: z.string().trim().min(1).max(120),
    linkedAccountId: z.string().min(1),
    destLedgerParticipantId: z.string().min(1),
  }),
  z.object({
    mode: z.literal('INVITE_BY_EMAIL'),
    sourceName: z.string().trim().min(1).max(120),
    email: z.email(),
    destLedgerParticipantId: z.string().min(1),
  }),
  z.object({
    mode: z.literal('INVITE_BY_LINK'),
    sourceName: z.string().trim().min(1).max(120),
    destLedgerParticipantId: z.string().min(1),
  }),
  z.object({
    mode: z.literal('UNLINKED_PARTICIPANT'),
    sourceName: z.string().trim().min(1).max(120),
    destLedgerParticipantId: z.string().min(1),
  }),
  z.object({
    mode: z.literal('LINK_EXISTING_PARTICIPANT'),
    sourceName: z.string().trim().min(1).max(120),
    destLedgerParticipantId: z.string().min(1),
  }),
  z.object({
    mode: z.literal('INVITE_CONTACT'),
    sourceName: z.string().trim().min(1).max(120),
    email: z.email(),
    destLedgerParticipantId: z.string().min(1),
  }),
])

const importSourceMetaSchema = z.object({
  provider: z.string().min(1),
  sourceGroupId: z.string().min(1),
  sourceUrl: z.url().optional(),
})

const historicalActivitySchema = z.object({
  time: z.coerce.date(),
  activityType: z.enum([
    'UPDATE_GROUP',
    'CREATE_EXPENSE',
    'UPDATE_EXPENSE',
    'DELETE_EXPENSE',
  ]),
  actorParticipantId: z.string().min(1).nullable(),
  expenseIndex: z.number().int().nonnegative().nullable(),
  data: z.string().nullable(),
})

/**
 * Imports carry the legacy `recurrenceRule` plus, when the source supports it,
 * an authoritative `recurrence` config (frequency + interval + end). The config
 * is validated by `expenseApiSchema` and preferred over the legacy rule when
 * planning destination series (e.g. Cospend's yearly / multi-interval /
 * dated-end schedules). `expenseTimeZone` is always normalized to UTC.
 */
export const importExpenseSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const { expenseTimeZone: _expenseTimeZone, ...expense } = value as Record<
    string,
    unknown
  >
  const rawExpenseDate = expense.expenseDate
  const expenseDate =
    rawExpenseDate instanceof Date
      ? rawExpenseDate
      : typeof rawExpenseDate === 'string' || typeof rawExpenseDate === 'number'
        ? new Date(rawExpenseDate)
        : null
  if (!expenseDate || Number.isNaN(expenseDate.getTime())) return expense

  return {
    ...expense,
    expenseDate: new Date(
      Date.UTC(
        expenseDate.getUTCFullYear(),
        expenseDate.getUTCMonth(),
        expenseDate.getUTCDate(),
        12,
      ),
    ),
    expenseTimeZone: 'UTC',
  }
}, expenseApiSchema)

export const importGroupProcedure = importProcedure
  .input(
    z
      .object({
        requestId: createRequestIdSchema,
        targetGroupId: z
          .string()
          .min(1)
          .optional()
          .describe(
            'When set, merge imported data into this group instead of creating a new one.',
          ),
        groupFormValues: groupFormSchema.optional(),
        participants: z.array(importParticipantMappingSchema).min(1),
        expenses: z.array(importExpenseSchema).min(0).default([]),
        sourceMeta: importSourceMetaSchema.optional(),
        historicalActivities: z.array(historicalActivitySchema).optional(),
        documentImport: z
          .object({
            sessionId: z.uuid(),
            stagedTokens: z.array(z.string().min(1)),
          })
          .optional(),
      })
      .superRefine((value, ctx) => {
        if (!value.targetGroupId && !value.groupFormValues) {
          ctx.addIssue({
            code: 'custom',
            message: 'Either targetGroupId or groupFormValues is required',
            path: ['targetGroupId'],
          })
        }
        const seen = new Set<string>()
        const destinationParticipantIds = new Set(
          value.participants.map((mapping) => mapping.destLedgerParticipantId),
        )
        for (const [i, mapping] of value.participants.entries()) {
          const key = mapping.sourceName.toLowerCase()
          if (seen.has(key)) {
            ctx.addIssue({
              code: 'custom',
              message: 'Duplicate source participant name',
              path: ['participants', i, 'sourceName'],
            })
          }
          seen.add(key)
        }
        for (const [i, activity] of (
          value.historicalActivities ?? []
        ).entries()) {
          if (
            activity.actorParticipantId &&
            !destinationParticipantIds.has(activity.actorParticipantId)
          ) {
            ctx.addIssue({
              code: 'custom',
              message:
                'Historical activity actor is not an imported participant',
              path: ['historicalActivities', i, 'actorParticipantId'],
            })
          }
          if (
            activity.expenseIndex !== null &&
            activity.expenseIndex >= value.expenses.length
          ) {
            ctx.addIssue({
              code: 'custom',
              message: 'Historical activity references an unknown expense',
              path: ['historicalActivities', i, 'expenseIndex'],
            })
          }
        }
      }),
  )
  .output(importGroupOutputSchema)
  .mutation(async ({ input, ctx }) => {
    if (input.targetGroupId) {
      const { group, member } = await loadGroupMutationContext({
        groupId: input.targetGroupId,
        accountId: ctx.auth.user.id,
      })
      if (member.role !== GroupRole.ADMIN) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only admins can import into an existing group',
        })
      }
      if (group.groupType === GroupType.FRIEND) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Friend ledger imports are not supported',
        })
      }
    }

    let preparedImport:
      | Awaited<ReturnType<typeof prepareImportGroup>>
      | undefined
    let importCommitted = false
    try {
      const { value: result, replayed } = await runIdempotentCreate({
        accountId: ctx.auth.user.id,
        operation: CREATE_OPERATIONS.import,
        requestId: input.requestId,
        input: { ...input, requestId: undefined },
        prepare: async () => {
          preparedImport = await prepareImportGroup(input as never, {
            accountId: ctx.auth.user.id,
            idempotencyRequestId: input.requestId,
          })
          return preparedImport
        },
        execute: (tx, prepared) =>
          importGroup(
            input as never,
            {
              accountId: ctx.auth.user.id,
              idempotencyRequestId: input.requestId,
            },
            { prepared, tx },
          ),
        encode: (created) => {
          const { emailDispatches: _emailDispatches, ...replayResult } = created
          return {
            ...replayResult,
            invites: created.invites.map(
              ({ inviteUrl: _inviteUrl, ...invite }) => invite,
            ),
          }
        },
        decode: (stored) => {
          const created = stored as Awaited<ReturnType<typeof importGroup>>
          return {
            ...created,
            invites: created.invites.map((invite) =>
              invite.kind === 'LINK'
                ? {
                    ...invite,
                    inviteUrl: `${getWebBaseUrl()}/groups/${deriveCreateToken({
                      accountId: ctx.auth.user.id,
                      operation: CREATE_OPERATIONS.import,
                      requestId: input.requestId,
                      discriminator: `import-link:${invite.sourceName}`,
                    })}`,
                  }
                : invite,
            ),
          }
        },
      })
      importCommitted = true
      if (!replayed && preparedImport) {
        await Promise.allSettled(
          preparedImport.stagedDocumentUrls.map((url) => deleteS3Object(url)),
        )
      }
      if (!replayed && result.importedExpenses > 0)
        await enqueueBudgetEvaluation(result.groupId)
      if (!replayed) {
        await Promise.all(
          (result.emailDispatches ?? []).map((email) =>
            sendInvitationEmail({
              ...email,
              senderAccountId: ctx.auth.user.id,
            }),
          ),
        )
      }
      const { emailDispatches: _emailDispatches, ...response } = result
      return response
    } catch (err) {
      if (!importCommitted && preparedImport) {
        await Promise.allSettled(
          preparedImport.promotedDocumentUrls.map((url) => deleteS3Object(url)),
        )
      }
      if (err instanceof TRPCError) throw err
      if (err instanceof ConversionError) {
        throw new TRPCError({
          code:
            err.code === 'PROVIDER_UNAVAILABLE' ? 'BAD_GATEWAY' : 'BAD_REQUEST',
          message: err.message,
        })
      }
      const message = err instanceof Error ? err.message : 'Import failed'
      if (/archived/i.test(message)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message })
      }
      if (/not found/i.test(message)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message })
      }
      throw new TRPCError({ code: 'BAD_REQUEST', message })
    }
  })
