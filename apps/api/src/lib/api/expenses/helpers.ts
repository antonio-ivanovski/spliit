import {
  categoryIdSchema,
  conversionFromStored,
  DEFAULT_CATEGORY_ID,
  getCategoryById,
  type Category,
  type CategoryId,
  type Expense,
} from '@spliit/domain'

import {
  promoteUploadedDocument,
  promoteUploadedDocumentDetailed,
} from '../../../routes/upload'
import { mapWithConcurrency } from '../../concurrency'
import { toRecurrenceConfig } from '../recurrence-series'
import type { getExpense } from './queries'

/**
 * Resolve a `categoryId` string from the database to the in-code
 * {@link Category} object. Returns the default "General" category when the
 * stored id is not in the in-code list (e.g. it was written by an older version
 * of the app or is otherwise invalid).
 */
export function resolveCategory(categoryId: string): Category {
  const parsedCategoryId = categoryIdSchema.safeParse(categoryId)
  return (
    (parsedCategoryId.success
      ? getCategoryById(parsedCategoryId.data)
      : undefined) ?? getCategoryById(DEFAULT_CATEGORY_ID)!
  )
}

/**
 * Narrow a `categoryId` string from the database to the {@link CategoryId}
 * literal union, falling back to the default category if the stored id is not
 * in the in-code list.
 */
export function narrowCategoryId(categoryId: string): CategoryId {
  const parsed = categoryIdSchema.safeParse(categoryId)
  return parsed.success ? parsed.data : DEFAULT_CATEGORY_ID
}

/**
 * Normalize the Prisma `getExpense` return value to the domain `Expense` shape
 * expected by diff and affected-participant utilities. The Prisma model stores
 * `ledgerParticipantId` while the domain uses `participant` for payer / split /
 * item references.
 */
/**
 * Map a stored expense into the shape used by activity diffs. `amount` is the
 * ledger total; flat conversion fields are attached for amount/conversion
 * differs (in addition to the `conversion` discriminant).
 */
export function toExpenseDomainShape(
  existing: NonNullable<Awaited<ReturnType<typeof getExpense>>>,
): Expense & {
  originalAmount?: number
  originalCurrency?: string
  conversionRate?: number
  conversionSource?: 'EXCHANGE' | 'CUSTOM' | null
} {
  return {
    title: existing.title,
    amount: existing.amount,
    expenseDate: existing.expenseDate,
    expenseTimeZone: existing.expenseTimeZone,
    category: existing.categoryId as Expense['category'],
    notes: existing.notes ?? undefined,
    recurrenceRule: existing.recurringSeries?.frequency ?? 'NONE',
    recurrence: existing.recurringSeries
      ? toRecurrenceConfig(existing.recurringSeries)
      : null,
    splitMode: existing.splitMode,
    paidBySplitMode: existing.paidBySplitMode,
    paidByList: existing.paidByList.map((pb) => ({
      participant: pb.ledgerParticipantId,
      shares: pb.shares,
    })),
    paidFor: existing.paidFor.map((pf) => ({
      participant: pf.ledgerParticipantId,
      shares: pf.shares,
    })),
    items: (existing.items ?? []).map((item) => ({
      id: item.id,
      title: item.title,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      amount: item.amount,
      splitMode: item.splitMode,
      paidFor: item.paidFor.map((pf) => ({
        participant: pf.ledgerParticipantId,
        shares: pf.shares,
      })),
    })),
    itemizedRemainder: existing.itemizedRemainder
      ? {
          splitMode: existing.itemizedRemainder.splitMode,
          paidFor: existing.itemizedRemainder.paidFor.map((pf) => ({
            participant: pf.ledgerParticipantId,
            shares: pf.shares,
          })),
        }
      : undefined,
    documents: existing.documents.map((d) => ({
      id: d.id,
      url: d.url,
      fileName: d.fileName,
      contentType: d.contentType,
      width: d.width,
      height: d.height,
    })),
    conversion: conversionFromStored({
      conversionSource: existing.conversionSource,
      originalCurrency: existing.originalCurrency,
      conversionRate: existing.conversionRate,
    }),
    originalAmount: existing.originalAmount ?? undefined,
    originalCurrency: existing.originalCurrency ?? undefined,
    conversionRate: existing.conversionRate ?? undefined,
    conversionSource: existing.conversionSource,
  } as Expense & {
    originalAmount?: number
    originalCurrency?: string
    conversionRate?: number
    conversionSource?: 'EXCHANGE' | 'CUSTOM' | null
  }
}
export async function promoteExpenseDocuments(
  documents: Array<{
    id: string
    url: string
    fileName?: string | null
    contentType?: string | null
    width?: number | null
    height?: number | null
  }>,
): Promise<typeof documents> {
  return Promise.all(
    documents.map(async (doc) => ({
      ...doc,
      url: await promoteUploadedDocument(doc.url),
    })),
  )
}

export type PromotedExpenseDocument = {
  id: string
  url: string
  fileName?: string | null
  contentType?: string | null
  width?: number | null
  height?: number | null
  /**
   * True only when this attempt copied the object. Reused permanent objects
   * (converged retries) report `created: false` and must never be
   * rollback-deleted: a changed URL is NOT ownership evidence.
   */
  created: boolean
  /** Staged `tmp/` source key for post-commit cleanup; null when N/A. */
  sourceKey: string | null
  /**
   * Staged `tmp/` source URL for post-commit cleanup; null when the input was
   * not a staged upload. Deleting staged sources only after commit keeps failed
   * imports retryable with the same payload.
   */
  temporaryUrl: string | null
}

export type SettledDocumentPromotion =
  | { status: 'fulfilled'; value: PromotedExpenseDocument }
  | { status: 'rejected'; reason: unknown }

/**
 * Ownership-aware promotion for the file importer. Unlike
 * {@link promoteExpenseDocuments} (row-local `Promise.all`, URL-only), this
 * settles EVERY in-flight promotion before returning — so the caller can clean
 * up successfully created siblings when one document fails — and reports
 * per-document creation ownership. Never deletes staged sources: the caller
 * removes them after commit so failed imports stay retryable.
 *
 * With `attemptKey`, copies land on attempt-scoped destinations
 * (`documents/imports/<attempt>/…`) so concurrent attempts never share an
 * object. Repeated references to one staged URL within the attempt converge on
 * a single copy.
 */
export async function promoteExpenseDocumentsDetailed(
  documents: Array<{
    id: string
    url: string
    fileName?: string | null
    contentType?: string | null
    width?: number | null
    height?: number | null
  }>,
  options: { concurrency?: number; attemptKey?: string } = {},
): Promise<SettledDocumentPromotion[]> {
  // In-flight promotions keyed by staged URL. The entry is stored BEFORE
  // awaiting: concurrent workers referencing one staged URL share a single
  // copy instead of each missing a populate-after-await cache. Awaited by
  // every sharer, so rejections propagate without extra copies and without
  // unhandled rejections.
  const inflight = new Map<
    string,
    Promise<{
      url: string
      created: boolean
      sourceKey: string | null
      temporaryUrl: string | null
    }>
  >()
  return mapWithConcurrency(
    documents,
    options.concurrency ?? 10,
    async (doc): Promise<SettledDocumentPromotion> => {
      let pending = inflight.get(doc.url)
      if (!pending) {
        const stagedUrl = doc.url
        pending = (async () => {
          const promoted = await promoteUploadedDocumentDetailed(stagedUrl, {
            deleteSource: false,
            attemptKey: options.attemptKey,
          })
          return {
            ...promoted,
            temporaryUrl: promoted.sourceKey ? stagedUrl : null,
          }
        })()
        inflight.set(doc.url, pending)
      }
      try {
        const shared = await pending
        // Same staged URL twice in one attempt: share the single copy,
        // keeping this document's own identity fields.
        return {
          status: 'fulfilled',
          value: {
            ...doc,
            url: shared.url,
            created: shared.created,
            sourceKey: shared.sourceKey,
            temporaryUrl: shared.temporaryUrl,
          },
        }
      } catch (reason) {
        return { status: 'rejected', reason }
      }
    },
  )
}
