import { getCurrency, type Expense } from '@spliit/domain'
import type {
  DelimitedExpenseMappingV1,
  DelimitedMappedRow,
  DelimitedRowIssue,
} from '@spliit/domain/import'

import type { CategoryAssignment } from './import-category-mapping'

export type FieldMappingKey = Exclude<
  keyof DelimitedExpenseMappingV1['mappings'],
  'money'
>
export type MappingKey = FieldMappingKey | 'money'
export type MappingFieldKey = FieldMappingKey
export type MappingIssueField = DelimitedRowIssue['field']
export type ReviewFilter =
  | 'ALL'
  | 'READY'
  | 'WARNINGS'
  | 'DUPLICATES'
  | 'ERRORS'
export type ReviewStatus = Exclude<ReviewFilter, 'ALL'>

// Display order for the review list: errors first, then duplicates, then
// warnings, then clean rows. Rank values match reviewStatusFor below.
const REVIEW_STATUS_RANK: Record<ReviewStatus, number> = {
  ERRORS: 0,
  DUPLICATES: 1,
  WARNINGS: 2,
  READY: 3,
}

export function sortReviewRows(
  rows: DraftRow[],
  statusFor: (row: DraftRow) => ReviewStatus,
) {
  return [...rows].sort(
    (a, b) =>
      REVIEW_STATUS_RANK[statusFor(a)] - REVIEW_STATUS_RANK[statusFor(b)] ||
      a.mapped.rowNumber - b.mapped.rowNumber,
  )
}

// Single definition of the review severity precedence: errors outrank
// duplicates, which outrank warnings. Used by the filter, the sort, and the
// exported unit tests below.
export function reviewStatusFor(
  mapped: { error?: string | null; warning?: string | null },
  duplicateCount: number,
): ReviewStatus {
  if (mapped.error) return 'ERRORS'
  if (duplicateCount > 0) return 'DUPLICATES'
  if (mapped.warning) return 'WARNINGS'
  return 'READY'
}

// Compact FNV-1a hash for virtualizer remeasure keys. The previous full-join
// strings grew to ~1MB on 10k-row files; hashing the same lens keeps the
// change signal identical while keeping the key small and cheap to compare.
export function fnv1aHash(input: string, seed = 0x811c9dc5): number {
  let hash = seed >>> 0
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)!
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function hashPreviewLens(pieces: string[], prefix = ''): string {
  let hash = 0x811c9dc5
  if (prefix) hash = fnv1aHash(prefix, hash)
  hash = fnv1aHash(`count:${pieces.length};`, hash)
  for (const piece of pieces) hash = fnv1aHash(`${piece};`, hash)
  return hash.toString(36)
}

export type DuplicateCheckRow = {
  rowId: string
  rowNumber: number
  source: { baseFingerprint: string; originFingerprint: string }
  externalId?: string | null
  sourceAccount?: string | null
  expense: {
    title: string
    expenseDate: unknown
    amount: number
    expenseTimeZone?: unknown
    conversion?: { currency?: unknown } | null
  }
}

// Identity-only signature for the duplicate check: stringifying full expense
// objects (with splits and dates) on every drafts change freezes large files.
// This covers the identity fields plus the scheduling/currency signals the
// server-side matcher consumes, so equal signatures imply equal results.
/**
 * Apply a category assignment to the mapping's explicit bindings. Mode toggles
 * (title/source without an id) only flip ignoredSources upstream and must never
 * destroy the explicit binding: toggling back restores the picked category
 * instead of silently falling back to a suggestion. Pure for tests.
 */
export function applyCategoryBindingAssignment(
  mapping: DelimitedExpenseMappingV1 | null,
  key: string,
  assignment: CategoryAssignment,
): DelimitedExpenseMappingV1 | null {
  if (!mapping) return mapping
  if (assignment.mode !== 'source' || assignment.categoryId === undefined)
    return mapping
  if (mapping.categoryBindings[key] === assignment.categoryId) return mapping
  return {
    ...mapping,
    categoryBindings: {
      ...mapping.categoryBindings,
      [key]: assignment.categoryId,
    },
  }
}

export function duplicateCheckSignature(
  rows: DuplicateCheckRow[],
  ledgerCurrencyCode?: string,
): string {
  return rows
    .map((row) =>
      [
        row.rowId,
        row.rowNumber,
        row.source.baseFingerprint,
        row.source.originFingerprint,
        row.externalId ?? '',
        row.sourceAccount ?? '',
        // Ledger currency feeds the server-side sourceCurrency fallback, so a
        // mid-import group currency change must invalidate the ready state.
        ledgerCurrencyCode ?? '',
        row.expense.title,
        row.expense.expenseDate instanceof Date
          ? row.expense.expenseDate.getTime()
          : typeof row.expense.expenseDate === 'string' ||
              typeof row.expense.expenseDate === 'number'
            ? row.expense.expenseDate
            : '',
        row.expense.amount,
        typeof row.expense.expenseTimeZone === 'string'
          ? row.expense.expenseTimeZone
          : '',
        typeof row.expense.conversion?.currency === 'string'
          ? row.expense.conversion.currency
          : '',
      ].join('\u0000'),
    )
    .join('\u0001')
}
export type DuplicateMatch = {
  key: string
  kind: 'EXACT_IMPORT' | 'EXISTING_EXPENSE' | 'CURRENT_FILE'
  expenseId: string | null
  sourceRowId: string | null
  title: string | null
  expenseDate: string | null
  amount: number | null
  currency: string | null
}
export type DraftRow = {
  mapped: DelimitedMappedRow
  expense: Expense
  selected: boolean
  approvedDuplicateKeys: string[]
}

export function preferredDateOrder(): 'DMY' | 'MDY' {
  const parts = new Intl.DateTimeFormat().formatToParts(new Date(2000, 10, 22))
  return parts.findIndex(({ type }) => type === 'day') <
    parts.findIndex(({ type }) => type === 'month')
    ? 'DMY'
    : 'MDY'
}

export function formatMinorAmount(amount: number, currency: string) {
  const decimals = getCurrency(currency)?.decimal_digits ?? 2
  return `${(Math.abs(amount) / 10 ** decimals).toFixed(decimals)} ${currency}`
}
