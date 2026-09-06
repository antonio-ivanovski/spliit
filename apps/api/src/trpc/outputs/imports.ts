import { z } from 'zod'

import { recurrenceConfigSchema } from '@spliit/domain'

const normalizedSourceParticipantSchema = z.object({
  sourceId: z.string(),
  sourceName: z.string(),
})

const normalizedSourceExpenseSchema = z.object({
  sourceId: z.string().nullable().optional(),
  sourceCreatedAt: z.string().nullable().optional(),
  title: z.string(),
  expenseDate: z.string(),
  category: z.string(),
  amountCurrency: z.string().nullable(),
  amount: z.number().int(),
  originalAmount: z.number().int().nullable(),
  originalCurrency: z.string().nullable(),
  conversionRate: z.number().nullable(),
  paidBySourceId: z.string(),
  paidBy: z.array(z.object({ sourceId: z.string(), shares: z.number().int() })),
  paidFor: z.array(
    z.object({ sourceId: z.string(), shares: z.number().int() }),
  ),
  splitMode: z.enum(['EVENLY', 'BY_SHARES', 'BY_PERCENTAGE', 'BY_AMOUNT']),
  recurrenceRule: z.enum(['NONE', 'DAILY', 'WEEKLY', 'MONTHLY']),
  recurrence: recurrenceConfigSchema.nullable().optional(),
  notes: z.string().nullable(),
  sourceDocuments: z
    .array(
      z.object({
        sourceId: z.string(),
        sourceUrl: z.url(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      }),
    )
    .optional(),
})

export const normalizedSourceSchema = z.object({
  provider: z.enum(['SPLIIT', 'SPLITWISE', 'COSPEND']),
  exportVersion: z.literal(3).nullable().optional(),
  sourceGroupId: z.string(),
  sourceUrl: z.string().nullable(),
  name: z.string(),
  information: z.string().nullable().optional(),
  currency: z.string(),
  currencyCode: z.string().nullable(),
  participants: z.array(normalizedSourceParticipantSchema),
  expenses: z.array(normalizedSourceExpenseSchema),
  documentSource: z.enum(['EMBEDDED', 'DISCOVERY', 'NONE']).optional(),
  activities: z
    .array(
      z.object({
        time: z.iso.datetime(),
        activityType: z.enum([
          'UPDATE_GROUP',
          'CREATE_EXPENSE',
          'UPDATE_EXPENSE',
          'DELETE_EXPENSE',
        ]),
        participantSourceId: z.string().nullable(),
        expenseSourceId: z.string().nullable(),
        data: z.string().nullable(),
      }),
    )
    .optional(),
})

export const lookupGroupOutputSchema = z.object({
  status: z.literal('IMPORTABLE'),
  sourceProvider: z.literal('SPLIIT'),
  sourceUrl: z.url(),
  sourceGroupId: z.string(),
  source: normalizedSourceSchema,
})

export const importGroupOutputSchema = z.object({
  groupId: z.string(),
  ledgerId: z.string(),
  importedExpenses: z.number().int().nonnegative(),
  importedDocuments: z.number().int().nonnegative(),
  sourceGroupId: z.string().nullable(),
  invites: z.array(
    z.object({
      sourceName: z.string(),
      kind: z.enum(['EMAIL', 'LINK']),
      invitationId: z.string(),
      inviteUrl: z.string().url().optional(),
      email: z.string().email().optional(),
    }),
  ),
})

export const importCloudBundleOutputSchema = importGroupOutputSchema.extend({
  sourceGroupId: z.string(),
})

export const importPreviewOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('OK'), source: normalizedSourceSchema }),
  z.object({ kind: z.literal('NOT_FOUND') }),
  z.object({ kind: z.literal('ERROR'), message: z.string() }),
])
