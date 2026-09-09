import * as z from 'zod'

import { categoryIdSchema } from '../categories'
import { conversionSourceSchema } from '../conversion'

export const expenseChangedFields = [
  'title',
  'amount',
  'date',
  'category',
  'notes',
  'payers',
  'split',
  'items',
  'documents',
  'recurrence',
  'settlement',
  /** Legacy alias for stored activity payloads that used `reimbursement`. */
  'reimbursement',
  'conversionSource',
  'conversionRate',
] as const
export const expenseChangedFieldSchema = z.enum(expenseChangedFields)
export type ExpenseChangedField = z.infer<typeof expenseChangedFieldSchema>

/** A single human-readable before/after change row for the activity feed. */
export const expenseActivityChangeSchema = z.object({
  field: expenseChangedFieldSchema,
  before: z.string().nullable().optional(),
  after: z.string().nullable().optional(),
})
export type ExpenseActivityChange = z.infer<typeof expenseActivityChangeSchema>

/**
 * Metadata attached to individual recurring expense activities so the feed can
 * render recurrence context without reloading the series row.
 */
export const recurrenceActivityMetadataSchema = z.object({
  seriesId: z.string(),
  frequency: z.string(),
  interval: z.number().int().positive(),
  endType: z.string(),
  occurrenceLimit: z.number().int().positive().nullable().optional(),
  endDate: z.string().nullable().optional(),
})
export type RecurrenceActivityMetadata = z.infer<
  typeof recurrenceActivityMetadataSchema
>

export const expenseActivityDataSchema = z.object({
  kind: z.literal('expense'),
  summary: z.string().optional(),
  title: z.string().optional(),
  // Amount is integer cents in the ledger base currency.
  amount: z.number().int().optional(),
  currencyCode: z.string().nullable().optional(),
  date: z.string().optional(),
  changedFields: z.array(expenseChangedFieldSchema).optional(),
  // Per-field before/after change rows for the activity feed.
  changes: z.array(expenseActivityChangeSchema).optional(),
  // Ledger participant IDs affected by the expense. Set for
  // EXPENSE_DELETED so the dispatcher can resolve recipients.
  affectedParticipants: z.array(z.string()).optional(),
  // Original currency amount (before conversion), if the expense was
  // entered in a different currency than the ledger's base currency.
  originalAmount: z.number().int().optional(),
  conversionRate: z.number().optional(),
  // EXCHANGE | CUSTOM — how the ledger amount was derived (absent = same currency).
  conversionSource: conversionSourceSchema.optional(),
  // The ledger's base currency code.
  ledgerCurrencyCode: z.string().nullable().optional(),
  // Recurrence metadata for RECURRING_EXPENSE_CREATED activities.
  recurrence: recurrenceActivityMetadataSchema.optional(),
  // Whether the recurrence was also stopped (delete-and-stop).
  stopped: z.boolean().optional(),
})

export type ExpenseActivityData = z.infer<typeof expenseActivityDataSchema>

/** Payload for an expense comment activity. */
export const expenseCommentActivityDataSchema = z.object({
  kind: z.literal('expense_comment'),
  commentId: z.string().min(1),
  expenseTitle: z.string(),
  authorName: z.string(),
  excerpt: z.string().max(160),
})

export type ExpenseCommentActivityData = z.infer<
  typeof expenseCommentActivityDataSchema
>

export const groupChangedFields = [
  'name',
  'information',
  'currency',
  'currencyCode',
  'linkedParticipant',
  'subgroupsEnabled',
  'publicViewLink',
] as const
export const groupChangedFieldSchema = z.enum(groupChangedFields)
export type GroupChangedField = z.infer<typeof groupChangedFieldSchema>

export const groupActivityChangeSchema = z.object({
  field: groupChangedFieldSchema,
  before: z.string().nullable().optional(),
  after: z.string().nullable().optional(),
})
export type GroupActivityChange = z.infer<typeof groupActivityChangeSchema>

export const groupActivityDataSchema = z.object({
  kind: z.literal('group'),
  summary: z.string().optional(),
  changedFields: z.array(groupChangedFieldSchema).optional(),
  changes: z.array(groupActivityChangeSchema).optional(),
})

export type GroupActivityData = z.infer<typeof groupActivityDataSchema>

export const groupRoleSchema = z.enum(['ADMIN', 'MEMBER'])
export type GroupRole = z.infer<typeof groupRoleSchema>

export const memberActivityDataSchema = z.object({
  kind: z.literal('member'),
  summary: z.string().optional(),
  displayName: z.string().optional(),
  previousRole: groupRoleSchema.optional(),
  nextRole: groupRoleSchema.optional(),
  targetDisplayName: z.string().optional(),
})

export type MemberActivityData = z.infer<typeof memberActivityDataSchema>

export const invitationTypeSchema = z.enum(['EMAIL', 'LINK'])
export type InvitationType = z.infer<typeof invitationTypeSchema>

export const invitationChangedFields = [
  'deliveryType',
  'destination',
  'displayName',
  'role',
  'credential',
] as const
export const invitationChangedFieldSchema = z.enum(invitationChangedFields)
export type InvitationChangedField = z.infer<
  typeof invitationChangedFieldSchema
>

/**
 * A single before/after change row for an invitation update. Only display-safe
 * values are persisted: real emails and names, never raw link tokens or token
 * hashes. Link credential rotation is represented as a `credential` change with
 * no value payload.
 */
export const invitationActivityChangeSchema = z.object({
  field: invitationChangedFieldSchema,
  before: z.string().nullable().optional(),
  after: z.string().nullable().optional(),
})
export type InvitationActivityChange = z.infer<
  typeof invitationActivityChangeSchema
>

export const invitationActivityDataSchema = z.object({
  kind: z.literal('invitation'),
  summary: z.string().optional(),
  displayLabel: z.string().optional(),
  invitationType: invitationTypeSchema.optional(),
  role: groupRoleSchema.optional(),
  changedFields: z.array(invitationChangedFieldSchema).optional(),
  changes: z.array(invitationActivityChangeSchema).optional(),
})

export type InvitationActivityData = z.infer<
  typeof invitationActivityDataSchema
>

/**
 * Summary data for a bulk import of expenses (e.g. from Splitwise). The
 * activity log records one such row per import so the feed can show "Alice
 * imported 25 expenses from Splitwise" once instead of N rows, while a single
 * notification fan-outs to all affected active members.
 */
export const importSummaryActivityDataSchema = z.object({
  kind: z.literal('import_summary'),
  summary: z.string().optional(),
  count: z.number().int().nonnegative(),
  // Signed ledger total: refunds/credits are represented as negative
  // expenses by generic statement imports.
  totalAmount: z.number().int().optional(),
  currencyCode: z.string().nullable().optional(),
  sourceProvider: z.string().optional(),
  // Ledger participant IDs affected by the imported expenses. Used by
  // the notification dispatcher to resolve recipients without having
  // to reload every expense from the DB.
  affectedParticipants: z.array(z.string()).optional(),
})

export type ImportSummaryActivityData = z.infer<
  typeof importSummaryActivityDataSchema
>

/**
 * One-line summary of a bulk category reassignment (e.g. the admin utility that
 * classifies every expense on `general` in one pass). The feed records a single
 * row per save — instead of one row per expense — and stores enough metadata
 * for the UI to render an expandable list of the affected expenses and their
 * previous categories.
 */
export const expenseCategoriesBulkUpdatedRowSchema = z.object({
  expenseId: z.string().min(1),
  title: z.string().optional(),
  fromCategoryId: categoryIdSchema,
  toCategoryId: categoryIdSchema,
})
export type ExpenseCategoriesBulkUpdatedRow = z.infer<
  typeof expenseCategoriesBulkUpdatedRowSchema
>

export const expenseCategoriesBulkUpdatedActivityDataSchema = z.object({
  kind: z.literal('expense_categories_bulk_updated'),
  summary: z.string().optional(),
  count: z.number().int().nonnegative(),
  distinctCategories: z.number().int().nonnegative().optional(),
  rows: z.array(expenseCategoriesBulkUpdatedRowSchema).max(2000),
  fromCategoryId: categoryIdSchema,
  triggeredByAiConfidence: z.boolean().optional(),
})

export type ExpenseCategoriesBulkUpdatedActivityData = z.infer<
  typeof expenseCategoriesBulkUpdatedActivityDataSchema
>

/**
 * Notification-only summary emitted when a recurring series catches up two or
 * more overdue occurrences, or when a bulk recurring mutation (edit/delete)
 * affects multiple materialized expenses. The individual occurrence activities
 * remain in the activity feed; this payload only controls delivery fan-out.
 */
export const recurringExpenseSummaryActivityDataSchema = z.object({
  kind: z.literal('recurring_expense_summary'),
  summary: z.string().optional(),
  title: z.string().optional(),
  count: z.number().int().positive(),
  startDate: z.string(),
  endDate: z.string(),
  /** Participant scope shared by every occurrence in the coalesced batch. */
  affectedParticipants: z.array(z.string()).optional(),
  /** Series identifier for the recurring schedule. */
  seriesId: z.string().optional(),
  /** Human-renderable cadence: frequency and interval. */
  frequency: z.string().optional(),
  interval: z.number().int().positive().optional(),
  /** Termination kind plus count/end date where applicable. */
  endType: z.string().optional(),
  occurrenceLimit: z.number().int().positive().nullable().optional(),
  seriesEndDate: z.string().nullable().optional(),
  /** Operation kind: create, update, delete. */
  operation: z.enum(['create', 'update', 'delete']),
  /** Whether recurrence was also stopped (delete-and-stop). */
  stopped: z.boolean().optional(),
})

export type RecurringExpenseSummaryActivityData = z.infer<
  typeof recurringExpenseSummaryActivityDataSchema
>

/**
 * Activity data for a standalone recurrence stop. Persisted as a regular
 * activity so the feed shows who stopped the schedule and when.
 */
export const recurringExpenseStoppedActivityDataSchema = z.object({
  kind: z.literal('recurring_expense_stopped'),
  summary: z.string().optional(),
  seriesId: z.string(),
  expenseId: z.string().optional(),
  title: z.string().optional(),
  frequency: z.string(),
  interval: z.number().int().positive(),
  endType: z.string(),
  occurrenceLimit: z.number().int().positive().nullable().optional(),
  endDate: z.string().nullable().optional(),
  affectedParticipants: z.array(z.string()).optional(),
})

export type RecurringExpenseStoppedActivityData = z.infer<
  typeof recurringExpenseStoppedActivityDataSchema
>

export const activityDataSchema = z.discriminatedUnion('kind', [
  expenseActivityDataSchema,
  expenseCommentActivityDataSchema,
  groupActivityDataSchema,
  memberActivityDataSchema,
  invitationActivityDataSchema,
  importSummaryActivityDataSchema,
  expenseCategoriesBulkUpdatedActivityDataSchema,
  recurringExpenseSummaryActivityDataSchema,
  recurringExpenseStoppedActivityDataSchema,
])

export type ActivityData = z.infer<typeof activityDataSchema>

/**
 * Safely parse an unknown value into an {@link ActivityData}. Returns null for
 * null/undefined inputs, non-object inputs, or values that fail Zod validation.
 * This lets the activity feed render a safe fallback for legacy or malformed
 * rows without crashing.
 */
export function parseActivityData(value: unknown): ActivityData | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object') return null
  const result = activityDataSchema.safeParse(value)
  return result.success ? result.data : null
}
