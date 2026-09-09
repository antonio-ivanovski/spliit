import { resolveCurrencyCode } from '../currency'
import {
  analyzeDelimitedDateOrder,
  DELIMITED_MAPPING_KIND,
  DELIMITED_MAPPING_VERSION,
  delimitedColumnSignature,
  parseDelimitedNumber,
  UNMAPPED_COLUMN_KEY,
  type DelimitedExpenseMappingV1,
  type DelimitedTable,
  type DelimitedVisualMapping,
  type DelimitedVisualTransform,
  type DelimitedMoneyMapping,
} from './generic-csv'
import {
  inspectDelimitedCurrency,
  isDelimitedMoneyInput,
} from './money-detection'
import type { ImportMessageParams } from './types'

export type ImportDetectionCode =
  | 'DETECTION_NO_MATCH'
  | 'DETECTION_TIED_COLUMN'
  | 'DETECTION_AUTO_DETECTED'
  | 'DETECTION_DATE_LIKE_TITLE'
  | 'DETECTION_DEBIT_CREDIT'
  | 'DETECTION_AMBIGUOUS_NUMBER_FORMAT'
  | 'DETECTION_AMBIGUOUS_CURRENCY'

export type ImportDetection = {
  reason?: 'SOURCE' | 'NUMBER_FORMAT' | 'CURRENCY'
  field: 'dateTime' | 'title' | 'money'
  /** Stable identifier for `ExpenseImport.detections.<code>` UI lookups. */
  code: ImportDetectionCode
  message: string
  /** Interpolation params for the UI lookup. */
  params: ImportMessageParams
  requiresConfirmation: boolean
  candidates: string[]
}
export type ImportInference = {
  mapping: DelimitedExpenseMappingV1
  detections: ImportDetection[]
}

// Textual month dates (`14-Mar-2022`, `Mar 14, 2022`): matched alongside the
// numeric pattern so realistic bank formats profile as dates. Day and year
// are required — `May 2022` alone is not parseable.
const MONTH_NAME =
  '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*'
const TEXTUAL_DATE_RE = new RegExp(
  `(?:\\d{1,2}[-/. ]${MONTH_NAME}[-/. ]\\d{2,4}|${MONTH_NAME} \\d{1,2},? \\d{2,4})`,
  'i',
)

/** An unrelated edit must not acknowledge an unresolved money interpretation. */
export function remainingMoneyDetections(
  entries: ImportDetection[],
  mapping: DelimitedMoneyMapping,
  table: DelimitedTable,
) {
  return entries.filter((entry) => {
    if (entry.field !== 'money') return true
    if (mapping.mode === 'CEL') return false
    if (entry.reason === 'NUMBER_FORMAT') {
      return !mapping.amount.transforms.some(
        (transform) =>
          (transform.kind === 'PARSE_NUMBER' ||
            transform.kind === 'DEBIT_CREDIT') &&
          transform.format !== 'AUTO',
      )
    }
    if (entry.reason === 'CURRENCY') {
      // Choosing one fixed currency is an explicit resolution. Source-based
      // currency still needs an unambiguous input on every populated row.
      if (!mapping.currency) return false
      const sources = mapping.currency.sourceValues.flatMap((source) => [
        source.primary,
        ...source.fallbacks,
      ])
      return table.rows.some((row) =>
        sources.some((key) => {
          const column = table.columns.find((column) => column.key === key)
          return (
            !column ||
            inspectDelimitedCurrency(row.cells[column.index] ?? '').ambiguous
          )
        }),
      )
    }
    return mapping.amount.sourceValues.some((source) => {
      const keys = [source.primary]
      for (const transform of mapping.amount.transforms) {
        // A renamed or deleted paired column must also keep the detection.
        if (transform.kind === 'DEBIT_CREDIT')
          keys.push(transform.debitColumn, transform.creditColumn)
      }
      return keys.some(
        (key) => !table.columns.some((column) => column.key === key),
      )
    })
  })
}

const header = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
const visual = (
  key: string,
  transforms: DelimitedVisualTransform[] = [{ kind: 'TRIM' }],
): DelimitedVisualMapping => ({
  mode: 'VISUAL',
  sourceValues: [{ primary: key, fallbacks: [] }],
  transforms,
})

export function inferNumberFormat(values: string[]): {
  format: 'AUTO' | 'DOT' | 'COMMA'
  ambiguous: boolean
} {
  let dot = false
  let comma = false
  let ambiguous = false
  for (const value of values) {
    const number = value.replace(/[^\d.,]/g, '')
    if (/\.\d{1,2}$/.test(number) || /,\d{3}\.\d+$/.test(number)) dot = true
    else if (/,\d{1,2}$/.test(number) || /\.\d{3},\d+$/.test(number))
      comma = true
    else if (/^\d{1,3}[.,]\d{3}$/.test(number)) ambiguous = true
    else if (/^\d{1,3}(,\d{3}){2,}$/.test(number)) dot = true
    else if (/^\d{1,3}(\.\d{3}){2,}$/.test(number)) comma = true
  }
  return {
    format: dot && !comma ? 'DOT' : comma && !dot ? 'COMMA' : 'AUTO',
    ambiguous: (dot && comma) || (!dot && !comma && ambiguous),
  }
}

/** One profiling pass; headers choose semantics while values verify suitability. */
export function inferDelimitedExpenseMapping(
  table: DelimitedTable,
  currencyCode: string,
  preferredDateOrder: 'MDY' | 'DMY' = 'MDY',
): ImportInference {
  const profiles = table.columns.map((column, index) => {
    const values = table.rows.map((row) => row.cells[index]?.trim() ?? '')
    const present = values.filter(Boolean)
    const ratio = (predicate: (value: string) => boolean) =>
      present.filter(predicate).length / Math.max(1, present.length)
    return {
      column,
      name: header(column.sourceLabel),
      values,
      present,
      coverage: present.length / Math.max(1, table.rows.length),
      numeric: ratio(
        (value) =>
          isDelimitedMoneyInput(value) &&
          parseDelimitedNumber(value, 'AUTO') !== null,
      ),
      date: ratio(
        (value) =>
          /(?:\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4})/.test(value) ||
          TEXTUAL_DATE_RE.test(value),
      ),
      text: ratio(
        (value) => /\p{L}/u.test(value) && !isDelimitedMoneyInput(value),
      ),
      currency: ratio((value) => inspectDelimitedCurrency(value).hasEvidence),
    }
  })
  type Profile = (typeof profiles)[number]
  const detections: ImportDetection[] = []
  const pick = (
    field: ImportDetection['field'],
    score: (profile: Profile) => number,
  ) => {
    const ranked = profiles
      .map((profile) => ({ profile, score: score(profile) }))
      .filter((hit) => hit.score >= 2)
      .sort((a, b) => b.score - a.score)
    const best = ranked[0]
    const tied = Boolean(
      best && ranked[1] && best.score - ranked[1].score < 0.35,
    )
    if (!best) {
      detections.push({
        field,
        code: 'DETECTION_NO_MATCH',
        requiresConfirmation: true,
        candidates: ranked.slice(0, 3).map((hit) => hit.profile.column.label),
        message: 'Choose a source column; no reliable match was found.',
        params: {},
      })
    } else if (tied) {
      detections.push({
        field,
        code: 'DETECTION_TIED_COLUMN',
        requiresConfirmation: true,
        candidates: ranked.slice(0, 3).map((hit) => hit.profile.column.label),
        message: `Check the detected ${best.profile.column.label} column; another column is equally plausible.`,
        params: { label: best.profile.column.label },
      })
    } else {
      detections.push({
        field,
        code: 'DETECTION_AUTO_DETECTED',
        requiresConfirmation: false,
        candidates: ranked.slice(0, 3).map((hit) => hit.profile.column.label),
        message: `Detected ${best.profile.column.label} from its header and values.`,
        params: { label: best.profile.column.label },
      })
    }
    return best?.profile
  }
  const date = pick('dateTime', (p) =>
    p.coverage && p.date >= 0.5
      ? p.date +
        p.coverage +
        (/transaction date|^date$|date time|timestamp/.test(p.name)
          ? 4
          : /posted|booking|date/.test(p.name)
            ? 3
            : 0)
      : 0,
  )
  const titleScore = (p: Profile) =>
    p.coverage && p.text >= 0.5
      ? p.text +
        p.coverage +
        (/description|merchant|payee/.test(p.name)
          ? 4
          : /note|memo|details|title/.test(p.name)
            ? 3
            : /account|category|currency|type|id|reference/.test(p.name)
              ? -4
              : 0)
      : 0
  const title = pick('title', (profile) =>
    // A column already claimed as the date (`Meeting 3/2/2022`) must not
    // double as the title: its values can never strictly parse as dates, so
    // letting both detections claim it confident hides an all-INVALID_DATE
    // file behind two green detections.
    profile.column.key === date?.column.key ? 0 : titleScore(profile),
  )
  if (date) {
    const dateProfile = profiles.find((p) => p.column.key === date.column.key)
    const dateDetection = detections.find((d) => d.field === 'dateTime')
    if (
      dateProfile &&
      dateDetection &&
      !dateDetection.requiresConfirmation &&
      titleScore(dateProfile) >= 2
    ) {
      // The date column also reads as prose. Its values likely embed dates
      // in text that strict parsing rejects, so the confident date pick is
      // suspect — force confirmation rather than failing every row quietly.
      dateDetection.requiresConfirmation = true
      dateDetection.code = 'DETECTION_DATE_LIKE_TITLE'
      dateDetection.message = `Check the detected ${date.column.label} column; its values also look like titles and may not parse as dates.`
      dateDetection.params = { label: date.column.label }
    }
  }
  const byHeader = (pattern: RegExp, allowEmpty = false) =>
    profiles
      .filter((p) => pattern.test(p.name) && (allowEmpty || p.coverage > 0))
      .sort((a, b) => b.coverage - a.coverage)[0]
  const debit = byHeader(/^(debit|withdrawal)( amount)?$/, true)
  const credit = byHeader(/^(credit|deposit)( amount)?$/, true)
  // A lone Credit/Debit lane is a usable amount column; when both lanes exist
  // they must stay penalized so the pair below wins over either lane alone.
  const loneLane = (name: string) =>
    (/^(credit|deposit)( amount)?$/.test(name) && !debit) ||
    (/^(debit|withdrawal)( amount)?$/.test(name) && !credit)
  const amount = pick('money', (p) =>
    p.coverage && p.numeric >= 0.6
      ? p.numeric +
        p.coverage +
        (/transaction amount|^amount$/.test(p.name)
          ? 5
          : /\bamount\b/.test(p.name)
            ? 4
            : /^value$|^total$/.test(p.name)
              ? 3
              : /\bvalue\b|\btotal\b/.test(p.name)
                ? 2.5
                : loneLane(p.name)
                  ? 2
                  : // Quantity/count columns are fully numeric but must never win
                    // over a price/total column: blind accept would import counts
                    // as cents. (`\bcount\b` avoids penalizing `discount`.)
                    /balance|account|id|date|reference|credit|debit|quantity|qty|\bcount\b|\bunits?\b/.test(
                        p.name,
                      )
                    ? -5
                    : 0)
      : 0,
  )
  const paired = !amount && debit && credit
  const number = inferNumberFormat(
    paired ? [...debit.present, ...credit.present] : (amount?.present ?? []),
  )
  if (paired)
    detections.splice(
      detections.findIndex((d) => d.field === 'money'),
      1,
      {
        field: 'money',
        code: 'DETECTION_DEBIT_CREDIT',
        message: 'Detected separate Debit and Credit columns.',
        params: {},
        requiresConfirmation: false,
        candidates: [debit.column.label, credit.column.label],
      },
    )
  if (number.ambiguous)
    detections.push({
      reason: 'NUMBER_FORMAT',
      field: 'money',
      code: 'DETECTION_AMBIGUOUS_NUMBER_FORMAT',
      message:
        'Confirm the number format: separators in this column are ambiguous or inconsistent.',
      params: {},
      requiresConfirmation: true,
      candidates: [],
    })
  const amountTransforms: DelimitedVisualTransform[] = paired
    ? [
        {
          kind: 'DEBIT_CREDIT',
          debitColumn: debit.column.key,
          creditColumn: credit.column.key,
          format: number.format,
        },
      ]
    : [{ kind: 'TRIM' }, { kind: 'PARSE_NUMBER', format: number.format }]
  const discriminator = byHeader(
    /income expense|credit debit|debit credit|transaction type|^type$/,
  )
  const negativeValues = ['income', 'credit', 'deposit']
  const positiveValues = ['expense', 'debit', 'withdrawal']
  if (
    !paired &&
    discriminator &&
    discriminator.present.every((value) =>
      [...negativeValues, ...positiveValues].includes(value.toLowerCase()),
    )
  ) {
    amountTransforms.push({
      kind: 'SIGN_FROM_COLUMN',
      columnKey: discriminator.column.key,
      negativeValues,
      positiveValues,
    })
  }
  const dateMapping = visual(date?.column.key ?? UNMAPPED_COLUMN_KEY, [
    { kind: 'TRIM' },
    { kind: 'PARSE_DATE', format: 'AUTO_MDY' },
  ])
  const order = analyzeDelimitedDateOrder(
    table,
    dateMapping,
    preferredDateOrder,
  )
  dateMapping.transforms[1] = {
    kind: 'PARSE_DATE',
    format: order.order === 'DMY' ? 'AUTO_DMY' : 'AUTO_MDY',
  }
  const titleMapping = visual(title?.column.key ?? UNMAPPED_COLUMN_KEY)
  if (title && title.coverage < 1) {
    const candidates = profiles
      .filter(
        (p) =>
          p !== title &&
          p.column.key !== date?.column.key &&
          titleScore(p) >= 3,
      )
      .sort((a, b) => titleScore(b) - titleScore(a))
    const covered = title.values.map(Boolean)
    for (const candidate of candidates) {
      if (candidate.values.some((value, index) => value && !covered[index])) {
        titleMapping.sourceValues[0]!.fallbacks.push(candidate.column.key)
        candidate.values.forEach((value, index) => {
          if (value) covered[index] = true
        })
      }
      if (titleMapping.sourceValues[0]!.fallbacks.length === 11) break
    }
  }
  const currency = profiles
    .filter(
      (p) => /^(currency|ccy|currency code)$/.test(p.name) && p.currency >= 0.5,
    )
    .sort((a, b) => b.coverage - a.coverage)[0]
  const hasCurrency = amount?.present.some(
    (value) => inspectDelimitedCurrency(value).hasEvidence,
  )
  const currencySource = currency ?? (hasCurrency ? amount : undefined)
  if (
    currencySource?.present.some(
      (value) => inspectDelimitedCurrency(value).ambiguous,
    )
  ) {
    detections.push({
      field: 'money',
      reason: 'CURRENCY',
      code: 'DETECTION_AMBIGUOUS_CURRENCY',
      message:
        'Choose a currency: this source contains ambiguous or conflicting currency symbols or codes.',
      params: {},
      requiresConfirmation: true,
      candidates: [],
    })
  }
  const optional = (pattern: RegExp) => {
    const p = byHeader(pattern)
    return p ? visual(p.column.key) : undefined
  }
  const mapping: DelimitedExpenseMappingV1 = {
    kind: DELIMITED_MAPPING_KIND,
    version: DELIMITED_MAPPING_VERSION,
    name: 'Expense file mapping',
    parsing: {
      delimiter: table.delimiter as ',' | ';' | '\t' | '|',
      headerRow: table.headerRow,
      encoding: table.encoding,
      columnSignature: delimitedColumnSignature(table),
    },
    mappings: {
      dateTime: dateMapping,
      title: titleMapping,
      money: {
        mode: 'VISUAL',
        amount: visual(
          amount?.column.key ?? debit?.column.key ?? UNMAPPED_COLUMN_KEY,
          amountTransforms,
        ),
        ...(currencySource
          ? {
              currency: visual(currencySource.column.key, [
                { kind: 'TRIM' },
                { kind: 'EXTRACT_CURRENCY' },
              ]),
            }
          : {}),
      },
      categorySource: optional(/^category$/),
      notes: optional(/^note$|memo|details/),
      externalId: optional(/transaction id|^id$|reference number|trace/),
      sourceAccount: optional(/^account$|account name|card/),
    },
    categoryBindings: {},
    defaults: {
      currencyCode: resolveCurrencyCode(currencyCode) ?? currencyCode,
      categoryId: 'general',
    },
  }
  return { mapping, detections }
}
