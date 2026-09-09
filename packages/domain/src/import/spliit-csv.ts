import Papa from 'papaparse'

import { DEFAULT_CATEGORIES, SETTLEMENT_CATEGORY_ID } from '../categories'
import type { Currency } from '../currency'
import { getCurrency } from '../currency'
import { distributeRemainder } from '../remainder-distribution'
import { amountAsMinorUnitsByCode } from '../utils'
import {
  recoverSpliitOriginalAmount,
  shouldRecoverSpliitOriginal,
} from './spliit-original-amount'
import { guessSplitMode } from './split-guess'
import type { ImportParseResult, NormalizedSource } from './types'

const FALLBACK_CURRENCY: Currency = {
  code: '',
  symbol: '',
  rounding: 0,
  decimal_digits: 2,
}

/**
 * Column indices for the immutable legacy spliit.app CSV export. This is not
 * the Spliit Cloud export format; keep the wire schema stable and map it to
 * current models after parsing.
 */
type CsvLayout = {
  /** Column index of `Is Settlement` or the legacy `Is Reimbursement` alias. */
  isReimbursement: number
  splitMode: number
  participantStart: number
}

function isSettlementCsvHeader(value: string | undefined): boolean {
  return value === 'Is Settlement' || value === 'Is Reimbursement'
}

function toNumberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isNaN(n) ? null : n
}

export function tryParseSpliitCsv(input: string): ImportParseResult {
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
  const header = rows[0]
  const layout = detectCsvLayout(header)
  if (!layout) {
    return {
      ok: false,
      error: 'CSV header is not a Spliit export',
      code: 'CSV_NOT_SPLIIT_EXPORT',
      params: {},
    }
  }

  const participantHeaders = header
    .slice(layout.participantStart)
    .map((h: string) => h.trim())
    .filter((h: string) => h.length > 0)

  if (participantHeaders.length === 0) {
    return {
      ok: false,
      error: 'CSV is missing participant columns',
      code: 'CSV_MISSING_PARTICIPANT_COLUMNS',
      params: {},
    }
  }

  const participantIndex = new Map<string, number>()
  const participants: NormalizedSource['participants'] = []
  for (const name of participantHeaders) {
    const key = name.toLowerCase()
    if (participantIndex.has(key)) continue
    const idx = participants.length
    participantIndex.set(key, idx)
    participants.push({
      sourceId: `csv-participant-${idx}`,
      sourceName: name,
    })
  }

  const expenses: NormalizedSource['expenses'] = []
  const currencyCounts = new Map<string, number>()
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (row.every((c: string) => (c ?? '').trim() === '')) continue
    const date = (row[0] ?? '').trim()
    const title = (row[1] ?? '').trim()
    const category = (row[2] ?? '').trim()
    const rowCurrency = (row[3] ?? '').trim().toUpperCase()
    const costMajor = toNumberOrNull(row[4])
    const isReimbursement =
      (row[layout.isReimbursement] ?? '').trim().toLowerCase() === 'yes'

    if (!/^\d{4}-\d{2}-\d{2}/.test(date)) continue
    if (title.length === 0) continue
    if (costMajor === null) continue
    const currencyCode = rowCurrency.length === 3 ? rowCurrency : ''
    const currency = getCurrency(currencyCode) ?? FALLBACK_CURRENCY
    const amountCents = amountAsMinorUnitsByCode(costMajor, currencyCode)

    if (rowCurrency.length === 3) {
      currencyCounts.set(
        rowCurrency,
        (currencyCounts.get(rowCurrency) ?? 0) + 1,
      )
    }

    type Entry = { sourceId: string; raw: number }
    const entries: Entry[] = []
    let paidBySourceId: string | null = null
    let firstZeroSourceId: string | null = null
    for (let i = layout.participantStart; i < header.length; i++) {
      const name = (header[i] ?? '').trim()
      if (!name) continue
      const raw = toNumberOrNull(row[i])
      if (raw === null) continue
      const idx = participantIndex.get(name.toLowerCase())
      if (idx === undefined) continue
      const sourceId = participants[idx].sourceId
      if (raw > 0 && !paidBySourceId) {
        paidBySourceId = sourceId
      } else if (raw === 0 && !firstZeroSourceId) {
        firstZeroSourceId = sourceId
      }
      if (raw !== 0) {
        entries.push({ sourceId, raw })
      }
    }
    if (!paidBySourceId) paidBySourceId = firstZeroSourceId
    if (!paidBySourceId) continue

    let paidFor: Array<{ sourceId: string; shares: number }>

    if (isReimbursement) {
      // Spliit encodes the receiver as the negative-value participant.
      // If the receiver isn't explicit (old-style), pick the first
      // non-payer participant so paidFor has a single entry.
      const receiver = entries.find((e) => e.raw < 0)
      if (receiver) {
        const payer = entries.find((e) => e.raw > 0)
        if (payer) paidBySourceId = payer.sourceId
        paidFor = [{ sourceId: receiver.sourceId, shares: amountCents }]
      } else {
        const other = entries.find((e) => e.sourceId !== paidBySourceId)
        if (other) {
          paidFor = [{ sourceId: other.sourceId, shares: amountCents }]
        } else {
          paidFor = [{ sourceId: paidBySourceId, shares: amountCents }]
        }
      }
    } else {
      // Participant cells are NET balances (paidBy − paidFor) from export-csv.
      // Reconstruct owed paidFor: debtors owe −net; payer owes cost − Σ(debtor).
      // Multi-payer uneven exports are underdetermined — remainder goes to paidBy.
      const scale = 10 ** currency.decimal_digits
      const nets = entries.map((e) => ({
        sourceId: e.sourceId,
        net: Math.round(e.raw * scale),
      }))
      const debtorSum = nets
        .filter((n) => n.net < 0)
        .reduce((s, n) => s - n.net, 0)

      const exact: Record<string, { numerator: bigint; denominator: bigint }> =
        {}
      for (const n of nets) {
        if (n.net < 0) {
          exact[n.sourceId] = { numerator: BigInt(-n.net), denominator: 1n }
        }
      }
      // Payer's share (and any multi-payer residual) so Σ paidFor === Cost.
      const payerShare = amountCents - debtorSum
      if (payerShare !== 0 || Object.keys(exact).length === 0) {
        exact[paidBySourceId] = {
          numerator:
            BigInt(Math.max(0, payerShare)) +
            (exact[paidBySourceId]?.numerator ?? 0n),
          denominator: 1n,
        }
      }

      const reconciled = distributeRemainder(exact, amountCents, {
        payerId: paidBySourceId,
      })
      paidFor = Object.entries(reconciled)
        .filter(([, shares]) => shares > 0)
        .map(([sourceId, shares]) => ({ sourceId, shares }))
    }

    if (paidFor.length === 0) continue

    const involvedCount = new Set([
      paidBySourceId,
      ...paidFor.map((p) => p.sourceId),
    ]).size

    const { splitMode, paidFor: resolvedPaidFor } = guessSplitMode(
      paidFor,
      amountCents,
      {
        involvedParticipantCount: involvedCount,
      },
    )

    // Cost is the source-group ledger total (reliable). Original cost is not
    // trusted — recover expense amount from ledger ÷ rate (upstream #513).
    // Once per parse only; no caching.
    const originalCurrencyRaw = (row[6] ?? '').trim()
    const conversionRate = toNumberOrNull(row[7])
    const shouldRecover = shouldRecoverSpliitOriginal({
      originalCurrency:
        originalCurrencyRaw.length === 3 ? originalCurrencyRaw : null,
      conversionRate,
    })
    const expenseAmount = shouldRecover
      ? recoverSpliitOriginalAmount(amountCents, conversionRate!, {
          originalCurrency: originalCurrencyRaw,
          ledgerCurrency: currencyCode || null,
        })
      : amountCents
    const expenseCurrency = shouldRecover
      ? originalCurrencyRaw
      : rowCurrency.length === 3
        ? rowCurrency
        : null
    expenses.push({
      title,
      expenseDate: date.slice(0, 10),
      category:
        isReimbursement || categoryToId(category) === SETTLEMENT_CATEGORY_ID
          ? SETTLEMENT_CATEGORY_ID
          : categoryToId(category),
      amountCurrency: expenseCurrency,
      amount: expenseAmount,
      originalAmount: shouldRecover ? expenseAmount : null,
      originalCurrency: shouldRecover ? originalCurrencyRaw : null,
      conversionRate: shouldRecover ? conversionRate : null,
      paidBySourceId,
      paidBy: [
        {
          sourceId: paidBySourceId,
          shares: expenseAmount,
        },
      ],
      paidFor: resolvedPaidFor,
      splitMode,
      recurrenceRule: 'NONE',
      recurrence: null,
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

  let mostCommonCurrency: string | null = null
  let maxCount = 0
  for (const [code, count] of currencyCounts) {
    if (count > maxCount) {
      maxCount = count
      mostCommonCurrency = code
    }
  }

  const currency = mostCommonCurrency
    ? (getCurrency(mostCommonCurrency)?.symbol ?? mostCommonCurrency)
    : ''

  return {
    ok: true,
    source: {
      provider: 'SPLIIT',
      exportVersion: null,
      sourceGroupId: 'csv-import',
      sourceUrl: null,
      name: 'Imported from CSV',
      information: null,
      currency,
      currencyCode: mostCommonCurrency,
      participants,
      expenses,
      documentSource: 'NONE',
    },
  }
}

/**
 * Accept the legacy spliit.app CSV layout (with the historical optional
 * Conversion source column). Current Cloud recurrence columns are rejected;
 * they are a different transport format and must not become part of this
 * importer’s public schema.
 */
function detectCsvLayout(header: string[]): CsvLayout | null {
  const baseOk =
    header[0] === 'Date' &&
    header[1] === 'Description' &&
    header[2] === 'Category' &&
    header[3] === 'Currency' &&
    header[4] === 'Cost' &&
    header[5] === 'Original cost' &&
    header[6] === 'Original currency' &&
    header[7] === 'Conversion rate'
  if (!baseOk) return null

  let isReimbursement: number
  let splitMode: number
  if (
    header[8] === 'Conversion source' &&
    isSettlementCsvHeader(header[9]) &&
    header[10] === 'Split mode'
  ) {
    isReimbursement = 9
    splitMode = 10
  } else if (isSettlementCsvHeader(header[8]) && header[9] === 'Split mode') {
    isReimbursement = 8
    splitMode = 9
  } else {
    return null
  }

  if (header.some((column) => /^Recurrence(?: |$)/i.test(column.trim()))) {
    return null
  }

  return {
    isReimbursement,
    splitMode,
    participantStart: splitMode + 1,
  }
}

function categoryToId(name: string): string {
  if (!name) return 'general'
  const key = name.toLowerCase()
  const match = DEFAULT_CATEGORIES.find((c) => c.name.toLowerCase() === key)
  return match?.id ?? 'general'
}
