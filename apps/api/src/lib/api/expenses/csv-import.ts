import { createHash } from 'node:crypto'

import { TRPCError } from '@trpc/server'

import { prisma, type Prisma } from '@spliit/db'
import {
  dateOnlyInTimeZone,
  exchangeRateLookupDate,
  isSettlementCategory,
  toSecondPrecision,
  supportedCurrencyCodes,
  computePaidForFromItems,
  type Expense,
} from '@spliit/domain'
import { env as jobsEnv } from '@spliit/jobs'

import { deleteS3Object } from '../../../routes/upload'
import { mapWithConcurrency } from '../../concurrency'
import {
  getCurrencyRates,
  type BatchRateRequest,
  type CurrencyRate,
} from '../../currency-rates'
import {
  resolveConversion,
  type ConversionResolution,
} from '../../expense-conversion'
import { logServerInfo, logServerWarn } from '../../logging'
import {
  buildExpenseActivityData,
  buildImportSummaryActivityData,
  logActivity,
  planNotificationForActivity,
} from '../activities'
import { getApiBoss } from '../boss'
import { createManyInBatches } from '../create-many-in-batches'
import { getApiBossForWrite, getExpenseRecurrence } from '../recurrence-series'
import { randomId } from '../shared'
import { createExpense, type PreparedExpenseCreate } from './create-expense'
import {
  promoteExpenseDocumentsDetailed,
  type PromotedExpenseDocument,
} from './helpers'

export const EXPENSE_FILE_IMPORT_PROVIDER = 'GENERIC_CSV'
const EXPENSE_FILE_IMPORT_KEY_DOMAIN = 'spliit:expense-file-import:v3'

export type ExpenseFileImportRow = {
  rowId: string
  rowNumber: number
  source: {
    baseFingerprint: string
    originFingerprint: string
  }
  /** Stable bank transaction id when the export provides one (king identity). */
  externalId?: string | null
  /** Account namespace for the external id (multi-account exports). */
  sourceAccount?: string | null
  expense: Expense
  approvedDuplicateKeys?: string[]
}

export type ExpenseFileImportMatchKind =
  | 'EXACT_IMPORT'
  | 'EXISTING_EXPENSE'
  | 'CURRENT_FILE'

export type ExpenseFileImportMatch = {
  key: string
  kind: ExpenseFileImportMatchKind
  expenseId: string | null
  sourceRowId: string | null
  title: string | null
  expenseDate: string | null
  amount: number | null
  currency: string | null
}

export type ExpenseFileImportDuplicateResult = {
  rowId: string
  rowNumber: number
  matches: ExpenseFileImportMatch[]
}

export class ExpenseFileImportDuplicateError extends Error {
  constructor(
    readonly conflicts: Array<{
      rowId: string
      rowNumber: number
      matchKeys: string[]
    }>,
  ) {
    super(
      `Some selected rows have new or unapproved duplicate matches (rows ${conflicts
        .map((conflict) => conflict.rowNumber)
        .join(', ')}). Review them and retry.`,
    )
    this.name = 'ExpenseFileImportDuplicateError'
  }
}

type DbClient = Prisma.TransactionClient | typeof prisma

type ExistingExpenseCandidate = {
  id: string
  title: string
  expenseDate: Date
  expenseTimeZone: string
  amount: number
  originalAmount: number | null
  originalCurrency: string | null
}

type MatchIdentity = {
  date: string
  amount: number
  currency: string
  title: string
}

function fuzzyMatchKey(identity: MatchIdentity): string {
  return [
    identity.date,
    identity.amount,
    identity.currency,
    normalizedTitle(identity.title),
  ].join('\0')
}

function candidateMatchKeys(
  candidate: ExistingExpenseCandidate,
  ledgerCurrencyCode: string | null,
): string[] {
  const date = wallDateIso(candidate.expenseDate, candidate.expenseTimeZone)
  const title = normalizedTitle(candidate.title)
  const keys: string[] = []
  const ledgerCurrency = ledgerCurrencyCode?.toUpperCase()
  if (ledgerCurrency) {
    keys.push(
      fuzzyMatchKey({
        date,
        amount: candidate.amount,
        currency: ledgerCurrency,
        title,
      }),
    )
  }
  if (candidate.originalAmount != null && candidate.originalCurrency) {
    keys.push(
      fuzzyMatchKey({
        date,
        amount: candidate.originalAmount,
        currency: candidate.originalCurrency.toUpperCase(),
        title,
      }),
    )
  }
  return keys
}

function normalizedTitle(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function wallDateIso(expenseDate: Date, expenseTimeZone: string): string {
  return dateOnlyInTimeZone(expenseDate, expenseTimeZone)
    .toISOString()
    .slice(0, 10)
}

function sourceAmount(expense: Expense): number {
  return expense.amount
}

function sourceCurrency(
  expense: Expense,
  ledgerCurrencyCode: string | null,
): string {
  return (
    expense.conversion?.currency ??
    ledgerCurrencyCode ??
    ''
  ).toUpperCase()
}

function matchIdentity(
  row: ExpenseFileImportRow,
  ledgerCurrencyCode: string | null,
): MatchIdentity {
  return {
    date: wallDateIso(row.expense.expenseDate, row.expense.expenseTimeZone),
    amount: sourceAmount(row.expense),
    currency: sourceCurrency(row.expense, ledgerCurrencyCode),
    title: row.expense.title,
  }
}

function storedOriginKey(ledgerId: string, originFingerprint: string): string {
  return createHash('sha256')
    .update(`${EXPENSE_FILE_IMPORT_KEY_DOMAIN}\0`)
    .update(ledgerId)
    .update('\0')
    .update(originFingerprint)
    .digest('hex')
}

/** Normalize a bank-provided identity component (trim + NFKC, case kept). */
function normalizedExternalComponent(value: string | null | undefined) {
  const normalized = (value ?? '').normalize('NFKC').trim()
  return normalized || null
}

const EXPENSE_FILE_IDENTITY_DOMAIN = 'spliit:expense-file-identity:v1'

/**
 * Hash-only bank identity: raw bank transaction ids and account namespaces are
 * hashed at the API boundary and never stored. Normalization (NFKC + trim, case
 * kept) runs before hashing, so matching semantics equal a normalized direct
 * comparison. Null when the export provides no id.
 */
export function externalIdentityHash(
  externalId: string | null | undefined,
  sourceAccount: string | null | undefined,
): string | null {
  const id = normalizedExternalComponent(externalId)
  if (!id) return null
  return createHash('sha256')
    .update(`${EXPENSE_FILE_IDENTITY_DOMAIN}\0`)
    .update(normalizedExternalComponent(sourceAccount) ?? '')
    .update('\0')
    .update(id)
    .digest('hex')
}

function dateWindows(datesOnly: string[]) {
  const day = 24 * 60 * 60 * 1000
  const sorted = [
    ...new Set(
      datesOnly
        .map((date) => new Date(`${date}T00:00:00.000Z`).getTime())
        .filter(Number.isFinite),
    ),
  ].sort((a, b) => a - b)
  // Cluster dates whose padded windows overlap: each window spans
  // [date-1d, date+2d) (a wall date in any UTC-12…UTC+14 zone maps to an
  // instant in that range), so dates more than 3 days apart get separate
  // windows instead of one broad range spanning years of unrelated expenses.
  const windows: Array<{ gte: Date; lt: Date }> = []
  let cluster: { min: number; max: number } | null = null
  const flush = () => {
    if (cluster) {
      windows.push({
        gte: new Date(cluster.min - day),
        lt: new Date(cluster.max + 2 * day),
      })
      cluster = null
    }
  }
  for (const time of sorted) {
    if (cluster && time - cluster.max > 3 * day) flush()
    cluster = cluster
      ? { min: cluster.min, max: Math.max(cluster.max, time) }
      : { min: time, max: time }
  }
  flush()
  return windows
}

function candidateMatches(
  candidate: ExistingExpenseCandidate,
  identity: MatchIdentity,
  ledgerCurrencyCode: string | null,
): boolean {
  if (
    wallDateIso(candidate.expenseDate, candidate.expenseTimeZone) !==
    identity.date
  ) {
    return false
  }

  const ledgerCurrency = (ledgerCurrencyCode ?? '').toUpperCase()
  const amountAndCurrencyMatch =
    (identity.currency === ledgerCurrency &&
      candidate.amount === identity.amount) ||
    (candidate.originalAmount === identity.amount &&
      candidate.originalCurrency?.toUpperCase() === identity.currency)

  return (
    amountAndCurrencyMatch &&
    normalizedTitle(candidate.title) === normalizedTitle(identity.title)
  )
}

function existingMatch(
  candidate: ExistingExpenseCandidate,
  kind: 'EXACT_IMPORT' | 'EXISTING_EXPENSE',
  ledgerCurrencyCode: string | null,
): ExpenseFileImportMatch {
  const currency =
    candidate.originalCurrency?.toUpperCase() ??
    ledgerCurrencyCode?.toUpperCase() ??
    null
  return {
    key: `${kind}:${candidate.id}`,
    kind,
    expenseId: candidate.id,
    sourceRowId: null,
    title: candidate.title,
    expenseDate: wallDateIso(candidate.expenseDate, candidate.expenseTimeZone),
    amount: candidate.originalAmount ?? candidate.amount,
    currency,
  }
}

/** Bound the pre-transaction storage fan-out (see `prepareExpenseFileImport`). */
const PROMOTION_CONCURRENCY = 10

/**
 * Bound the post-commit/compensating storage fan-out (see
 * `deleteImportTempSources` / `cleanupUnusedImportCopies`). Deletions are
 * individually cheap, but an import may stage up to 20,000 documents — an
 * unbounded `Promise.allSettled` would open thousands of simultaneous storage
 * requests. Settled per URL so one failure never cancels the rest; failures are
 * logged, never swallowed. The post-commit hook stays awaited (never
 * fire-and-forget): hygiene must be observed, not merely attempted.
 */
const CLEANUP_CONCURRENCY = 10

/**
 * Delete attempt-owned copies that can no longer be referenced. A URL is
 * deleted only when no expense document references it: a copy this attempt
 * created may have become referenced since (a concurrent winner committed
 * first, or the transaction actually committed despite the reported failure),
 * and deleting a referenced object would destroy a committed attachment — while
 * leaking an unreferenced one is always safe. Fail-closed: when references
 * cannot be verified (database outage), nothing is deleted. Never throws:
 * compensation must not mask the original failure.
 */
async function cleanupUnusedImportCopies(
  urls: string[],
  attemptKey: string,
): Promise<void> {
  const unique = [...new Set(urls.filter(Boolean))]
  if (unique.length === 0) return
  let referenced: Array<{ url: string }>
  try {
    referenced = await prisma.expenseDocument.findMany({
      where: { url: { in: unique } },
      select: { url: true },
    })
  } catch {
    // Unverifiable references: deleting blind could destroy committed
    // attachments (outage or ambiguous commit), so keep everything.
    return
  }
  const referencedUrls = new Set(referenced.map(({ url }) => url))
  const targets = unique.filter((url) => !referencedUrls.has(url))
  await deleteImportUrls(targets, {
    attemptKey,
    phase: 'compensate-cleanup',
  })
}

const IMPORT_LOG_ERROR_KINDS = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'AbortError',
  'TimeoutError',
  'NoSuchKey',
  'NoSuchBucket',
  'AccessDenied',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'ExpiredToken',
  'SlowDown',
  'ServiceUnavailable',
  'InternalError',
  'S3ServiceException',
  'PrismaClientKnownRequestError',
  'PrismaClientUnknownRequestError',
  'PrismaClientInitializationError',
  'PrismaClientValidationError',
])

/**
 * Allowlisted failure descriptor for cleanup logs. Storage errors routinely
 * embed paths, URLs, and presigned secrets in `message` — that string never
 * crosses into logs. Only known error names (not arbitrary code-shaped text)
 * and an explicit numeric status (`$metadata.httpStatusCode` on S3 errors) are
 * reported; anything else degrades to `unknown`.
 */
export function describeCleanupFailure(error: unknown): {
  kind: string
  status?: number
} {
  let kind = 'unknown'
  if (error instanceof Error && IMPORT_LOG_ERROR_KINDS.has(error.name)) {
    kind = error.name
  }
  let status: number | undefined
  if (typeof error === 'object' && error !== null) {
    const httpStatus = (error as { $metadata?: { httpStatusCode?: unknown } })
      .$metadata?.httpStatusCode
    if (
      typeof httpStatus === 'number' &&
      Number.isInteger(httpStatus) &&
      httpStatus >= 100 &&
      httpStatus <= 599
    ) {
      status = httpStatus
    }
  }
  return status === undefined ? { kind } : { kind, status }
}

/**
 * Delete storage URLs with bounded concurrency, counting (not throwing on)
 * failures.
 */
async function deleteImportUrls(
  urls: string[],
  meta: {
    attemptKey: string
    phase: 'temp-source-cleanup' | 'compensate-cleanup'
  },
): Promise<{ deleted: number; failed: number }> {
  const startedAt = performance.now()
  const failures: unknown[] = []
  await mapWithConcurrency(urls, CLEANUP_CONCURRENCY, async (url) => {
    try {
      await deleteS3Object(url)
    } catch (error) {
      failures.push(error)
    }
  })
  const ms = Math.round(performance.now() - startedAt)
  const deleted = urls.length - failures.length
  if (failures.length > 0) {
    const kinds = new Set<string>()
    const statuses = new Set<number>()
    for (const failure of failures) {
      const described = describeCleanupFailure(failure)
      kinds.add(described.kind)
      if (described.status !== undefined) statuses.add(described.status)
    }
    logServerWarn(
      'expense-file-import',
      new Error(`cleanup failures: ${[...kinds].sort().join(',')}`),
      {
        attemptKey: meta.attemptKey,
        phase: meta.phase,
        attempted: urls.length,
        deleted,
        failed: failures.length,
        kinds: [...kinds].sort(),
        ...(statuses.size > 0
          ? { statuses: [...statuses].sort((a, b) => a - b) }
          : {}),
        ms,
      },
    )
  } else {
    logServerInfo('expense-file-import', {
      attemptKey: meta.attemptKey,
      phase: meta.phase,
      deleted,
      ms,
    })
  }
  return { deleted, failed: failures.length }
}

/**
 * Compensate a failed import attempt: remove permanent copies this attempt
 * created. Copies live on attempt-scoped destinations, so no concurrent attempt
 * can address them — cross-attempt deletion is structurally impossible, and
 * converged/adopted reuses report `created: false` and are never touched. Safe
 * to call when nothing was created, after a rollback, and after an ambiguous
 * commit — the fail-closed reference check above protects committed rows.
 */
export async function compensateImportAttempt(
  prepared: PreparedExpenseFileImport,
): Promise<void> {
  const createdUrls = prepared.rows.flatMap(({ documents }) =>
    documents.filter(({ created }) => created).map(({ url }) => url),
  )
  await cleanupUnusedImportCopies(createdUrls, prepared.attemptKey)
}

/**
 * Post-commit hygiene: staged `tmp/` sources are retained through the import
 * (so failures and duplicate-conflict retries reuse the same payload) and
 * removed once the commit is known good. Best-effort and non-throwing: a
 * committed import must never fail because of source cleanup.
 */
export async function deleteImportTempSources(
  prepared: PreparedExpenseFileImport,
): Promise<void> {
  const sources = [
    ...new Set(
      prepared.rows.flatMap(({ documents }) =>
        documents.map(({ temporaryUrl }) => temporaryUrl),
      ),
    ),
  ].filter((url): url is string => url !== null)
  if (sources.length === 0) return
  await deleteImportUrls(sources, {
    attemptKey: prepared.attemptKey,
    phase: 'temp-source-cleanup',
  })
}

/** TRPC codes for routine user-correctable import failures (info, not warn). */
const ROUTINE_IMPORT_FAILURE_CODES = new Set([
  'CONFLICT',
  'BAD_REQUEST',
  'NOT_FOUND',
  'FORBIDDEN',
])

/**
 * Allowlisted outcome code for a failed import. Fixed tRPC codes and the
 * duplicate-conflict marker pass through (closed sets, no user data);
 * everything else degrades to the sanitized cleanup-failure kind. Messages
 * never cross into logs.
 */
function importFailureCode(error: unknown): string {
  if (error instanceof ExpenseFileImportDuplicateError) return 'CONFLICT'
  if (error instanceof TRPCError) return error.code
  return describeCleanupFailure(error).kind
}

/**
 * Transaction-owner outcome log. Emitted only when the outcome is known:
 * `committed` after the database commit (never from inside the transaction —
 * the outer idempotency update and the commit itself can still fail after the
 * writes complete), `failed` when the attempt cannot commit. Timings are
 * recorded incrementally by the write pass, so failures carry the completed
 * phases plus the interrupted phase (`failedPhase`/`failedPhaseElapsedMs`)
 * instead of logging without a timing breakdown.
 */
export function logImportOutcome(
  prepared: PreparedExpenseFileImport | undefined,
  outcome: { committed: true } | { committed: false; error: unknown },
): void {
  const bulk = prepared?.rows.filter(({ bulkEligible }) => bulkEligible).length
  const rows = prepared?.rows.length
  const base = {
    ...(prepared?.attemptKey === undefined
      ? {}
      : { attemptKey: prepared.attemptKey }),
    ...(rows === undefined || bulk === undefined
      ? {}
      : { rows, bulk, recurring: rows - bulk }),
    // Null until the write pass ran: spreading a nullish value contributes
    // no properties.
    ...prepared?.commitTimings,
  }
  if (outcome.committed) {
    logServerInfo('expense-file-import', { ...base, phase: 'committed' })
    return
  }
  const errorCode = importFailureCode(outcome.error)
  const details = { ...base, phase: 'failed', errorCode }
  if (ROUTINE_IMPORT_FAILURE_CODES.has(errorCode)) {
    logServerInfo('expense-file-import', details)
  } else {
    logServerWarn(
      'expense-file-import',
      new Error(`import failed: ${errorCode}`),
      details,
    )
  }
}

/** Scan stats for import timing logs (see `importExpenseFile`). */
export type ExpenseFileImportDuplicateStats = {
  /** Narrow date windows scanned (1 for single-day batches, more for spans). */
  windows: number
  /** Stored expenses fetched across all window pages. */
  candidatesScanned: number
}

/** Find exact re-imports, likely existing expenses, and duplicates in this file. */
export async function findExpenseFileImportDuplicates(
  ledgerId: string,
  ledgerCurrencyCode: string | null,
  rows: ExpenseFileImportRow[],
  client: DbClient = prisma,
): Promise<{
  rows: ExpenseFileImportDuplicateResult[]
  stats: ExpenseFileImportDuplicateStats
}> {
  const emptyStats = (): ExpenseFileImportDuplicateStats => ({
    windows: 0,
    candidatesScanned: 0,
  })
  if (rows.length === 0) return { rows: [], stats: emptyStats() }

  const keys = rows.map((row) =>
    storedOriginKey(ledgerId, row.source.originFingerprint),
  )
  // Immutable provenance lives in the side table: a row exists only for
  // imported expenses, so replay detection survives user edits of the
  // expense itself.
  const imported = await client.expenseFileImportSource.findMany({
    where: {
      ledgerId,
      provider: EXPENSE_FILE_IMPORT_PROVIDER,
      importKey: { in: keys },
    },
    select: {
      importKey: true,
      expense: {
        select: {
          id: true,
          title: true,
          expenseDate: true,
          expenseTimeZone: true,
          amount: true,
          originalAmount: true,
          originalCurrency: true,
        },
      },
    },
  })
  const importedByKey = new Map<string, ExistingExpenseCandidate[]>()
  for (const { importKey, expense: candidate } of imported) {
    const list = importedByKey.get(importKey) ?? []
    list.push(candidate)
    importedByKey.set(importKey, list)
  }

  // Bank-id identity: an exact identity-hash match blocks even when
  // title/amount drifted. Reported as EXACT_IMPORT (exact prior import).
  // Raw bank ids never reach the database: rows carry them per request,
  // the lookup below matches on hashes computed at the boundary.
  const externalHashes = [
    ...new Set(
      rows
        .map((row) => externalIdentityHash(row.externalId, row.sourceAccount))
        .filter((hash): hash is string => hash !== null),
    ),
  ]
  const importedByExternalHash = new Map<string, ExistingExpenseCandidate[]>()
  if (externalHashes.length > 0) {
    const externalMatches = await client.expenseFileImportSource.findMany({
      where: {
        ledgerId,
        provider: EXPENSE_FILE_IMPORT_PROVIDER,
        externalIdentityHash: { in: externalHashes },
      },
      select: {
        externalIdentityHash: true,
        expense: {
          select: {
            id: true,
            title: true,
            expenseDate: true,
            expenseTimeZone: true,
            amount: true,
            originalAmount: true,
            originalCurrency: true,
          },
        },
      },
    })
    for (const { externalIdentityHash: hash, expense } of externalMatches) {
      if (!hash) continue
      const list = importedByExternalHash.get(hash) ?? []
      list.push(expense)
      importedByExternalHash.set(hash, list)
    }
  }

  const identities = rows.map((row) => matchIdentity(row, ledgerCurrencyCode))
  const candidateSelect = {
    id: true,
    title: true,
    expenseDate: true,
    expenseTimeZone: true,
    amount: true,
    originalAmount: true,
    originalCurrency: true,
  } as const
  // Normalized-identity probe set, computed once: a stored expense is a
  // duplicate candidate iff one of its match keys is wanted by an import
  // row. Pages below retain only matching rows, so memory stays bounded by
  // matches — never by ledger size.
  const wantedIdentities = new Set(
    identities.map((identity) => fuzzyMatchKey(identity)),
  )
  const candidatesByIdentity = new Map<string, ExistingExpenseCandidate[]>()
  // Exhaustive stable-ascending cursor pages over narrow merged date
  // windows (one per cluster of import dates). There is deliberately no
  // total cap: a cap that reports "clean" is a silent miss, while an
  // explicit resource failure would be honest. Each window costs pages
  // proportional to its size, so two distant dates no longer scan years of
  // unrelated expenses between them — and preview and commit share this
  // function, so both always agree.
  //
  // Safe SQL narrowing: every fuzzy match requires the imported source
  // amount to equal the stored `amount` or `originalAmount` (exact
  // integer-cent equality — no normalization involved, so unlike the title
  // predicate this can never exclude a true match). The existing
  // `[ledgerId, expenseDate, amount]` composite is the plausible access path
  // for the range+amount branch, but that is not verified: the
  // `OR originalAmount` branch and the `(expenseDate, id)` ordering need
  // `EXPLAIN (ANALYZE, BUFFERS)` evidence on representative data before any
  // efficiency claim — and no new index without it. The in-memory
  // `candidateMatches` check below stays authoritative for
  // currency/title/date. Deliberately no SQL title predicate: the in-memory
  // `normalizedTitle` comparison (NFKC + en-US lowercase + punctuation
  // folding + whitespace collapse) cannot be reproduced under the column
  // collation, so a database-side predicate could exclude true matches.
  // The (expenseDate, id) cursor is stable across pages; a concurrent insert
  // could shift a row across the page boundary, which only affects an
  // advisory duplicate flag, never a write.
  //
  // Advisory scope, stated plainly. Guaranteed: atomic all-or-nothing
  // persistence; exact re-import detection (side-table provenance is
  // insert-based, so it survives user edits and concurrent changes); and
  // preview/commit agreement (both share this function). Advisory only: the
  // EXISTING_EXPENSE fuzzy flags — ordinary expense updates use optimistic
  // version locking rather than this group lock, so an expense edited into a
  // matching duplicate after this check is missed. Serializing every write
  // path against imports would trade availability for a flag; the current
  // scope deliberately preserves existing update behavior.
  const DUPLICATE_CANDIDATE_PAGE_SIZE = 1000
  const wantedAmounts = [...new Set(identities.map(({ amount }) => amount))]
  const windows = dateWindows(identities.map(({ date }) => date))
  // Rows always carry dates (schema-required); without windows there is no
  // range to scan, and a full-ledger scan is never an acceptable fallback.
  let candidatesScanned = 0
  for (const bounds of windows) {
    let cursor: { expenseDate: Date; id: string } | null = null
    for (;;) {
      const page: ExistingExpenseCandidate[] = await client.expense.findMany({
        where: {
          ledgerId,
          expenseDate: { gte: bounds.gte, lt: bounds.lt },
          OR: [
            { amount: { in: wantedAmounts } },
            { originalAmount: { in: wantedAmounts } },
          ],
          ...(cursor
            ? {
                AND: [
                  {
                    OR: [
                      { expenseDate: { gt: cursor.expenseDate } },
                      {
                        expenseDate: cursor.expenseDate,
                        id: { gt: cursor.id },
                      },
                    ],
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ expenseDate: 'asc' }, { id: 'asc' }],
        take: DUPLICATE_CANDIDATE_PAGE_SIZE,
        select: candidateSelect,
      })
      if (page.length === 0) break
      candidatesScanned += page.length
      for (const candidate of page) {
        for (const key of candidateMatchKeys(candidate, ledgerCurrencyCode)) {
          if (!wantedIdentities.has(key)) continue
          const list = candidatesByIdentity.get(key) ?? []
          list.push(candidate)
          candidatesByIdentity.set(key, list)
        }
      }
      if (page.length < DUPLICATE_CANDIDATE_PAGE_SIZE) break
      const last = page[page.length - 1]!
      cursor = { expenseDate: last.expenseDate, id: last.id }
    }
  }

  const firstRowByBaseFingerprint = new Map<string, string>()
  const resultRows = rows.map((row, index) => {
    const matches: ExpenseFileImportMatch[] = []
    const seenExpenseIds = new Set<string>()
    for (const candidate of importedByKey.get(keys[index]!) ?? []) {
      matches.push(existingMatch(candidate, 'EXACT_IMPORT', ledgerCurrencyCode))
      seenExpenseIds.add(candidate.id)
    }
    const externalHash = externalIdentityHash(row.externalId, row.sourceAccount)
    if (externalHash) {
      for (const candidate of importedByExternalHash.get(externalHash) ?? []) {
        if (seenExpenseIds.has(candidate.id)) continue
        matches.push(
          existingMatch(candidate, 'EXACT_IMPORT', ledgerCurrencyCode),
        )
        seenExpenseIds.add(candidate.id)
      }
    }
    for (const candidate of candidatesByIdentity.get(
      fuzzyMatchKey(identities[index]!),
    ) ?? []) {
      if (
        seenExpenseIds.has(candidate.id) ||
        !candidateMatches(candidate, identities[index]!, ledgerCurrencyCode)
      ) {
        continue
      }
      matches.push(
        existingMatch(candidate, 'EXISTING_EXPENSE', ledgerCurrencyCode),
      )
      seenExpenseIds.add(candidate.id)
    }

    const firstRowId = firstRowByBaseFingerprint.get(row.source.baseFingerprint)
    if (firstRowId) {
      matches.push({
        key: `CURRENT_FILE:${firstRowId}`,
        kind: 'CURRENT_FILE',
        expenseId: null,
        sourceRowId: firstRowId,
        title: null,
        expenseDate: null,
        amount: null,
        currency: null,
      })
    } else {
      firstRowByBaseFingerprint.set(row.source.baseFingerprint, row.rowId)
    }

    return { rowId: row.rowId, rowNumber: row.rowNumber, matches }
  })
  return {
    rows: resultRows,
    stats: { windows: windows.length, candidatesScanned },
  }
}

/** Immutable provenance written to the side table for one imported expense. */
export type FileImportProvenance = {
  provider: string
  importKey: string
  externalIdentityHash: string | null
  semanticHash: string
  rawHash: string
  importedByAccountId: string
}

type PreparedExpenseFileImportRow = {
  row: ExpenseFileImportRow
  provenance: FileImportProvenance
  expenseId: string
  itemIds: string[]
  documentIds: string[]
  conversion: ConversionResolution
  /** Staged documents, promoted to permanent URLs by `prepare`. */
  documents: PromotedExpenseDocument[]
  preparedExpense: PreparedExpenseCreate
  bulkEligible: boolean
  activity: {
    id: string
    type: 'EXPENSE_CREATED'
    actorType: 'ACCOUNT'
    actorId: string
    subjectType: 'EXPENSE'
    subjectId: string
    data: ReturnType<typeof buildExpenseActivityData>
  }
}

export type PreparedExpenseFileImport = {
  rows: PreparedExpenseFileImportRow[]
  notificationBoss: Awaited<ReturnType<typeof getApiBoss>>
  summaryActivityId: string
  /** Currency snapshot used while resolving conversions outside the tx. */
  ledgerCurrencyCode: string | null
  /**
   * Ledger snapshot: expense-level persistence rows are built from this before
   * the group lock is acquired; the in-lock pass asserts it still matches
   * (groups never move between ledgers).
   */
  ledgerId: string
  /** Correlates the prepare/write/cleanup timing logs for one attempt. */
  attemptKey: string
  /**
   * Phase timings recorded incrementally by the write pass for the owner's
   * outcome log. Null until the first phase completes (prepare-only failures
   * log without a timing breakdown). Mutated, never replaced: the transaction
   * owner reads it after commit or failure. Partial on failure: only completed
   * phases plus `failedPhase`/`failedPhaseElapsedMs` for the interrupted
   * phase.
   */
  commitTimings: Partial<ExpenseFileImportCommitTimings> | null
}

/** Fixed phase names for import timing logs (no user data, no messages). */
export type ExpenseFileImportPhaseName =
  | 'lock'
  | 'duplicates'
  | 'validation'
  | 'writes'
  | 'recurring'
  | 'summary'

/**
 * Phase timings for one import attempt's write pass. All values are durations
 * (ms), counts, or fixed phase names — never messages, ids, or user data. Each
 * duration is measured once at its phase boundary and shared by the tracker and
 * the checkpoint log (never recomputed over a longer span).
 * `failedPhase`/`failedPhaseElapsedMs` appear only when a measured phase is
 * interrupted; completed phases keep their durations so failed imports stay
 * measurable.
 */
export type ExpenseFileImportCommitTimings = {
  lockWaitMs: number
  duplicatesMs: number
  duplicateWindows: number
  candidatesScanned: number
  validationMs: number
  writesMs: number
  recurringMs: number
  summaryMs: number
  failedPhase?: ExpenseFileImportPhaseName
  failedPhaseElapsedMs?: number
}

/**
 * Resolve storage, conversion, recurrence, and queue dependencies before the
 * transaction.
 *
 * External storage work runs here — before the group lock is acquired and
 * before the write transaction opens — so a slow object store never pins the
 * lock. Promotion copies staged `tmp/` uploads to `documents/` WITHOUT deleting
 * the staged sources (see `promoteUploadedDocumentDetailed`): the sources are
 * removed by `deleteImportTempSources` after commit, so failed imports and
 * duplicate-conflict retries reuse the same payload. Copies this attempt
 * created are tracked per document (`created`); the transaction owner's
 * compensation (`compensateImportAttempt`) removes the unreferenced ones on any
 * failure. Reused permanent objects report `created: false` and are never
 * deleted.
 */
export async function prepareExpenseFileImport(
  groupId: string,
  accountId: string,
  rows: ExpenseFileImportRow[],
): Promise<PreparedExpenseFileImport> {
  const prepareStartedAt = performance.now()
  // Minted up front so the prepare/commit/cleanup timing logs correlate, and
  // reused as the storage attempt key below (copies land on attempt-scoped
  // destinations no concurrent attempt can address).
  const attemptKey = randomId()
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: { ledger: true },
  })
  if (!group?.ledgerId)
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Group not found',
      cause: { code: 'IMPORT_GROUP_NOT_FOUND', params: {} },
    })
  if (group.archived)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This group is archived',
      cause: { code: 'IMPORT_GROUP_ARCHIVED', params: {} },
    })
  if (rows.length === 0)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Select at least one expense row',
      cause: { code: 'IMPORT_NO_ROWS_SELECTED', params: {} },
    })

  const ledgerCurrency = group.ledger.currencyCode ?? null
  const exchangeRequests: BatchRateRequest[] = []
  const exchangeRequestKeys = new Set<string>()
  // UTC date, not wall date: resolveConversion derives its lookup date from
  // the UTC instant (toIsoDate), and the group-import batch builder in
  // lib/api/import.ts uses the same UTC convention. Keying by wall date here
  // would request a different date than resolution looks up, so any expense
  // near midnight in a non-UTC zone would miss the cache and fail.
  const expenseIsoDate = (expense: Expense) =>
    expense.expenseDate instanceof Date
      ? expense.expenseDate.toISOString().slice(0, 10)
      : String(expense.expenseDate).slice(0, 10)
  for (const { expense } of rows) {
    const conversion = expense.conversion
    if (conversion?.type !== 'exchange') continue
    const expenseCurrency = conversion.currency?.toUpperCase()
    const ledgerIso = ledgerCurrency?.toUpperCase()
    if (!expenseCurrency || !ledgerIso || expenseCurrency === ledgerIso)
      continue
    if (
      !(supportedCurrencyCodes as readonly string[]).includes(
        expenseCurrency,
      ) ||
      !(supportedCurrencyCodes as readonly string[]).includes(ledgerIso)
    ) {
      continue
    }
    const request = {
      date: exchangeRateLookupDate(expenseIsoDate(expense)),
      base: expenseCurrency,
      target: ledgerIso,
    }
    const requestKey = `${request.date}|${request.base}|${request.target}`
    if (!exchangeRequestKeys.has(requestKey)) {
      exchangeRequestKeys.add(requestKey)
      exchangeRequests.push(request)
    }
  }
  const batchResults =
    exchangeRequests.length > 0 ? await getCurrencyRates(exchangeRequests) : []
  const rateByKey = new Map<
    string,
    { ok: true; rate: CurrencyRate } | { ok: false; error: unknown }
  >()
  for (let index = 0; index < exchangeRequests.length; index++) {
    const request = exchangeRequests[index]!
    const result = batchResults[index]
    // A missing batch slot is a programming invariant (requests and results
    // are built 1:1 above), not a provider gap: leave the key unset so
    // cachedFetch throws INTERNAL below instead of a misleading BAD_GATEWAY.
    if (!result) continue
    rateByKey.set(`${request.date}|${request.base}|${request.target}`, result)
  }
  const cachedFetch = async (args: {
    date: string
    base: string
    target: string
  }): Promise<CurrencyRate> => {
    const key = `${args.date}|${args.base.toUpperCase()}|${args.target.toUpperCase()}`
    const entry = rateByKey.get(key)
    if (!entry) {
      // Invariant, not a provider outage: the batch builder above must have
      // requested every (date, base, target) that resolution can ask for
      // (same UTC-date convention, same skip conditions). INTERNAL so a
      // future divergence surfaces as a bug, never as a gateway outage.
      // resolveExchange rethrows TRPCError untouched, so this code survives.
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `Missing rate request for ${args.base}→${args.target} on ${args.date}`,
      })
    }
    if (!entry.ok) {
      // User-triggerable (foreign-currency file + provider gap/outage), so a
      // gateway code — not INTERNAL — with the upstream message preserved.
      // Names the failing pair/date, states nothing was persisted (prepare
      // runs before the write transaction), and advises a retry since the
      // batch fetch already retried transient failures.
      const upstream =
        (entry.error as { message?: string } | undefined)?.message ??
        `Rate unavailable for ${args.base}→${args.target} on ${args.date}`
      throw new TRPCError({
        code: 'BAD_GATEWAY',
        message: `Exchange rate unavailable for ${args.base}→${args.target} on ${args.date} after retries (${upstream}). Nothing was imported; please retry in a minute.`,
        cause: {
          code: 'IMPORT_FX_RATE_UNAVAILABLE',
          params: {
            base: args.base,
            target: args.target,
            date: args.date,
            upstream,
          },
        },
      })
    }
    return entry.rate
  }
  const resolvedConversions = await Promise.all(
    rows.map(({ expense }) =>
      resolveConversion(
        expense,
        { ledgerCurrency, expenseDate: expense.expenseDate },
        { fetchImpl: cachedFetch },
      ),
    ),
  )
  const documentsByIndex = rows.map(({ expense }) => expense.documents)
  // Fallible dependency handles initialize BEFORE any copy: a rejected boss
  // acquisition must not strand created objects behind an uncompensated
  // prepare (preparation runs outside the transaction wrapper's try).
  const recurrenceBoss =
    jobsEnv.JOBS_ENABLED &&
    rows.some(({ expense }) =>
      getExpenseRecurrence(
        expense,
        dateOnlyInTimeZone(expense.expenseDate, expense.expenseTimeZone),
      ),
    )
      ? await getApiBossForWrite()
      : undefined
  const earlyNotificationBoss = await getApiBoss()
  // Promote staged documents BEFORE the transaction (never under the group
  // lock). Each prepare call mints an attempt key, so copies land on
  // attempt-scoped destinations no concurrent attempt can address: cleanup
  // below only ever sees this attempt's objects. Settled semantics: every
  // in-flight promotion completes first, so a single document failure still
  // tracks — and cleans — the successfully created siblings before the
  // first error is thrown. Row order and array lengths are preserved, so
  // the document ids preallocated below stay aligned with the promoted
  // documents.
  const settledPromotions = await promoteExpenseDocumentsDetailed(
    documentsByIndex.flat(),
    { concurrency: PROMOTION_CONCURRENCY, attemptKey },
  )
  const createdPromotionUrls = (settled: typeof settledPromotions) =>
    settled.flatMap((result) =>
      result.status === 'fulfilled' && result.value.created
        ? [result.value.url]
        : [],
    )
  const promotionFailure = settledPromotions.find(
    (result) => result.status === 'rejected',
  )
  if (promotionFailure?.status === 'rejected') {
    await cleanupUnusedImportCopies(
      createdPromotionUrls(settledPromotions),
      attemptKey,
    )
    throw promotionFailure.reason
  }
  let promotionOffset = 0
  const promotedByIndex = documentsByIndex.map((staged) => {
    const slice = settledPromotions.slice(
      promotionOffset,
      promotionOffset + staged.length,
    )
    promotionOffset += staged.length
    return slice.map((result) => {
      if (result.status !== 'fulfilled') {
        throw new Error('unreachable: promotion failures handled above')
      }
      return result.value
    })
  })
  // The row-building phase below runs after copies exist but still outside
  // any transaction: guard it so a failure here also compensates the
  // created copies instead of stranding them behind an unowned prepare.
  let preparedRows: PreparedExpenseFileImportRow[]
  try {
    preparedRows = rows.map((row, index) => {
      const expense = row.expense
      const conversion = resolvedConversions[index]!
      const expenseId = randomId()
      const recurrence = getExpenseRecurrence(
        expense,
        dateOnlyInTimeZone(expense.expenseDate, expense.expenseTimeZone),
      )
      const documents = promotedByIndex[index]!
      const activity = {
        id: randomId(),
        type: 'EXPENSE_CREATED' as const,
        actorType: 'ACCOUNT' as const,
        actorId: accountId,
        subjectType: 'EXPENSE' as const,
        subjectId: expenseId,
        data: buildExpenseActivityData({
          summary: expense.title,
          title: expense.title,
          amount: conversion.ledgerAmountMinor,
          // Parity with single-create (create-expense.ts): bare
          // originalCurrency, null for same-currency expenses.
          currencyCode: conversion.originalCurrency,
          // Wall date like the single-create path (create-expense): the UTC
          // instant date can differ near midnight in non-UTC zones.
          date: wallDateIso(expense.expenseDate, expense.expenseTimeZone),
          originalAmount: conversion.originalAmount ?? undefined,
          conversionRate: conversion.conversionRate ?? undefined,
          conversionSource: conversion.conversionSource,
          ledgerCurrencyCode: ledgerCurrency,
        }),
      }
      const preparedExpense: PreparedExpenseCreate = {
        conversion,
        documents,
        notificationBoss: null,
        recurrenceBoss,
        expenseId,
        activityId: activity.id,
        itemIds: (expense.items ?? []).map(() => randomId()),
        documentIds: documents.map(() => randomId()),
        ...(recurrence ? { recurringSeriesId: randomId() } : {}),
      }
      const itemIds = preparedExpense.itemIds ?? []
      const documentIds = preparedExpense.documentIds ?? []
      return {
        row,
        provenance: {
          provider: EXPENSE_FILE_IMPORT_PROVIDER,
          importKey: storedOriginKey(
            group.ledgerId!,
            row.source.originFingerprint,
          ),
          externalIdentityHash: externalIdentityHash(
            row.externalId,
            row.sourceAccount,
          ),
          semanticHash: row.source.baseFingerprint,
          rawHash: row.source.originFingerprint,
          importedByAccountId: accountId,
        },
        expenseId,
        itemIds,
        documentIds,
        conversion,
        documents,
        preparedExpense,
        bulkEligible: recurrence === null,
        activity,
      }
    })
  } catch (error) {
    await cleanupUnusedImportCopies(
      createdPromotionUrls(settledPromotions),
      attemptKey,
    )
    throw error
  }
  logServerInfo('expense-file-import', {
    attemptKey,
    phase: 'prepare',
    rows: rows.length,
    ms: Math.round(performance.now() - prepareStartedAt),
  })
  return {
    rows: preparedRows,
    notificationBoss: earlyNotificationBoss,
    summaryActivityId: randomId(),
    ledgerCurrencyCode: ledgerCurrency,
    ledgerId: group.ledgerId,
    attemptKey,
    commitTimings: null,
  }
}

type BulkExpenseLevelRows = {
  expenseRows: Prisma.ExpenseCreateManyInput[]
  importSourceRows: Prisma.ExpenseFileImportSourceCreateManyInput[]
  documentRows: Prisma.ExpenseDocumentCreateManyInput[]
  activityRows: Prisma.ActivityCreateManyInput[]
  expenseIdsByRow: Map<string, string>
}

/**
 * Participant-independent persistence rows, built BEFORE the group lock is
 * acquired (ledgerId comes from the prepared snapshot; the in-lock pass asserts
 * it still matches). Paid-by/paid-for/item rows stay in-lock: they need the
 * ITEMIZED resolutions computed from the participant sets read under the lock.
 * Pure and order-preserving: the in-lock relation loop iterates the same
 * `bulkItems` in the same order.
 */
function buildBulkExpenseLevelRows(args: {
  bulkItems: PreparedExpenseFileImportRow[]
  ledgerId: string
  accountId: string
}): BulkExpenseLevelRows {
  const expenseRows: Prisma.ExpenseCreateManyInput[] = []
  const importSourceRows: Prisma.ExpenseFileImportSourceCreateManyInput[] = []
  const documentRows: Prisma.ExpenseDocumentCreateManyInput[] = []
  const activityRows: Prisma.ActivityCreateManyInput[] = []
  const expenseIdsByRow = new Map<string, string>()
  for (const item of args.bulkItems) {
    const expense = item.row.expense
    const expenseId = item.expenseId
    const date = toSecondPrecision(new Date(expense.expenseDate))
    expenseRows.push({
      id: expenseId,
      ledgerId: args.ledgerId,
      createdByAccountId: args.accountId,
      expenseDate: date,
      expenseTimeZone: expense.expenseTimeZone,
      title: expense.title,
      categoryId: expense.category,
      amount: item.conversion.ledgerAmountMinor,
      originalAmount: item.conversion.originalAmount,
      originalCurrency: item.conversion.originalCurrency,
      conversionRate: item.conversion.conversionRate,
      conversionSource: item.conversion.conversionSource,
      paidBySplitMode: expense.paidBySplitMode,
      splitMode: expense.splitMode,
      notes: expense.notes,
    })
    importSourceRows.push({
      expenseId,
      ledgerId: args.ledgerId,
      ...item.provenance,
    })
    for (const [documentIndex, document] of item.documents.entries()) {
      documentRows.push({
        id: item.documentIds[documentIndex]!,
        ledgerId: args.ledgerId,
        expenseId,
        url: document.url,
        fileName: document.fileName ?? null,
        contentType: document.contentType ?? null,
        width: document.width ?? null,
        height: document.height ?? null,
      })
    }
    activityRows.push({
      id: item.activity.id,
      ledgerId: args.ledgerId,
      type: item.activity.type,
      actorType: item.activity.actorType,
      actorId: item.activity.actorId,
      subjectType: item.activity.subjectType,
      subjectId: expenseId,
      data: item.activity.data,
      visibleInGroupFeed: false,
    })
    expenseIdsByRow.set(item.row.rowId, expenseId)
  }
  return {
    expenseRows,
    importSourceRows,
    documentRows,
    activityRows,
    expenseIdsByRow,
  }
}

export async function importExpenseFile(
  args: {
    groupId: string
    accountId: string
    rows: ExpenseFileImportRow[]
  },
  options: {
    tx?: Prisma.TransactionClient
    prepared?: PreparedExpenseFileImport
  } = {},
) {
  if (args.rows.length === 0)
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Select at least one expense row',
      cause: { code: 'IMPORT_NO_ROWS_SELECTED', params: {} },
    })

  const prepared =
    options.prepared ??
    (await prepareExpenseFileImport(args.groupId, args.accountId, args.rows))

  // Participant-independent persistence rows are built here — before the
  // group lock is acquired, shortening the critical section. On the API path
  // the owner's transaction is already open (see `runIdempotentCreate`), so
  // the win is shorter lock hold time, not pre-transaction work; the
  // standalone path additionally runs before its own transaction opens. The
  // in-lock pass below asserts the prepared ledger snapshot still matches;
  // participant-dependent splits stay inside the lock.
  const bulkItems = prepared.rows.filter(({ bulkEligible }) => bulkEligible)
  const recurringItems = prepared.rows.filter(
    ({ bulkEligible }) => !bulkEligible,
  )
  const expenseLevelRows = buildBulkExpenseLevelRows({
    bulkItems,
    ledgerId: prepared.ledgerId,
    accountId: args.accountId,
  })

  const run = async (tx: Prisma.TransactionClient) => {
    // Incremental timing tracker: each phase syncs its durations/counts onto
    // the prepared attempt as it completes, so a later failure still logs
    // everything measured before it. Only durations, counts, and fixed phase
    // names — never messages, ids, or user data. Instrumentation only: no
    // queries, no branching, no transaction behavior change.
    const completedTimings: Partial<ExpenseFileImportCommitTimings> = {}
    let activePhase: ExpenseFileImportPhaseName | null = null
    let activeStartedAt = 0
    const beginPhase = (phase: ExpenseFileImportPhaseName) => {
      activePhase = phase
      activeStartedAt = performance.now()
    }
    const finishPhase = (
      phase: ExpenseFileImportPhaseName,
      values: Partial<ExpenseFileImportCommitTimings>,
    ) => {
      Object.assign(completedTimings, values)
      if (activePhase === phase) activePhase = null
      prepared.commitTimings = { ...completedTimings }
    }
    const failActivePhase = () => {
      if (activePhase) {
        const failedPhase = activePhase
        activePhase = null
        prepared.commitTimings = {
          ...completedTimings,
          failedPhase,
          failedPhaseElapsedMs: Math.round(performance.now() - activeStartedAt),
        }
      } else if (
        prepared.commitTimings == null &&
        Object.keys(completedTimings).length > 0
      ) {
        prepared.commitTimings = { ...completedTimings }
      }
    }

    // Lock acquisition only: the gate checks below run after `finishPhase`,
    // so a gate rejection carries the lock timing without claiming the lock
    // phase itself failed.
    beginPhase('lock')
    const lockWaitStartedAt = performance.now()
    const lockedGroup =
      await tx.$queryRaw`SELECT id FROM "Group" WHERE id = ${args.groupId} FOR UPDATE`
        .then(() =>
          tx.group.findUnique({
            where: { id: args.groupId },
            include: { ledger: true },
          }),
        )
        .catch((error: unknown) => {
          failActivePhase()
          throw error
        })
    const lockWaitMs = Math.round(performance.now() - lockWaitStartedAt)
    finishPhase('lock', { lockWaitMs })
    if (!lockedGroup?.ledgerId) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' })
    }
    if (lockedGroup.archived) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This group is archived',
      })
    }
    if (lockedGroup.ledgerId !== prepared.ledgerId) {
      // Invariant, not a user error: groups never move between ledgers, so a
      // mismatch means the caller paired a prepared snapshot with the wrong
      // group. INTERNAL so a future divergence surfaces as a bug.
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Prepared import does not match the locked group',
      })
    }
    if (prepared.ledgerCurrencyCode !== lockedGroup.ledger.currencyCode) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'The group currency changed while preparing this import. Please retry.',
        cause: { code: 'IMPORT_GROUP_CURRENCY_CHANGED', params: {} },
      })
    }

    beginPhase('duplicates')
    const duplicatesStartedAt = performance.now()
    const { rows: duplicateRows, stats: duplicateStats } =
      await findExpenseFileImportDuplicates(
        lockedGroup.ledgerId,
        lockedGroup.ledger.currencyCode ?? null,
        args.rows,
        tx,
      ).catch((error: unknown) => {
        failActivePhase()
        throw error
      })
    const duplicatesMs = Math.round(performance.now() - duplicatesStartedAt)
    finishPhase('duplicates', {
      duplicatesMs,
      duplicateWindows: duplicateStats.windows,
      candidatesScanned: duplicateStats.candidatesScanned,
    })
    const rowsById = new Map(args.rows.map((row) => [row.rowId, row]))
    const conflicts = duplicateRows.flatMap((result) => {
      const row = rowsById.get(result.rowId)
      const approved = new Set(row?.approvedDuplicateKeys ?? [])
      const unapproved = result.matches
        .map(({ key }) => key)
        .filter((key) => !approved.has(key))
      return unapproved.length === 0
        ? []
        : [
            {
              rowId: result.rowId,
              rowNumber: result.rowNumber,
              matchKeys: unapproved,
            },
          ]
    })
    if (conflicts.length > 0) {
      throw new ExpenseFileImportDuplicateError(conflicts)
    }

    // Participant snapshot for the pre-write validation below: membership
    // is read under the group lock so a concurrent member change cannot slip
    // between validation and the writes. Document copies are already promoted
    // (in `prepare`, before the lock); the validation pass gates the writes,
    // so a failing import leaves neither document rows nor orphaned stored
    // objects behind.
    const activeParticipants = await tx.ledgerParticipant.findMany({
      where: {
        ledgerId: lockedGroup.ledgerId,
        removedAt: null,
        OR: [
          { groupMemberId: { not: null } },
          { invitations: { some: { status: 'PENDING' } } },
          { kind: 'UNLINKED_PARTICIPANT' },
        ],
      },
      select: { id: true },
    })
    const removedParticipants = await tx.ledgerParticipant.findMany({
      where: { ledgerId: lockedGroup.ledgerId, removedAt: { not: null } },
      select: { id: true },
    })
    const activeParticipantIds = new Set(activeParticipants.map(({ id }) => id))
    const removedParticipantIds = new Set(
      removedParticipants.map(({ id }) => id),
    )
    // Built once: the per-expense helper used to allocate a fresh Set per
    // row (and again per ITEMIZED row). Settlements additionally admit
    // soft-removed participants; ordinary expenses must not see them.
    const settlementParticipantIds = new Set([
      ...activeParticipantIds,
      ...removedParticipantIds,
    ])
    const allowedIdsFor = (expense: Expense): Set<string> =>
      isSettlementCategory(expense.category)
        ? settlementParticipantIds
        : activeParticipantIds

    const assertParticipants = (expense: Expense, participantIds: string[]) => {
      const allowed = allowedIdsFor(expense)
      for (const participantId of participantIds) {
        if (!allowed.has(participantId)) {
          // Echoing the id is safe: participant ids are already visible to
          // the caller (group members are listed to build these rows, and
          // the duplicate preview echoes them), and it aids debugging.
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Invalid participant ID: ${participantId}`,
            cause: {
              code: 'IMPORT_INVALID_PARTICIPANT',
              params: { participantId },
            },
          })
        }
      }
    }

    // Pre-write validation over EVERY row, bulk and recurring-fallback
    // alike: participant membership plus ITEMIZED totals. All pure and
    // in-memory, so every row that would fail the loops below fails here —
    // before a single row is written, and the owner's compensation removes
    // the attempt-scoped copies made during preparation. Resolved ITEMIZED
    // shares are memoized for the loops (and for the summary recipients,
    // which must see the resolved splits rather than the raw input).
    beginPhase('validation')
    const validationStartedAt = performance.now()
    const resolvedPaidForByExpense = new Map<string, Expense['paidFor']>()
    let validationMs = 0
    try {
      for (const item of prepared.rows) {
        const expense = item.row.expense
        assertParticipants(expense, [
          ...expense.paidByList.map(({ participant }) => participant),
          ...expense.paidFor.map(({ participant }) => participant),
          ...(expense.items ?? []).flatMap(({ paidFor }) =>
            paidFor.map(({ participant }) => participant),
          ),
          ...(expense.itemizedRemainder?.paidFor.map(
            ({ participant }) => participant,
          ) ?? []),
        ])
        if (expense.splitMode === 'ITEMIZED') {
          // computePaidForFromItems throws plain ITEMS_EXCEED_AMOUNT for
          // API-crafted rows whose items sum past the total (the web UI never
          // sends items). Translate to BAD_REQUEST: a raw Error would surface
          // as INTERNAL for what is a client payload problem.
          try {
            resolvedPaidForByExpense.set(
              item.expenseId,
              computePaidForFromItems(
                expense.items ?? [],
                [...allowedIdsFor(expense)],
                item.conversion.originalAmount ??
                  item.conversion.ledgerAmountMinor,
                expense.itemizedRemainder,
                item.expenseId,
              ).paidFor,
            )
          } catch (error) {
            if (
              error instanceof Error &&
              error.message === 'ITEMS_EXCEED_AMOUNT'
            ) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `Row ${item.row.rowNumber}: item amounts exceed the expense total`,
                cause: {
                  code: 'IMPORT_ITEMS_EXCEED_TOTAL',
                  params: { rowNumber: item.row.rowNumber },
                },
              })
            }
            throw error
          }
        }
      }

      // ITEMIZED filler (`computePaidForFromItems`) expands to all members AFTER
      // the procedure-level 200k budget check, so enforce the resolved total
      // here — still before any write, with compensation covering the copies.
      const RESOLVED_SPLIT_BUDGET = 200_000
      let resolvedSplitTotal = 0
      for (const item of prepared.rows) {
        const expense = item.row.expense
        const resolvedPaidFor =
          resolvedPaidForByExpense.get(item.expenseId) ?? expense.paidFor
        resolvedSplitTotal +=
          expense.paidByList.length +
          resolvedPaidFor.length +
          (expense.items ?? []).reduce(
            (sum, entry) => sum + (entry.paidFor?.length ?? 0),
            0,
          ) +
          (expense.itemizedRemainder?.paidFor?.length ?? 0)
        if (resolvedSplitTotal > RESOLVED_SPLIT_BUDGET) break
      }
      if (resolvedSplitTotal > RESOLVED_SPLIT_BUDGET) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'Total split entries across rows exceeds the limit of 200_000',
          cause: { code: 'IMPORT_SPLIT_BUDGET_EXCEEDED', params: {} },
        })
      }
      validationMs = Math.round(performance.now() - validationStartedAt)
      finishPhase('validation', { validationMs })
    } catch (error) {
      failActivePhase()
      throw error
    }

    // Documents below are the pre-transaction promotions from `prepare`
    // (attempt-scoped destinations; validation gates the writes, and the
    // transaction owner's compensation removes created copies on failure).
    // Promotion preserves array length, so the document ids preallocated in
    // `prepare` stay aligned.
    beginPhase('writes')
    const writesStartedAt = performance.now()
    {
      const expenseIdsByRow = new Map<string, string>(
        expenseLevelRows.expenseIdsByRow,
      )
      const affectedParticipantIds = new Set<string>()

      // Relation rows only: expense/import-source/document/activity rows were
      // built before the lock (see `buildBulkExpenseLevelRows`). Same
      // `bulkItems` in the same order, so chunk alignment across tables is
      // preserved.
      const paidByRows: Prisma.ExpensePaidByCreateManyInput[] = []
      const paidForRows: Prisma.ExpensePaidForCreateManyInput[] = []
      const itemRows: Prisma.ExpenseItemCreateManyInput[] = []
      const itemPaidForRows: Prisma.ExpenseItemPaidForCreateManyInput[] = []
      const remainderRows: Prisma.ExpenseItemizedRemainderCreateManyInput[] = []
      const remainderPaidForRows: Prisma.ExpenseItemizedRemainderPaidForCreateManyInput[] =
        []

      // Summary recipients must see the splits actually persisted: for ITEMIZED
      // rows that is the item-derived resolution, not the raw input paidFor.
      const addAffectedParticipants = (
        expense: Expense,
        paidFor: Expense['paidFor'] = expense.paidFor,
      ) => {
        for (const participant of [
          ...expense.paidByList,
          ...paidFor,
          ...(expense.items ?? []).flatMap(({ paidFor }) => paidFor),
          ...(expense.itemizedRemainder?.paidFor ?? []),
        ]) {
          affectedParticipantIds.add(participant.participant)
        }
      }

      for (const item of bulkItems) {
        const expense = item.row.expense
        const expenseId = item.expenseId
        // Validated (participants, ITEMIZED totals) in the pre-write pass
        // above; reuse the memoized resolution here.
        const resolvedPaidFor =
          resolvedPaidForByExpense.get(expenseId) ?? expense.paidFor
        for (const paidBy of expense.paidByList) {
          paidByRows.push({
            expenseId,
            ledgerParticipantId: paidBy.participant,
            shares: paidBy.shares,
          })
        }
        for (const paidFor of resolvedPaidFor) {
          paidForRows.push({
            expenseId,
            ledgerParticipantId: paidFor.participant,
            shares: paidFor.shares,
          })
        }
        for (const [itemIndex, itemValue] of (expense.items ?? []).entries()) {
          const itemId = item.itemIds[itemIndex]!
          itemRows.push({
            id: itemId,
            expenseId,
            title: itemValue.title,
            unitPrice: itemValue.unitPrice,
            quantity: itemValue.quantity,
            amount: itemValue.amount,
            splitMode: itemValue.splitMode,
          })
          for (const paidFor of itemValue.paidFor) {
            itemPaidForRows.push({
              expenseItemId: itemId,
              ledgerParticipantId: paidFor.participant,
              shares: paidFor.shares,
            })
          }
        }
        if (expense.itemizedRemainder) {
          remainderRows.push({
            expenseId,
            splitMode: expense.itemizedRemainder.splitMode,
          })
          for (const paidFor of expense.itemizedRemainder.paidFor) {
            remainderPaidForRows.push({
              expenseId,
              ledgerParticipantId: paidFor.participant,
              shares: paidFor.shares,
            })
          }
        }
        expenseIdsByRow.set(item.row.rowId, expenseId)
        addAffectedParticipants(expense, resolvedPaidFor)
      }

      // A later chunk failing after earlier chunks committed still rolls back
      // the whole transaction — the elapsed write time stays measurable via
      // `failedPhase: 'writes'`.
      try {
        await createManyInBatches(expenseLevelRows.expenseRows, (data) =>
          tx.expense.createMany({ data }),
        )
        await createManyInBatches(paidByRows, (data) =>
          tx.expensePaidBy.createMany({ data }),
        )
        await createManyInBatches(paidForRows, (data) =>
          tx.expensePaidFor.createMany({ data }),
        )
        await createManyInBatches(itemRows, (data) =>
          tx.expenseItem.createMany({ data }),
        )
        await createManyInBatches(itemPaidForRows, (data) =>
          tx.expenseItemPaidFor.createMany({ data }),
        )
        await createManyInBatches(remainderRows, (data) =>
          tx.expenseItemizedRemainder.createMany({ data }),
        )
        await createManyInBatches(remainderPaidForRows, (data) =>
          tx.expenseItemizedRemainderPaidFor.createMany({ data }),
        )
        await createManyInBatches(expenseLevelRows.documentRows, (data) =>
          tx.expenseDocument.createMany({ data }),
        )
        await createManyInBatches(expenseLevelRows.importSourceRows, (data) =>
          tx.expenseFileImportSource.createMany({ data }),
        )
        await createManyInBatches(expenseLevelRows.activityRows, (data) =>
          tx.activity.createMany({ data }),
        )
      } catch (error) {
        failActivePhase()
        throw error
      }

      const writesMs = Math.round(performance.now() - writesStartedAt)
      finishPhase('writes', { writesMs })
      beginPhase('recurring')
      const recurringStartedAt = performance.now()
      try {
        // Recurring rows keep the canonical single-create fallback (complex
        // recurrence/series behavior stays on one code path), but reuse the
        // batch context validated above: participant sets read under this
        // group's lock and the memoized ITEMIZED resolution. Without this,
        // every recurring row would repeat both participant queries and the
        // itemized computation `createExpense` otherwise performs per row.
        for (const item of recurringItems) {
          const created = await createExpense(
            item.row.expense,
            args.groupId,
            { accountId: args.accountId },
            {
              tx,
              prepared: item.preparedExpense,
              itemizedPaidForResolution: resolvedPaidForByExpense.get(
                item.expenseId,
              ),
              batchContext: {
                groupLockHeld: true,
                visibleInGroupFeed: false,
                suppressNotification: true,
                fileImport: item.provenance,
                participants: {
                  active: [...activeParticipantIds],
                  removed: [...removedParticipantIds],
                },
              },
            },
          )
          expenseIdsByRow.set(item.row.rowId, created.id)
          addAffectedParticipants(
            item.row.expense,
            resolvedPaidForByExpense.get(item.expenseId) ??
              item.row.expense.paidFor,
          )
        }
      } catch (error) {
        failActivePhase()
        throw error
      }
      // Measured once here: the success path below reuses this value rather
      // than recomputing over the summary work that follows.
      const recurringMs = Math.round(performance.now() - recurringStartedAt)
      finishPhase('recurring', { recurringMs })

      // Keep the response deterministic even when a batch contains the uncommon
      // recurring rows that use the canonical fallback path after bulk inserts.
      const expenseIds = args.rows
        .map(({ rowId }) => expenseIdsByRow.get(rowId))
        .filter((id): id is string => Boolean(id))

      // Summary activity and notification planning are their own phase: they
      // run after the writes, so folding them into `recurringMs` would make
      // recurrence look expensive on imports without recurring rows — and
      // would disagree with the recurrence-only duration a summary failure
      // retains.
      beginPhase('summary')
      const summaryStartedAt = performance.now()
      let summaryMs = 0
      try {
        const summaryActivity = await logActivity(
          args.groupId,
          {
            id: prepared.summaryActivityId,
            type: 'EXPENSES_IMPORTED',
            actor: { type: 'ACCOUNT', id: args.accountId },
            subject: { type: 'GROUP', id: args.groupId },
            data: buildImportSummaryActivityData({
              summary: `Imported ${expenseIds.length} expenses from a file`,
              count: expenseIds.length,
              sourceProvider: 'Expense file',
              affectedParticipants: [...affectedParticipantIds],
            }),
          },
          tx,
          lockedGroup.ledgerId,
        )
        if (affectedParticipantIds.size > 0) {
          await planNotificationForActivity(
            tx,
            summaryActivity,
            { groupId: args.groupId },
            { boss: prepared.notificationBoss },
          )
        }
        summaryMs = Math.round(performance.now() - summaryStartedAt)
        finishPhase('summary', { summaryMs })
      } catch (error) {
        failActivePhase()
        throw error
      }

      // In-transaction checkpoint, not an outcome: the outer idempotency
      // update and the database commit still follow, and either can still
      // fail. The transaction owner logs `committed`/`failed` with these
      // timings stashed on the prepared attempt. Values are the
      // phase-boundary measurements above, re-packaged — never recomputed.
      const commitTimings: ExpenseFileImportCommitTimings = {
        lockWaitMs,
        duplicatesMs,
        duplicateWindows: duplicateStats.windows,
        candidatesScanned: duplicateStats.candidatesScanned,
        validationMs,
        writesMs,
        recurringMs,
        summaryMs,
      }
      prepared.commitTimings = commitTimings
      logServerInfo('expense-file-import', {
        attemptKey: prepared.attemptKey,
        phase: 'writes-complete',
        rows: args.rows.length,
        bulk: bulkItems.length,
        recurring: recurringItems.length,
        ...commitTimings,
      })

      return { importedCount: expenseIds.length, expenseIds }
    }
  }

  // Standalone timeout: only this self-owned transaction uses it. The API
  // path passes its transaction in (`options.tx`) with settings from the
  // transaction owner (`runIdempotentCreate`, see the procedure), so this
  // branch never applies there. The default 5s interactive-transaction
  // timeout is too tight for thousand-row batches (Prisma 7 supports
  // { timeout, maxWait } here).
  if (options.tx) return run(options.tx)
  try {
    const result = await prisma.$transaction(run, {
      timeout: 120_000,
      maxWait: 30_000,
    })
    // This branch owns the transaction, so the commit is known good here:
    // log the outcome, then run hygiene (non-throwing by construction, so it
    // never fails a committed import).
    logImportOutcome(prepared, { committed: true })
    await deleteImportTempSources(prepared)
    return result
  } catch (error) {
    // This branch owns the transaction, so it owns the outcome log and the
    // compensation: remove created copies the rolled-back writes can no
    // longer reference.
    logImportOutcome(prepared, { committed: false, error })
    await compensateImportAttempt(prepared)
    throw error
  }
}
