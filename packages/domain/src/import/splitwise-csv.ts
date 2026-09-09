import Papa from 'papaparse'

import { SETTLEMENT_CATEGORY_ID } from '../categories'
import type { Currency } from '../currency'
import { getCurrency } from '../currency'
import { distributeRemainder } from '../remainder-distribution'
import {
  calculateExactShares,
  serializePaidBy,
  serializePaidFor,
} from '../totals'
import { amountAsMinorUnitsByCode } from '../utils'
import { guessSplitMode } from './split-guess'
import { splitwiseCategoryToId } from './splitwise-categories'
import {
  isSplitwiseHeader,
  isSplitwiseTotalBalanceLabel,
} from './splitwise-headers'
import type { ImportParseResult, NormalizedSource } from './types'

const PARTICIPANT_START_INDEX = 5

const FALLBACK_CURRENCY: Currency = {
  code: '',
  symbol: '',
  rounding: 0,
  decimal_digits: 2,
}

function toNumberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isNaN(n) ? null : n
}

export function tryParseSplitwiseCsv(input: string): ImportParseResult {
  const cleaned = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const parsed = Papa.parse<string[]>(cleaned, {
    skipEmptyLines: 'greedy',
    header: false,
  })

  const rows = parsed.data
  if (rows.length < 2) {
    return {
      ok: false,
      error: 'CSV has no data rows',
      code: 'CSV_NO_DATA_ROWS',
      params: {},
    }
  }
  if (parsed.errors.length > 0) {
    const detail = parsed.errors[0]?.message ?? 'unknown error'
    return {
      ok: false,
      error: `CSV could not be parsed: ${detail}`,
      code: 'CSV_PARSE_FAILED',
      params: { detail },
    }
  }

  let headerRowIdx = -1
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (isSplitwiseHeader(row)) {
      headerRowIdx = i
      break
    }
  }
  if (headerRowIdx === -1) {
    return {
      ok: false,
      error: 'CSV header is not a Splitwise export',
      code: 'CSV_NOT_SPLITWISE_EXPORT',
      params: {},
    }
  }
  const header = rows[headerRowIdx]

  const participantIndex = new Map<string, number>()
  const participants: NormalizedSource['participants'] = []
  for (let i = PARTICIPANT_START_INDEX; i < header.length; i++) {
    const name = (header[i] ?? '').trim()
    if (!name) continue
    const key = name.toLowerCase()
    if (participantIndex.has(key)) continue
    const idx = participants.length
    participantIndex.set(key, idx)
    participants.push({
      sourceId: `splitwise-participant-${idx}`,
      sourceName: name,
    })
  }
  if (participants.length === 0) {
    return {
      ok: false,
      error: 'CSV is missing participant columns',
      code: 'CSV_MISSING_PARTICIPANT_COLUMNS',
      params: {},
    }
  }

  const expenses: NormalizedSource['expenses'] = []
  const currencyCounts = new Map<string, number>()
  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r]
    if (row.every((c: string) => (c ?? '').trim() === '')) continue
    const date = (row[0] ?? '').trim()
    const title = (row[1] ?? '').trim()
    const category = (row[2] ?? '').trim()
    const cost = toNumberOrNull(row[3])
    const currencyCode = (row[4] ?? '').trim().toUpperCase()
    if (!/^\d{4}-\d{2}-\d{2}/.test(date)) continue
    if (!title) continue
    if (cost === null) continue
    if (currencyCode.length !== 3) continue
    if (isSplitwiseTotalBalanceLabel(title)) continue

    currencyCounts.set(
      currencyCode,
      (currencyCounts.get(currencyCode) ?? 0) + 1,
    )

    const isSettlement =
      category.toLowerCase() === 'payment' || /^.+ paid .+ /.test(title)

    // Per Splitwise convention each cell is `Paid - Owe`.
    let payerSourceId: string | null = null
    let maxRaw = -Infinity
    const entries: Array<{ sourceId: string; raw: number }> = []
    for (let i = PARTICIPANT_START_INDEX; i < header.length; i++) {
      const name = (header[i] ?? '').trim()
      if (!name) continue
      const raw = toNumberOrNull(row[i])
      if (raw === null) continue
      const idx = participantIndex.get(name.toLowerCase())
      if (idx === undefined) continue
      const sourceId = participants[idx].sourceId
      if (raw !== 0) {
        entries.push({ sourceId, raw })
      }
      if (raw > maxRaw) {
        maxRaw = raw
        payerSourceId = sourceId
      }
    }
    if (entries.length === 0 || maxRaw <= 0 || !payerSourceId) continue

    const currency = getCurrency(currencyCode) ?? {
      ...FALLBACK_CURRENCY,
      code: currencyCode,
      symbol: currencyCode,
    }
    const amountCents = amountAsMinorUnitsByCode(cost, currencyCode)
    const positiveEntries = entries.filter((e) => e.raw > 0)
    const negativeEntries = entries.filter((e) => e.raw < 0)

    // Negative cells are consumed shares (major units → minor via serializer).
    const negativeSerialized = serializePaidFor({
      splitMode: 'BY_AMOUNT',
      amount: amountCents,
      currency,
      paidFor: negativeEntries.map((e) => ({
        participant: { id: e.sourceId },
        shares: Math.abs(e.raw),
      })),
    })
    const negativeTotal = negativeSerialized.reduce((s, p) => s + p.shares, 0)
    const remainingShare = amountCents - negativeTotal

    // Positive participants share the remainder evenly via domain core.
    const positiveExact = calculateExactShares({
      amount: remainingShare,
      splitMode: 'EVENLY',
      participants: positiveEntries.map((e) => ({
        id: e.sourceId,
        shares: 1,
      })),
    })
    const positiveAllocated = distributeRemainder(positiveExact, remainingShare)

    const paidFor: Array<{ sourceId: string; shares: number }> = []
    for (const p of negativeSerialized) {
      if (p.shares > 0) {
        paidFor.push({ sourceId: p.participant.id, shares: p.shares })
      }
    }
    for (const e of positiveEntries) {
      const shares = positiveAllocated[e.sourceId] ?? 0
      if (shares > 0) paidFor.push({ sourceId: e.sourceId, shares })
    }
    if (paidFor.length === 0) continue

    // paidBy = positive raw (paid) + consumed share, in major units then serialize.
    const paidByMajor = positiveEntries.map((e) => {
      const consumed = positiveAllocated[e.sourceId] ?? 0
      const scale = 10 ** currency.decimal_digits
      return {
        participant: { id: e.sourceId },
        shares: Math.abs(e.raw) + consumed / scale,
      }
    })
    const paidBySerialized = serializePaidBy({
      paidBySplitMode: 'BY_AMOUNT',
      amount: amountCents,
      inputCurrency: currency,
      paidByList: paidByMajor,
    })
    // Ensure Σ paidBy === amount (integer residual → first positive / payer).
    const paidByExact = calculateExactShares({
      amount: amountCents,
      splitMode: 'BY_AMOUNT',
      participants: paidBySerialized.map((p) => ({
        id: p.participant.id,
        shares: p.shares,
      })),
    })
    const paidByFixed = distributeRemainder(paidByExact, amountCents, {
      payerId: payerSourceId,
    })
    const paidBy = Object.entries(paidByFixed).map(([sourceId, shares]) => ({
      sourceId,
      shares,
    }))

    // Best-effort split-mode guess (EVENLY / BY_SHARES / BY_AMOUNT).
    const involvedCount = new Set([
      ...paidBy.map((p) => p.sourceId),
      ...paidFor.map((p) => p.sourceId),
    ]).size
    const { splitMode, paidFor: resolvedPaidFor } = guessSplitMode(
      paidFor,
      amountCents,
      {
        involvedParticipantCount: involvedCount,
      },
    )

    expenses.push({
      title,
      expenseDate: date.slice(0, 10),
      category: isSettlement
        ? SETTLEMENT_CATEGORY_ID
        : splitwiseCategoryToId(category),
      amountCurrency: currencyCode,
      amount: amountCents,
      originalAmount: null,
      originalCurrency: null,
      conversionRate: null,
      paidBySourceId: payerSourceId,
      paidBy,
      paidFor: resolvedPaidFor,
      splitMode,
      recurrenceRule: 'NONE',
      notes: null,
    })
  }

  if (expenses.length === 0) {
    return {
      ok: false,
      error: 'CSV had no parseable expenses',
      code: 'CSV_NO_PARSEABLE_EXPENSES',
      params: {},
    }
  }

  let mostCommonCurrency = ''
  let maxCount = 0
  for (const [code, count] of currencyCounts) {
    if (count > maxCount) {
      maxCount = count
      mostCommonCurrency = code
    }
  }

  return {
    ok: true,
    source: {
      provider: 'SPLITWISE',
      exportVersion: null,
      sourceGroupId: 'splitwise-csv-import',
      sourceUrl: null,
      name: 'Imported from Splitwise',
      information: null,
      currency: mostCommonCurrency || '',
      currencyCode: mostCommonCurrency || null,
      participants,
      expenses,
      documentSource: 'NONE',
    },
  }
}
