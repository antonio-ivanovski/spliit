import Papa from 'papaparse'

import { SETTLEMENT_CATEGORY_ID } from '../categories'
import { getCurrency } from '../currency'
import { distributeRemainder } from '../remainder-distribution'
import { calculateExactShares } from '../totals'
import { amountAsMinorUnitsByCode } from '../utils'
import { cospendCategoryToId } from './cospend-categories'
import { recurrenceToLegacyRule } from './recurrence'
import { guessSplitMode } from './split-guess'
import type {
  ImportParseResult,
  NormalizedSource,
  RecurrenceConfig,
} from './types'

/**
 * Base currency assumed when the Cospend export carries no currencies section.
 * Cospend only writes the currencies block when a project has additional
 * currencies; the base currency is otherwise implicit. EUR is the default for
 * the (predominantly European) Cospend user base and can be corrected in the
 * destination step.
 */
const DEFAULT_CURRENCY = 'EUR'

/**
 * Cospend `repeat` codes mapped to a base frequency and base interval. `b`
 * (biweekly) is two weeks; `s` (semi-monthly) has no direct Spliit equivalent
 * and is approximated as monthly. The exported `repeatfreq` multiplies the base
 * interval.
 */
const REPEAT_BASE: Record<
  string,
  { frequency: RecurrenceConfig['frequency']; baseInterval: number }
> = {
  d: { frequency: 'DAILY', baseInterval: 1 },
  w: { frequency: 'WEEKLY', baseInterval: 1 },
  b: { frequency: 'WEEKLY', baseInterval: 2 },
  s: { frequency: 'MONTHLY', baseInterval: 1 },
  m: { frequency: 'MONTHLY', baseInterval: 1 },
  y: { frequency: 'YEARLY', baseInterval: 1 },
}

const MEMBER_HEADER = ['name', 'weight', 'active', 'color']
const BILL_HEADER = [
  'what',
  'amount',
  'date',
  'timestamp',
  'payer_name',
  'payer_weight',
  'payer_active',
  'owers',
  'repeat',
  'repeatfreq',
  'repeatallactive',
  'repeatuntil',
  'categoryid',
  'paymentmode',
  'paymentmodeid',
  'comment',
  'deleted',
]
const CATEGORY_HEADER = ['categoryname', 'categoryid', 'icon', 'color']
const PAYMENTMODE_HEADER = ['paymentmodename', 'paymentmodeid', 'icon', 'color']
const CURRENCY_HEADER = ['currencyname', 'exchange_rate']

function toNumberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isNaN(n) ? null : n
}

function isHeader(
  row: string[] | undefined,
  header: readonly string[],
): boolean {
  if (!row) return false
  if (row.length < header.length) return false
  return header.every((cell, i) => (row[i] ?? '').trim() === cell)
}

function isBlank(row: string[]): boolean {
  return row.every((c) => (c ?? '').trim() === '')
}

/** Build a RecurrenceConfig from Cospend repeat metadata, or null if none. */
function parseCospendRepeat(
  repeat: string,
  repeatFreq: number,
  repeatUntil: string,
): RecurrenceConfig | null {
  const base = REPEAT_BASE[repeat]
  if (!base) return null
  const multiplier =
    Number.isFinite(repeatFreq) && repeatFreq > 0 ? repeatFreq : 1
  const interval = Math.min(99, Math.max(1, base.baseInterval * multiplier))
  const until = repeatUntil.trim()
  const end: RecurrenceConfig['end'] = /^\d{4}-\d{2}-\d{2}$/.test(until)
    ? { type: 'DATE', endDate: new Date(`${until}T00:00:00.000Z`) }
    : { type: 'INDEFINITE' }
  return { frequency: base.frequency, interval, end }
}

/**
 * Parse a Cospend project CSV export into a normalized import source.
 *
 * Cospend exports one CSV per project with five sections (members, bills,
 * categories, payment modes, and optionally currencies) separated by blank
 * lines. The project name is not in the file body — only the filename slug — so
 * the group name defaults here and is refined from the filename upstream.
 */
export function tryParseCospendCsv(input: string): ImportParseResult {
  const cleaned = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const parsed = Papa.parse<string[]>(cleaned, {
    skipEmptyLines: 'greedy',
    header: false,
  })

  if (parsed.errors.length > 0) {
    return {
      ok: false,
      error: `CSV could not be parsed: ${parsed.errors[0]?.message ?? 'unknown error'}`,
    }
  }

  const rows = parsed.data

  // ── Locate section headers ────────────────────────────────────────────
  let membersStart = -1
  let billsStart = -1
  let categoriesStart = -1
  let currenciesStart = -1
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (membersStart === -1 && isHeader(row, MEMBER_HEADER)) membersStart = i
    else if (billsStart === -1 && isHeader(row, BILL_HEADER)) billsStart = i
    else if (categoriesStart === -1 && isHeader(row, CATEGORY_HEADER))
      categoriesStart = i
    else if (currenciesStart === -1 && isHeader(row, CURRENCY_HEADER))
      currenciesStart = i
  }

  if (membersStart === -1 || billsStart === -1) {
    return {
      ok: false,
      error:
        'CSV is not a Cospend project export (missing members or bills section)',
    }
  }

  // ── Members ───────────────────────────────────────────────────────────
  const participants: NormalizedSource['participants'] = []
  const nameToSourceId = new Map<string, string>()
  const nameToWeight = new Map<string, number>()
  for (let r = membersStart + 1; r < rows.length; r++) {
    const row = rows[r]
    if (isBlank(row)) continue
    if (
      isHeader(row, BILL_HEADER) ||
      isHeader(row, CATEGORY_HEADER) ||
      isHeader(row, PAYMENTMODE_HEADER) ||
      isHeader(row, CURRENCY_HEADER)
    ) {
      break
    }
    const name = (row[0] ?? '').trim()
    if (!name) continue
    const weight = toNumberOrNull(row[1]) ?? 1
    const sourceId = `cospend-member-${participants.length}`
    nameToSourceId.set(name, sourceId)
    nameToWeight.set(name, weight)
    participants.push({ sourceId, sourceName: name })
  }
  if (participants.length === 0) {
    return { ok: false, error: 'Cospend export has no members' }
  }

  // ── Categories (name → id) ────────────────────────────────────────────
  const categoryIdToName = new Map<string, string>()
  if (categoriesStart !== -1) {
    for (let r = categoriesStart + 1; r < rows.length; r++) {
      const row = rows[r]
      if (isBlank(row)) continue
      if (isHeader(row, CURRENCY_HEADER) || isHeader(row, PAYMENTMODE_HEADER))
        break
      const name = (row[0] ?? '').trim()
      const id = (row[1] ?? '').trim()
      if (name && id) categoryIdToName.set(id, name)
    }
  }

  // ── Currencies (main currency = row with exchange_rate 1, or first row) ──
  let baseCurrency = DEFAULT_CURRENCY
  if (currenciesStart !== -1) {
    for (let r = currenciesStart + 1; r < rows.length; r++) {
      const row = rows[r]
      if (isBlank(row)) continue
      if (
        isHeader(row, MEMBER_HEADER) ||
        isHeader(row, BILL_HEADER) ||
        isHeader(row, CATEGORY_HEADER) ||
        isHeader(row, PAYMENTMODE_HEADER)
      ) {
        break
      }
      const code = (row[0] ?? '').trim().toUpperCase()
      const rate = toNumberOrNull(row[1])
      // Upstream always writes the main currency first with exchange_rate = 1.
      // If the project had no custom currency name set, this row is ("", 1).
      // In that case, keep DEFAULT_CURRENCY rather than scanning forward to an
      // additional currency with exchange_rate != 1.
      if (rate === 1) {
        if (code) baseCurrency = code
        break
      }
      if (code) {
        baseCurrency = code
        break
      }
    }
  }
  const currencyCode = baseCurrency
  const currency = getCurrency(currencyCode) ?? {
    code: currencyCode,
    symbol: currencyCode,
    rounding: 0,
    decimal_digits: 2,
  }

  // ── Bills ─────────────────────────────────────────────────────────────
  const billsEnd =
    categoriesStart !== -1
      ? categoriesStart
      : currenciesStart !== -1
        ? currenciesStart
        : rows.length

  const expenses: NormalizedSource['expenses'] = []
  for (let r = billsStart + 1; r < billsEnd; r++) {
    const row = rows[r]
    if (isBlank(row)) continue
    const what = (row[0] ?? '').trim()
    const amount = toNumberOrNull(row[1])
    const date = (row[2] ?? '').trim()
    const payerName = (row[4] ?? '').trim()
    const owersRaw = (row[7] ?? '').trim()
    const repeat = (row[8] ?? '').trim()
    const repeatFreq = toNumberOrNull(row[9]) ?? 1
    const repeatUntil = (row[11] ?? '').trim()
    const categoryId = (row[12] ?? '').trim()
    const comment = (row[15] ?? '').trim()
    const deleted = (row[16] ?? '').trim()

    if (!what || amount === null || !/^\d{4}-\d{2}-\d{2}/.test(date)) continue
    if (deleted === '1') continue

    const payerSourceId = nameToSourceId.get(payerName)
    if (!payerSourceId) continue

    // Owning members share the cost proportionally to their weights.
    const owerNames = owersRaw
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
    const owers = owerNames
      .map((n) => ({
        sourceId: nameToSourceId.get(n),
        weight: nameToWeight.get(n) ?? 1,
      }))
      .filter((o): o is { sourceId: string; weight: number } =>
        Boolean(o.sourceId),
      )
    if (owers.length === 0) continue

    const amountCents = amountAsMinorUnitsByCode(amount, currency.code)

    // Weight-proportional split: scale weights to integers to keep the ratio
    // exact, then distribute the amount with rational arithmetic.
    const scaledWeights = owers.map((o) =>
      Math.round((o.weight > 0 ? o.weight : 1) * 100),
    )
    const exact = calculateExactShares({
      amount: amountCents,
      splitMode: 'BY_SHARES',
      participants: owers.map((o, i) => ({
        id: o.sourceId,
        shares: scaledWeights[i],
      })),
    })
    const fixed = distributeRemainder(exact, amountCents, {
      payerId: payerSourceId,
    })

    const paidFor: Array<{ sourceId: string; shares: number }> = []
    for (const o of owers) {
      const shares = fixed[o.sourceId] ?? 0
      if (shares > 0) paidFor.push({ sourceId: o.sourceId, shares })
    }
    if (paidFor.length === 0) continue

    const involvedCount = new Set([
      payerSourceId,
      ...paidFor.map((p) => p.sourceId),
    ]).size
    const { splitMode, paidFor: resolvedPaidFor } = guessSplitMode(
      paidFor,
      amountCents,
      { involvedParticipantCount: involvedCount },
    )

    const recurrence = parseCospendRepeat(repeat, repeatFreq, repeatUntil)
    const recurrenceRule = recurrenceToLegacyRule(recurrence)

    let notes: string | null = null
    if (comment) {
      try {
        notes = decodeURIComponent(comment.replace(/\+/g, ' '))
      } catch {
        notes = comment
      }
    }

    const categoryName = categoryId
      ? (categoryIdToName.get(categoryId) ?? null)
      : null
    const category =
      categoryId === '-11'
        ? SETTLEMENT_CATEGORY_ID
        : cospendCategoryToId(categoryName)

    expenses.push({
      title: what,
      expenseDate: date.slice(0, 10),
      category,
      amountCurrency: currency.code,
      amount: amountCents,
      originalAmount: null,
      originalCurrency: null,
      conversionRate: null,
      paidBySourceId: payerSourceId,
      paidBy: [{ sourceId: payerSourceId, shares: amountCents }],
      paidFor: resolvedPaidFor,
      splitMode,
      recurrenceRule,
      recurrence,
      notes,
    })
  }

  if (expenses.length === 0) {
    return { ok: false, error: 'Cospend export had no parseable bills' }
  }

  return {
    ok: true,
    source: {
      provider: 'COSPEND',
      exportVersion: null,
      sourceGroupId: 'cospend-csv-import',
      sourceUrl: null,
      name: 'Imported from Cospend',
      information: null,
      currency: currency.code,
      currencyCode: currency.code,
      participants,
      expenses,
      documentSource: 'NONE',
    },
  }
}
