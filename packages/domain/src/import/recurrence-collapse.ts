import { isSettlementCategory } from '../categories'
import { calculateRecurrenceDate } from '../recurring-expenses'
import { legacyRuleToRecurrence, type LegacyRecurrenceRule } from './recurrence'
import type { RecurrenceConfig } from './types'

/** Minimal expense shape used to collapse legacy recurring rows into series. */
export type LegacyRecurringCollapseExpense = {
  title: string
  expenseDate: string | Date
  amount: number
  recurrenceRule: LegacyRecurrenceRule
  /**
   * Authoritative series cadence when the source supports it (e.g. Cospend's
   * yearly / multi-interval / dated-end schedules). When absent, the legacy
   * `recurrenceRule` is lifted into a config via `legacyRuleToRecurrence`.
   */
  recurrence?: RecurrenceConfig | null
  splitMode: string
  category: string
  paidBy: Array<{ id: string; shares: number }>
  paidFor: Array<{ id: string; shares: number }>
  originalCurrency?: string | null
  conversionRate?: number | null
}

/**
 * Resolve the effective series config for a collapsed expense: the explicit
 * `recurrence` when present, else the legacy rule lifted into a config.
 */
export function effectiveRecurringConfig(
  expense: Pick<
    LegacyRecurringCollapseExpense,
    'recurrenceRule' | 'recurrence'
  >,
): RecurrenceConfig | null {
  if (expense.recurrence) return expense.recurrence
  return legacyRuleToRecurrence(expense.recurrenceRule)
}

export type LegacyRecurringMembership = {
  expenseIndex: number
  seriesKey: string
  sequence: number
  isSeriesAnchor: boolean
}

export type LegacyRecurringSeriesPlan = {
  seriesKey: string
  title: string
  /**
   * Legacy rule of the anchor expense. May be `NONE` when the authoritative
   * cadence lives in `config` (e.g. Cospend yearly / multi-interval
   * schedules).
   */
  recurrenceRule: LegacyRecurrenceRule
  config: RecurrenceConfig
  /** Index of the latest (anchor) expense in the input array. */
  anchorIndex: number
  occurrenceCount: number
  nextOccurrenceDate: Date | null
  /**
   * 1-based anchored ordinal for `nextOccurrenceDate` (may be > 2 after
   * skipping overdue). `null` when the schedule end condition is exhausted.
   */
  nextOccurrenceOrdinal: number | null
}

export type LegacyRecurringImportPlan = {
  membership: LegacyRecurringMembership[]
  series: LegacyRecurringSeriesPlan[]
}

export type LegacyRecurringSummaryItem = {
  title: string
  /**
   * Legacy rule for the anchor expense. May be `NONE` when the authoritative
   * cadence lives in `config` (e.g. Cospend yearly / multi-interval
   * schedules).
   */
  recurrenceRule: LegacyRecurrenceRule
  /** Authoritative cadence (frequency + interval + end) for the series. */
  config: RecurrenceConfig
}

function toUtcDay(value: string | Date): Date {
  if (value instanceof Date) {
    return new Date(
      Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
    )
  }
  const iso = value.slice(0, 10)
  return new Date(`${iso}T00:00:00.000Z`)
}

function participantFingerprint(
  rows: Array<{ id: string; shares: number }>,
): string {
  return [...rows]
    .map((row) => `${row.id}:${row.shares}`)
    .sort()
    .join(',')
}

/** Conservative identity for collapsing historical occurrences of one schedule. */
export function fingerprintLegacyRecurringExpense(
  expense: LegacyRecurringCollapseExpense,
): string | null {
  const config = effectiveRecurringConfig(expense)
  if (!config) return null
  const endKey =
    config.end.type === 'DATE'
      ? `D:${config.end.endDate.toISOString()}`
      : config.end.type === 'COUNT'
        ? `C:${config.end.count}`
        : 'I'
  const currency = expense.originalCurrency ?? ''
  const rate =
    expense.conversionRate === null || expense.conversionRate === undefined
      ? ''
      : String(expense.conversionRate)
  return [
    expense.title,
    config.frequency,
    String(config.interval),
    endKey,
    String(expense.amount),
    expense.splitMode,
    isSettlementCategory(expense.category) ? '1' : '0',
    participantFingerprint(expense.paidBy),
    participantFingerprint(expense.paidFor),
    currency,
    rate,
  ].join('\u001f')
}

/**
 * Advance from the day after the latest occurrence until the first date
 * strictly after `today` (UTC calendar day). Uses anchored occurrence math
 * (same as materialization), not iterative next-from-previous stepping. Returns
 * both the date and the 1-based anchored ordinal for that date, or `null` if
 * the series end condition (DATE or COUNT) is exhausted.
 */
export function firstRecurrenceAfterToday(
  config: RecurrenceConfig,
  latestExpenseDate: string | Date,
  today: Date = new Date(),
  latestOccurrenceNumber = 1,
): { date: Date; ordinal: number } | null {
  const todayDay = toUtcDay(today)
  const anchor = toUtcDay(latestExpenseDate)

  if (
    config.end.type === 'DATE' &&
    anchor.getTime() >= toUtcDay(config.end.endDate).getTime()
  ) {
    return null
  }
  if (
    config.end.type === 'COUNT' &&
    latestOccurrenceNumber >= config.end.count
  ) {
    return null
  }

  let ordinal = 2
  let next = calculateRecurrenceDate(
    anchor,
    config.frequency,
    config.interval,
    ordinal,
  )
  while (next.getTime() <= todayDay.getTime()) {
    if (
      config.end.type === 'DATE' &&
      next.getTime() > toUtcDay(config.end.endDate).getTime()
    ) {
      return null
    }
    if (
      config.end.type === 'COUNT' &&
      latestOccurrenceNumber + ordinal - 1 > config.end.count
    ) {
      return null
    }
    ordinal += 1
    next = calculateRecurrenceDate(
      anchor,
      config.frequency,
      config.interval,
      ordinal,
    )
  }

  if (
    config.end.type === 'DATE' &&
    next.getTime() > toUtcDay(config.end.endDate).getTime()
  ) {
    return null
  }
  if (
    config.end.type === 'COUNT' &&
    latestOccurrenceNumber + ordinal - 1 > config.end.count
  ) {
    return null
  }

  return { date: next, ordinal }
}

/**
 * Advance from the day after the latest occurrence until the first date
 * strictly after `today` (UTC calendar day). Skips import catch-up backlogs.
 * Returns `null` if the series end condition is exhausted.
 */
export function firstRecurrenceDateAfterToday(
  config: RecurrenceConfig,
  latestExpenseDate: string | Date,
  today: Date = new Date(),
): Date | null {
  return (
    firstRecurrenceAfterToday(config, latestExpenseDate, today)?.date ?? null
  )
}

/**
 * Group matching recurring rows into one series plan each. Non-recurring
 * expenses are omitted from membership.
 */
export function planLegacyRecurringImport(
  expenses: LegacyRecurringCollapseExpense[],
  today: Date = new Date(),
): LegacyRecurringImportPlan {
  const groups = new Map<string, number[]>()
  expenses.forEach((expense, index) => {
    const key = fingerprintLegacyRecurringExpense(expense)
    if (!key) return
    const list = groups.get(key) ?? []
    list.push(index)
    groups.set(key, list)
  })

  const membership: LegacyRecurringMembership[] = []
  const series: LegacyRecurringSeriesPlan[] = []

  for (const [seriesKey, indexes] of groups) {
    const ordered = [...indexes].sort((a, b) => {
      const da = toUtcDay(expenses[a].expenseDate).getTime()
      const db = toUtcDay(expenses[b].expenseDate).getTime()
      if (da !== db) return da - db
      return a - b
    })
    const anchorIndex = ordered[ordered.length - 1]!
    const anchor = expenses[anchorIndex]!
    const config = effectiveRecurringConfig(anchor)
    if (!config) continue

    ordered.forEach((expenseIndex, offset) => {
      membership.push({
        expenseIndex,
        seriesKey,
        sequence: offset + 1,
        isSeriesAnchor: expenseIndex === anchorIndex,
      })
    })

    const next = firstRecurrenceAfterToday(
      config,
      anchor.expenseDate,
      today,
      ordered.length,
    )
    series.push({
      seriesKey,
      title: anchor.title,
      recurrenceRule: anchor.recurrenceRule,
      config,
      anchorIndex,
      occurrenceCount: ordered.length,
      nextOccurrenceDate: next ? next.date : null,
      nextOccurrenceOrdinal: next ? next.ordinal : null,
    })
  }

  series.sort((a, b) => {
    const titleCmp = a.title.localeCompare(b.title)
    if (titleCmp !== 0) return titleCmp
    return a.recurrenceRule.localeCompare(b.recurrenceRule)
  })

  return { membership, series }
}

/** Unique collapsed schedules for import confirm UI (one row per series). */
export function summarizeLegacyRecurringImport(
  expenses: LegacyRecurringCollapseExpense[],
): LegacyRecurringSummaryItem[] {
  return planLegacyRecurringImport(expenses)
    .series.filter((plan) => plan.nextOccurrenceDate !== null)
    .map((plan) => ({
      title: plan.title,
      recurrenceRule: plan.recurrenceRule,
      config: plan.config,
    }))
}

export function collapseExpenseFromNormalized(expense: {
  title: string
  expenseDate: string
  amount: number
  recurrenceRule: LegacyRecurrenceRule
  recurrence?: RecurrenceConfig | null
  splitMode: string
  category: string
  paidBySourceId?: string
  paidBy?: Array<{ sourceId: string; shares: number }>
  paidFor: Array<{ sourceId: string; shares: number }>
  originalCurrency?: string | null
  conversionRate?: number | null
}): LegacyRecurringCollapseExpense {
  const paidBy =
    expense.paidBy && expense.paidBy.length > 0
      ? expense.paidBy.map((row) => ({ id: row.sourceId, shares: row.shares }))
      : expense.paidBySourceId
        ? [{ id: expense.paidBySourceId, shares: expense.amount }]
        : []
  return {
    title: expense.title,
    expenseDate: expense.expenseDate,
    amount: expense.amount,
    recurrenceRule: expense.recurrenceRule,
    recurrence: expense.recurrence ?? null,
    splitMode: expense.splitMode,
    category: expense.category,
    paidBy,
    paidFor: expense.paidFor.map((row) => ({
      id: row.sourceId,
      shares: row.shares,
    })),
    originalCurrency: expense.originalCurrency,
    conversionRate: expense.conversionRate,
  }
}

export function collapseExpenseFromApi(expense: {
  title: string
  expenseDate: string | Date
  amount: number
  recurrenceRule?: LegacyRecurrenceRule | null
  recurrence?: RecurrenceConfig | null
  splitMode: string
  category: string
  paidByList: Array<{ participant: string; shares: number }>
  paidFor: Array<{ participant: string; shares: number }>
  originalCurrency?: string | null
  conversionRate?: number | null
  conversion?: { currency?: string; rate?: number } | null
}): LegacyRecurringCollapseExpense {
  const originalCurrency =
    expense.originalCurrency ??
    (expense.conversion && 'currency' in expense.conversion
      ? expense.conversion.currency
      : null) ??
    null
  const conversionRate =
    expense.conversionRate ??
    (expense.conversion && 'rate' in expense.conversion
      ? expense.conversion.rate
      : null) ??
    null
  return {
    title: expense.title,
    expenseDate: expense.expenseDate,
    amount: expense.amount,
    recurrenceRule: expense.recurrenceRule ?? 'NONE',
    recurrence: expense.recurrence ?? null,
    splitMode: expense.splitMode,
    category: expense.category,
    paidBy: expense.paidByList.map((row) => ({
      id: row.participant,
      shares: row.shares,
    })),
    paidFor: expense.paidFor.map((row) => ({
      id: row.participant,
      shares: row.shares,
    })),
    originalCurrency,
    conversionRate,
  }
}
