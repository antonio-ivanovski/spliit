import { z } from 'zod'

import {
  categoryIdSchema,
  recurrenceFrequencySchema,
  RecurringExpenseSeriesStatus,
  timeZoneSchema,
} from '@spliit/domain'

const splitModeSchema = z.enum([
  'EVENLY',
  'BY_SHARES',
  'BY_PERCENTAGE',
  'BY_AMOUNT',
  'ITEMIZED',
])

const recurringSeriesStatusSchema = z.enum([
  RecurringExpenseSeriesStatus.ACTIVE,
  RecurringExpenseSeriesStatus.PAUSED,
  RecurringExpenseSeriesStatus.COMPLETED,
  RecurringExpenseSeriesStatus.CANCELLED,
])

const recurrenceResponseSchema = z.object({
  frequency: recurrenceFrequencySchema,
  interval: z.number().int(),
  end: z.discriminatedUnion('type', [
    z.object({ type: z.literal('INDEFINITE') }),
    z.object({ type: z.literal('COUNT'), count: z.number().int() }),
    z.object({ type: z.literal('DATE'), endDate: z.date() }),
  ]),
})

const categoryResponseSchema = z.object({
  id: categoryIdSchema,
  grouping: z.string(),
  name: z.string(),
})

const expenseDocumentResponseSchema = z.object({
  id: z.string(),
  url: z.string(),
  fileName: z.string().nullable(),
  contentType: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
})

const participantShareResponseSchema = z.object({
  ledgerParticipantId: z.string(),
  shares: z.number().int(),
})

const participantDisplayResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  account: z
    .object({
      id: z.string(),
      name: z.string(),
      image: z.string().nullable(),
    })
    .nullable(),
  removed: z.boolean(),
})

const listParticipantResponseSchema = z.object({
  ledgerParticipant: participantDisplayResponseSchema,
  shares: z.number().int(),
})

const listItemResponseSchema = z.object({
  id: z.string(),
  title: z.string(),
  amount: z.number().int(),
})

const getItemResponseSchema = z.object({
  id: z.string(),
  title: z.string(),
  unitPrice: z.number().int(),
  quantity: z.number().int(),
  amount: z.number().int(),
  splitMode: splitModeSchema,
  paidFor: z.array(participantShareResponseSchema),
})

const itemizedRemainderGetResponseSchema = z.object({
  splitMode: splitModeSchema,
  paidFor: z.array(participantShareResponseSchema),
})

const recurringSeriesResponseSchema = z.object({
  id: z.string(),
  frequency: recurrenceFrequencySchema,
  interval: z.number().int(),
  endType: z.enum(['INDEFINITE', 'COUNT', 'DATE']),
  occurrenceLimit: z.number().int().nullable(),
  endDate: z.date().nullable(),
  status: recurringSeriesStatusSchema,
  anchorDate: z.date(),
  nextOccurrenceDate: z.date(),
})

const expenseCommonFieldsSchema = {
  id: z.string(),
  title: z.string(),
  amount: z.number().int(),
  expenseDate: z.date(),
  expenseTimeZone: timeZoneSchema,
  categoryId: categoryIdSchema,
  category: categoryResponseSchema,
  splitMode: splitModeSchema,
  paidBySplitMode: splitModeSchema,
  originalAmount: z.number().int().nullable(),
  originalCurrency: z.string().nullable(),
  conversionRate: z.number().nullable(),
  conversionSource: z.enum(['EXCHANGE', 'CUSTOM']).nullable(),
  originType: z.string().nullable(),
  recurrenceSequence: z.number().int().nullable(),
  items: z.array(listItemResponseSchema),
  permissions: z.object({
    canEdit: z.boolean(),
    canDelete: z.boolean(),
    canManageRecurrence: z.boolean(),
  }),
}

export const expenseListItemResponseSchema = z.object({
  ...expenseCommonFieldsSchema,
  createdAt: z.date(),
  paidByList: z.array(listParticipantResponseSchema),
  paidFor: z.array(listParticipantResponseSchema),
  recurringSeriesId: z.string().nullable(),
  recurringSeriesStatus: recurringSeriesStatusSchema.nullable(),
  documentCount: z.number().int().nonnegative(),
})

export const expenseGetResponseSchema = z.object({
  ...expenseCommonFieldsSchema,
  version: z.number().int().positive(),
  createdAt: z.date(),
  notes: z.string().nullable(),
  documents: z.array(expenseDocumentResponseSchema),
  paidByList: z.array(participantShareResponseSchema),
  paidFor: z.array(participantShareResponseSchema),
  items: z.array(getItemResponseSchema),
  itemizedRemainder: itemizedRemainderGetResponseSchema.nullable(),
  recurringSeriesId: z.string().nullable(),
  recurringSeries: recurringSeriesResponseSchema.nullable(),
  recurrence: recurrenceResponseSchema.nullable(),
  previousExpenseId: z.string().nullable(),
  nextExpenseId: z.string().nullable(),
})

export const listExpensesOutputSchema = z.object({
  expenses: z.array(expenseListItemResponseSchema),
  hasMore: z.boolean(),
  nextCursor: z.number().int(),
})

export const getExpenseOutputSchema = z.object({
  expense: expenseGetResponseSchema,
})

export const createExpenseOutputSchema = z.object({
  expenseId: z.string(),
  recurringSeriesId: z.string().nullable(),
})

export const updateExpenseOutputSchema = z.object({
  expenseId: z.string(),
  version: z.number().int().positive(),
})

export const deleteExpenseOutputSchema = z.object({})

export const commonCurrenciesOutputSchema = z.object({
  currencies: z.array(z.string()),
})

export const bulkUpdateCategoriesOutputSchema = z.object({
  applied: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  distinctCategories: z.number().int().nonnegative(),
  rows: z.array(
    z.object({
      expenseId: z.string(),
      title: z.string(),
      fromCategoryId: categoryIdSchema,
      toCategoryId: categoryIdSchema,
    }),
  ),
})

const recurringOccurrenceResponseSchema = z.object({
  id: z.string(),
  expenseDate: z.date(),
  expenseTimeZone: timeZoneSchema,
  recurrenceSequence: z.number().int().nullable(),
  title: z.string(),
  amount: z.number().int(),
})

const recurringSeriesListItemResponseSchema = z.object({
  id: z.string(),
  timeZone: z.string(),
  frequency: recurrenceFrequencySchema,
  interval: z.number().int(),
  anchorDate: z.date(),
  nextOccurrenceDate: z.date(),
  endType: z.enum(['INDEFINITE', 'COUNT', 'DATE']),
  occurrenceLimit: z.number().int().nullable(),
  endDate: z.date().nullable(),
  occurrencesCreated: z.number().int(),
  status: recurringSeriesStatusSchema,
  recurrence: recurrenceResponseSchema,
  expenses: z.array(recurringOccurrenceResponseSchema),
  hasMoreOccurrences: z.boolean(),
  nextOccurrenceCursor: z.number().int().nullable(),
})

export const listRecurringExpenseSeriesOutputSchema = z.object({
  series: z.array(recurringSeriesListItemResponseSchema),
  nextCursor: z.string().nullable(),
})

export const recurringSeriesProgressOutputSchema = z
  .object({
    seriesId: z.string(),
    status: z.string(),
    occurrencesCreated: z.number().int(),
    nextOccurrenceDate: z.string(),
    dueThrough: z.string().nullable(),
    pending: z.boolean(),
  })
  .nullable()
