import { z } from 'zod'

import { budgetPeriodSchema } from '@spliit/domain'
import { NotificationSnapshotVersion } from '@spliit/domain/notification-delivery'
import { notificationCategorySchema } from '@spliit/domain/notifications'

const snapshotVersionSchema = z.literal(NotificationSnapshotVersion.V1)

const snapshotActorSchema = z.object({
  id: z.string(),
  name: z.string(),
})

const snapshotRecipientSchema = z.object({
  accountId: z.string(),
  displayName: z.string(),
  // Optional so persisted V1 snapshots created before locale-aware delivery
  // continue to validate and render with sender fallbacks.
  locale: z.string().optional(),
  timeZone: z.string().optional(),
})

const snapshotPushFieldsSchema = z.object({
  subscriptionId: z.string(),
  title: z.string(),
  body: z.string(),
  url: z.string(),
  tag: z.string().optional(),
  icon: z.string().optional(),
})

const snapshotExpenseSchema = z.object({
  id: z.string(),
  description: z.string(),
  amount: z.number().int(),
  currencyCode: z.string().nullable(),
})

const snapshotGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
})

const snapshotRecurrenceSchema = z.object({
  frequency: z.string(),
  interval: z.number().int().positive(),
  rule: z.string(),
})

const snapshotCommentSchema = z.object({
  id: z.string(),
  excerpt: z.string().max(200),
})

const snapshotImportSchema = z.object({
  count: z.number().int().nonnegative(),
  source: z.string().nullable(),
})

const expenseCreatedSnapshotSchema = z.object({
  version: snapshotVersionSchema,
  kind: z.literal('expense_created'),
  category: notificationCategorySchema,
  occurredAt: z.string(),
  actor: snapshotActorSchema.nullable(),
  recipient: snapshotRecipientSchema,
  unsubscribeCategory: notificationCategorySchema.optional(),
  push: snapshotPushFieldsSchema.optional(),
  expense: snapshotExpenseSchema,
  group: snapshotGroupSchema,
  link: z.string(),
  date: z.string().optional(),
})

const expenseUpdatedSnapshotSchema = z.object({
  version: snapshotVersionSchema,
  kind: z.literal('expense_updated'),
  category: notificationCategorySchema,
  occurredAt: z.string(),
  actor: snapshotActorSchema.nullable(),
  recipient: snapshotRecipientSchema,
  unsubscribeCategory: notificationCategorySchema.optional(),
  push: snapshotPushFieldsSchema.optional(),
  expense: snapshotExpenseSchema,
  group: snapshotGroupSchema,
  link: z.string(),
  changedFields: z.array(z.string()),
})

const expenseDeletedSnapshotSchema = z.object({
  version: snapshotVersionSchema,
  kind: z.literal('expense_deleted'),
  category: notificationCategorySchema,
  occurredAt: z.string(),
  actor: snapshotActorSchema.nullable(),
  recipient: snapshotRecipientSchema,
  unsubscribeCategory: notificationCategorySchema.optional(),
  push: snapshotPushFieldsSchema.optional(),
  expense: snapshotExpenseSchema,
  group: snapshotGroupSchema,
  link: z.string(),
  stopped: z.boolean().optional(),
  date: z.string().optional(),
})

const expenseCommentSnapshotSchema = z.object({
  version: snapshotVersionSchema,
  kind: z.literal('expense_comment'),
  category: notificationCategorySchema,
  occurredAt: z.string(),
  actor: snapshotActorSchema.nullable(),
  recipient: snapshotRecipientSchema,
  unsubscribeCategory: notificationCategorySchema.optional(),
  push: snapshotPushFieldsSchema.optional(),
  expense: z.object({
    id: z.string(),
    description: z.string(),
  }),
  group: snapshotGroupSchema,
  link: z.string(),
  comment: snapshotCommentSchema,
})

const recurringCreatedSnapshotSchema = z.object({
  version: snapshotVersionSchema,
  kind: z.literal('recurring_created'),
  category: notificationCategorySchema,
  occurredAt: z.string(),
  actor: snapshotActorSchema.nullable(),
  recipient: snapshotRecipientSchema,
  unsubscribeCategory: notificationCategorySchema.optional(),
  push: snapshotPushFieldsSchema.optional(),
  expense: snapshotExpenseSchema,
  group: snapshotGroupSchema,
  link: z.string(),
  recurrence: snapshotRecurrenceSchema,
  date: z.string().optional(),
})

const recurringOccurrenceSnapshotSchema = z.object({
  version: snapshotVersionSchema,
  kind: z.literal('recurring_occurrence'),
  category: notificationCategorySchema,
  occurredAt: z.string(),
  actor: snapshotActorSchema.nullable(),
  recipient: snapshotRecipientSchema,
  unsubscribeCategory: notificationCategorySchema.optional(),
  push: snapshotPushFieldsSchema.optional(),
  expense: snapshotExpenseSchema,
  group: snapshotGroupSchema,
  link: z.string(),
  recurrence: snapshotRecurrenceSchema,
})

const recurringSummarySnapshotSchema = z.object({
  version: snapshotVersionSchema,
  kind: z.literal('recurring_summary'),
  category: notificationCategorySchema,
  occurredAt: z.string(),
  actor: snapshotActorSchema.nullable(),
  recipient: snapshotRecipientSchema,
  unsubscribeCategory: notificationCategorySchema.optional(),
  push: snapshotPushFieldsSchema.optional(),
  group: snapshotGroupSchema,
  link: z.string(),
  title: z.string().nullable(),
  recurrence: snapshotRecurrenceSchema,
  operation: z.enum(['create', 'update', 'delete']),
  occurrenceCount: z.number().int().positive(),
  dateRange: z.object({ start: z.string(), end: z.string() }),
  stopped: z.boolean().optional(),
})

const recurringStoppedSnapshotSchema = z.object({
  version: snapshotVersionSchema,
  kind: z.literal('recurring_stopped'),
  category: notificationCategorySchema,
  occurredAt: z.string(),
  actor: snapshotActorSchema.nullable(),
  recipient: snapshotRecipientSchema,
  unsubscribeCategory: notificationCategorySchema.optional(),
  push: snapshotPushFieldsSchema.optional(),
  group: snapshotGroupSchema,
  link: z.string(),
  recurrence: snapshotRecurrenceSchema,
  title: z.string().nullable().optional(),
})

const importSummarySnapshotSchema = z.object({
  version: snapshotVersionSchema,
  kind: z.literal('import_summary'),
  category: notificationCategorySchema,
  occurredAt: z.string(),
  actor: snapshotActorSchema.nullable(),
  recipient: snapshotRecipientSchema,
  unsubscribeCategory: notificationCategorySchema.optional(),
  push: snapshotPushFieldsSchema.optional(),
  group: snapshotGroupSchema,
  link: z.string(),
  import: snapshotImportSchema,
  totalAmount: z.number().int().nullable().optional(),
  currencyCode: z.string().nullable().optional(),
})

const categoryBulkSnapshotSchema = z.object({
  version: snapshotVersionSchema,
  kind: z.literal('category_bulk'),
  category: notificationCategorySchema,
  occurredAt: z.string(),
  actor: snapshotActorSchema.nullable(),
  recipient: snapshotRecipientSchema,
  unsubscribeCategory: notificationCategorySchema.optional(),
  push: snapshotPushFieldsSchema.optional(),
  group: snapshotGroupSchema,
  link: z.string(),
  count: z.number().int().nonnegative(),
  distinctCategories: z.number().int().nonnegative().nullable().optional(),
})

const groupActivitySnapshotSchema = z.object({
  version: snapshotVersionSchema,
  kind: z.literal('group_activity'),
  category: notificationCategorySchema,
  occurredAt: z.string(),
  actor: snapshotActorSchema.nullable(),
  recipient: snapshotRecipientSchema,
  unsubscribeCategory: notificationCategorySchema.optional(),
  push: snapshotPushFieldsSchema.optional(),
  group: snapshotGroupSchema,
  link: z.string(),
  action: z.string(),
  summary: z.string().optional(),
})

const settlementSnapshotSchema = z.object({
  version: snapshotVersionSchema,
  kind: z.literal('settlement'),
  category: notificationCategorySchema,
  occurredAt: z.string(),
  actor: snapshotActorSchema.nullable(),
  recipient: snapshotRecipientSchema,
  unsubscribeCategory: notificationCategorySchema.optional(),
  push: snapshotPushFieldsSchema.optional(),
  expense: snapshotExpenseSchema,
  group: snapshotGroupSchema,
  link: z.string(),
})

const invitationSnapshotSchema = z.object({
  version: snapshotVersionSchema,
  kind: z.literal('invitation'),
  category: notificationCategorySchema,
  occurredAt: z.string(),
  actor: snapshotActorSchema.nullable(),
  recipient: snapshotRecipientSchema,
  unsubscribeCategory: notificationCategorySchema.optional(),
  push: snapshotPushFieldsSchema.optional(),
  group: z.object({
    id: z.string(),
    name: z.string(),
  }),
  link: z.string(),
  inviterName: z.string(),
  inviterRole: z.enum(['ADMIN', 'MEMBER']),
})

const friendAddedSnapshotSchema = z.object({
  version: snapshotVersionSchema,
  kind: z.literal('friend_added'),
  category: notificationCategorySchema,
  occurredAt: z.string(),
  actor: snapshotActorSchema.nullable(),
  recipient: snapshotRecipientSchema,
  unsubscribeCategory: notificationCategorySchema.optional(),
  push: snapshotPushFieldsSchema.optional(),
  group: z.object({
    id: z.string(),
    name: z.string(),
  }),
  link: z.string(),
  friendName: z.string(),
})

const budgetAlertSnapshotSchema = z.object({
  version: snapshotVersionSchema,
  kind: z.literal('budget_alert'),
  category: notificationCategorySchema,
  occurredAt: z.string(),
  actor: snapshotActorSchema.nullable(),
  recipient: snapshotRecipientSchema,
  unsubscribeCategory: notificationCategorySchema.optional(),
  push: snapshotPushFieldsSchema.optional(),
  budget: z.object({
    id: z.string(),
    name: z.string(),
    used: z.number().int(),
    limit: z.number().int(),
    currencyCode: z.string().nullable(),
    alertType: z.enum(['TRENDING_OVER', 'OVER']),
    periodStart: z.string(),
    periodEnd: z.string(),
    period: budgetPeriodSchema.optional(),
  }),
  group: snapshotGroupSchema,
  link: z.string(),
})

export const deliverySnapshotV1Schema = z.discriminatedUnion('kind', [
  expenseCreatedSnapshotSchema,
  expenseUpdatedSnapshotSchema,
  expenseDeletedSnapshotSchema,
  expenseCommentSnapshotSchema,
  recurringCreatedSnapshotSchema,
  recurringOccurrenceSnapshotSchema,
  recurringSummarySnapshotSchema,
  recurringStoppedSnapshotSchema,
  importSummarySnapshotSchema,
  categoryBulkSnapshotSchema,
  groupActivitySnapshotSchema,
  settlementSnapshotSchema,
  invitationSnapshotSchema,
  friendAddedSnapshotSchema,
  budgetAlertSnapshotSchema,
])

export type DeliverySnapshotV1 = z.infer<typeof deliverySnapshotV1Schema>

export const DELIVERY_SNAPSHOT_KINDS = [
  'expense_created',
  'expense_updated',
  'expense_deleted',
  'expense_comment',
  'recurring_created',
  'recurring_occurrence',
  'recurring_summary',
  'recurring_stopped',
  'import_summary',
  'category_bulk',
  'group_activity',
  'settlement',
  'invitation',
  'friend_added',
  'budget_alert',
] as const

export type DeliverySnapshotKind = (typeof DELIVERY_SNAPSHOT_KINDS)[number]
