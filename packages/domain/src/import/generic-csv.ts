import { Environment } from '@marcbachmann/cel-js'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat'
import Papa from 'papaparse'
import { z } from 'zod'

import { categoryIdSchema, INCOME_CATEGORY_ID } from '../categories'
import { getCurrency, resolveCurrencyCode } from '../currency'
import { amountAsMinorUnitsByCode } from '../utils'
import {
  resolveImportCategories,
  type ImportCategoryContext,
  type ImportCategoryProvenance,
} from './category-resolution'
import { inspectDelimitedCurrency } from './money-detection'
import type { ImportMessageParams } from './types'

dayjs.extend(customParseFormat)

export const DELIMITED_MAPPING_KIND = 'SPLIIT_DELIMITED_EXPENSE_MAPPING'
export const DELIMITED_MAPPING_VERSION = 1
export const MAX_DELIMITED_ROWS = 10_000
export const MAX_DELIMITED_COLUMNS = 500
export const MAX_DELIMITED_CELLS = 1_000_000

/**
 * Bound per-`exec` input for REGEX_EXTRACT evaluation. Only the first N
 * characters of a cell are tested so even a heuristic-bypassing evil pattern
 * cannot hang on a 1MB cell; legitimate extracts match near the start.
 */
export const MAX_REGEX_EXTRACT_INPUT_CHARS = 1_000

export type DelimitedEncoding = 'AUTO' | 'UTF-8' | 'WINDOWS-1252' | 'UTF-16'
export type DelimitedNumberFormat = 'AUTO' | 'DOT' | 'COMMA'

/** One scalar source value: a primary column followed by ordered fallbacks. */
export type DelimitedSourceValue = {
  primary: string
  fallbacks: string[]
}

export type DelimitedColumn = {
  index: number
  key: string
  label: string
  sourceLabel: string
  occurrence: number
}

export type DelimitedRow = {
  rowNumber: number
  cells: string[]
}

export type DelimitedTable = {
  columns: DelimitedColumn[]
  rows: DelimitedRow[]
  delimiter: string
  headerRow: number
  encoding: Exclude<DelimitedEncoding, 'AUTO'>
}

export type DelimitedParseResult =
  | { ok: true; table: DelimitedTable }
  | {
      ok: false
      error: string
      /**
       * Stable message identifier for UI translation. Kept alongside the
       * English `error` (tests/logs/compat depend on it).
       */
      code?: string
      params?: ImportMessageParams
    }

/**
 * Placeholder primary key when inference finds no source column. Rows must
 * never evaluate against it (see isUnmappedVisual): it would throw `No such
 * key` and leak the internal placeholder into user-facing errors.
 */
export const UNMAPPED_COLUMN_KEY = '__unmapped__'

/** True for VISUAL mappings still pointing at the inference placeholder. */
export function isUnmappedVisual(
  mapping:
    | DelimitedFieldMapping
    | DelimitedMoneyMapping
    | DelimitedVisualMapping
    | undefined,
): boolean {
  return (
    mapping?.mode === 'VISUAL' &&
    'sourceValues' in mapping &&
    mapping.sourceValues[0]?.primary === UNMAPPED_COLUMN_KEY
  )
}

/**
 * ReDoS guard for REGEX_EXTRACT: reject the classic nested-quantifier shape
 * where a group containing `+`/`*`/`{` is itself quantified (e.g. `(a+)+$`),
 * and ambiguous alternation inside a quantified group (e.g. `(a|aa)+$`, whose
 * branches match overlapping prefixes and blow up exponentially). Heuristic
 * (kept simple and documented): strip `\`-escapes, then reject a quantified
 * group whose balanced content contains `|` or an inner quantifier char.
 * Character classes are not distinguished, so `[(|)]+` also rejects. Sane
 * patterns like `(\d+)-(\d+)` (quantified groups followed by `-`) pass. Prefer
 * false-positive rejection of exotic patterns over missed evil ones; per-`exec`
 * input truncation (MAX_REGEX_EXTRACT_INPUT_CHARS) bounds any bypass that slips
 * through.
 */
function hasDelimitedNestedQuantifier(pattern: string): boolean {
  const unescaped = pattern.replace(/\\./g, '')
  if (/\([^()]*[+*{][^()]*\)[+*?{]/.test(unescaped)) return true
  if (/\([^()]*\|[^()]*\)[+*?{]/.test(unescaped)) return true
  const stack: number[] = []
  for (let index = 0; index < unescaped.length; index += 1) {
    const char = unescaped[index]
    if (char === '(') stack.push(index)
    else if (char === ')') {
      const open = stack.pop()
      if (open === undefined) continue
      const next = unescaped[index + 1]
      if (next === '+' || next === '*' || next === '?' || next === '{') {
        const inner = unescaped.slice(open + 1, index)
        if (inner.includes('|')) return true
        if (/[+*{]/.test(inner)) return true
      }
    }
  }
  return false
}

const visualTransformSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('JOIN'),
    separator: z.string().max(50).default(' '),
  }),
  z.object({ kind: z.literal('TRIM') }),
  z.object({ kind: z.literal('UPPER') }),
  z.object({ kind: z.literal('LOWER') }),
  z.object({
    kind: z.literal('REPLACE'),
    search: z.string().max(200),
    replacement: z.string().max(200),
  }),
  z.object({
    kind: z.literal('REGEX_EXTRACT'),
    pattern: z
      .string()
      .max(500)
      .refine((pattern) => !hasDelimitedNestedQuantifier(pattern), {
        message: 'Nested quantifiers are not allowed in REGEX_EXTRACT',
      }),
    group: z.number().int().min(0).max(20).default(0),
  }),
  z.object({
    kind: z.literal('PARSE_DATE'),
    format: z.string().trim().min(1).max(100),
  }),
  z.object({
    kind: z.literal('PARSE_NUMBER'),
    format: z.enum(['AUTO', 'DOT', 'COMMA']),
  }),
  z.object({ kind: z.literal('EXTRACT_CURRENCY') }),
  z.object({
    kind: z.literal('DEBIT_CREDIT'),
    debitColumn: z.string().min(1),
    creditColumn: z.string().min(1),
    format: z.enum(['AUTO', 'DOT', 'COMMA']),
  }),
  z.object({
    kind: z.literal('SIGN_FROM_COLUMN'),
    columnKey: z.string().min(1),
    negativeValues: z.array(z.string()).max(50),
    // Known-positive values suppress the SIGN_COLUMN_IGNORED warning (their
    // absolute() outcome is intended). Optional so previously saved mappings
    // keep validating; absence preserves the legacy warn-on-any-unlisted
    // behavior.
    positiveValues: z.array(z.string()).max(50).optional(),
  }),
])

const visualMappingSchema = z
  .object({
    mode: z.literal('VISUAL'),
    sourceValues: z
      .array(
        z.object({
          primary: z.string().min(1),
          fallbacks: z.array(z.string().min(1)).max(11).default([]),
        }),
      )
      .min(1)
      .max(12),
    transforms: z.array(visualTransformSchema).max(20).default([]),
  })
  .superRefine((mapping, context) => {
    const joinIndices = mapping.transforms.flatMap((transform, index) =>
      transform.kind === 'JOIN' ? [index] : [],
    )
    if (mapping.sourceValues.length > 1) {
      if (joinIndices.length !== 1 || joinIndices[0] !== 0) {
        context.addIssue({
          code: 'custom',
          path: ['transforms'],
          message:
            'A Join transformation must be first when combining source values',
        })
      }
    } else if (joinIndices.length > 1) {
      context.addIssue({
        code: 'custom',
        path: ['transforms'],
        message: 'A visual mapping can contain only one Join transformation',
      })
    }
  })

const celMappingSchema = z.object({
  mode: z.literal('CEL'),
  expression: z.string().trim().min(1).max(10_000),
})

export const delimitedFieldMappingSchema = z.discriminatedUnion('mode', [
  visualMappingSchema,
  celMappingSchema,
])

export type DelimitedVisualTransform = z.infer<typeof visualTransformSchema>
export type DelimitedVisualMapping = z.infer<typeof visualMappingSchema>
export type DelimitedCelMapping = z.infer<typeof celMappingSchema>
export type DelimitedFieldMapping = z.infer<typeof delimitedFieldMappingSchema>

const moneyVisualMappingSchema = z.object({
  mode: z.literal('VISUAL'),
  amount: visualMappingSchema,
  currency: visualMappingSchema.optional(),
})

const moneyCelMappingSchema = z.object({
  mode: z.literal('CEL'),
  expression: z.string().trim().min(1).max(10_000),
})

export const delimitedMoneyMappingSchema = z.discriminatedUnion('mode', [
  moneyVisualMappingSchema,
  moneyCelMappingSchema,
])

export type DelimitedMoneyMapping = z.infer<typeof delimitedMoneyMappingSchema>

export type DelimitedDateOrder = 'DMY' | 'MDY'
export type DelimitedDateOrderAnalysis = {
  status: 'DECISIVE' | 'AMBIGUOUS' | 'MIXED' | 'EXPLICIT'
  order: DelimitedDateOrder
  dmyRows: number[]
  mdyRows: number[]
  ambiguousRows: number[]
}

const parsingSchema = z.object({
  delimiter: z.enum([',', ';', '\t', '|']),
  headerRow: z.number().int().min(0).max(10_000).default(0),
  encoding: z.enum(['UTF-8', 'WINDOWS-1252', 'UTF-16']),
  columnSignature: z.array(z.string()).max(500),
})

const groupBindingsSchema = z.object({
  payerName: z.string().trim().min(1).max(200).optional(),
  paidBy: z
    .array(
      z.object({
        participantName: z.string().trim().min(1).max(200),
        shares: z.number().int(),
      }),
    )
    .max(100)
    .optional(),
  paidFor: z
    .array(
      z.object({
        participantName: z.string().trim().min(1).max(200),
        shares: z.number().int(),
      }),
    )
    .max(100)
    .optional(),
  paidBySplitMode: z
    .enum(['EVENLY', 'BY_SHARES', 'BY_PERCENTAGE', 'BY_AMOUNT'])
    .optional(),
  splitMode: z
    .enum(['EVENLY', 'BY_SHARES', 'BY_PERCENTAGE', 'BY_AMOUNT'])
    .optional(),
})

export const delimitedExpenseMappingSchema = z.object({
  kind: z.literal(DELIMITED_MAPPING_KIND),
  version: z.literal(DELIMITED_MAPPING_VERSION),
  name: z.string().trim().min(1).max(200),
  parsing: parsingSchema,
  mappings: z.object({
    dateTime: delimitedFieldMappingSchema,
    title: delimitedFieldMappingSchema,
    money: delimitedMoneyMappingSchema,
    categorySource: delimitedFieldMappingSchema.optional(),
    notes: delimitedFieldMappingSchema.optional(),
    externalId: delimitedFieldMappingSchema.optional(),
    sourceAccount: delimitedFieldMappingSchema.optional(),
  }),
  categoryBindings: z.record(z.string(), categoryIdSchema).default({}),
  defaults: z.object({
    currencyCode: z.string().trim().min(1).max(12),
    categoryId: categoryIdSchema.default('general'),
  }),
  groupBindings: groupBindingsSchema.optional(),
})

export type DelimitedExpenseMappingV1 = z.infer<
  typeof delimitedExpenseMappingSchema
>

export type DelimitedSourceIdentity = {
  baseFingerprint: string
  originFingerprint: string
}

export type DelimitedMappedRow = {
  categoryProvenance?: ImportCategoryProvenance
  rowId: string
  rowNumber: number
  source: DelimitedSourceIdentity
  title: string
  expenseDate: string
  expenseTimeMinutes: number
  amount: number
  currency: string
  category: z.infer<typeof categoryIdSchema>
  categorySource: string | null
  notes: string | null
  externalId: string | null
  sourceAccount: string | null
  issues: DelimitedRowIssue[]
  warning: string | null
  error: string | null
}

export type DelimitedRowIssue = {
  rowNumber: number
  field:
    | 'dateTime'
    | 'title'
    | 'amount'
    | 'currency'
    | 'categorySource'
    | 'notes'
    | 'externalId'
    | 'sourceAccount'
    | 'category'
  severity: 'warning' | 'error'
  code:
    | 'AMBIGUOUS_DATE'
    | 'INCONSISTENT_DATE_ORDER'
    | 'MAPPING_FAILED'
    | 'INVALID_DATE'
    | 'DATE_SOURCE_UNMAPPED'
    | 'MISSING_TITLE'
    | 'TITLE_SOURCE_UNMAPPED'
    | 'INVALID_AMOUNT'
    | 'AMOUNT_SOURCE_UNMAPPED'
    | 'UNSUPPORTED_CURRENCY'
    | 'CATEGORY_FALLBACK'
    | 'CATEGORY_NO_CONFIDENT_MATCH'
    | 'SIGN_COLUMN_IGNORED'
  message: string
  /**
   * Interpolation params for `ExpenseImport.issues.<code>` UI lookups. Kept
   * alongside the English `message` (tests/logs/compat depend on it).
   */
  params: ImportMessageParams
}

export type DelimitedPreviewRow = Omit<
  DelimitedMappedRow,
  'source' | 'rowId'
> & {
  rowId: string
}

const DELIMITER_CANDIDATES = [',', ';', '\t', '|'] as const

function inferDelimiter(input: string, headerRow = 0): string | undefined {
  let best: { delimiter: string; score: number } | undefined
  for (const delimiter of DELIMITER_CANDIDATES) {
    // Let Papa handle quoting and embedded newlines while sampling. Splitting
    // physical lines would mistake a delimiter inside a quoted cell for a
    // column boundary. Rows before the header row (preamble, notes) are
    // excluded from scoring so they cannot elect the wrong delimiter.
    const parsed = Papa.parse<string[]>(input, {
      delimiter,
      preview: headerRow + 12,
      skipEmptyLines: 'greedy',
    })
    const widths = parsed.data
      .slice(headerRow)
      .map((row) => row.length)
      .filter((width) => width > 0)
      .slice(0, 12)
    if (widths.length === 0) continue
    const frequency = new Map<number, number>()
    for (const width of widths)
      frequency.set(width, (frequency.get(width) ?? 0) + 1)
    const commonWidth = [...frequency.entries()].sort(
      ([widthA, countA], [widthB, countB]) =>
        countB - countA || widthB - widthA,
    )[0]?.[0]
    const consistent = commonWidth
      ? widths.filter((width) => width === commonWidth).length
      : 0
    const score = commonWidth > 1 ? commonWidth * consistent : 0
    if (!best || score > best.score) best = { delimiter, score }
  }
  return best?.score ? best.delimiter : undefined
}

function columnKeyBase(label: string): string {
  // Keys feed column signatures and therefore base fingerprints: truncating
  // past 128 chars keeps them bounded, at the accepted cost that a file
  // imported before the cap will not dedupe against a re-import when its
  // headers exceed the cap. Occurrence counting happens after truncation, so
  // long headers sharing a prefix still get distinct keys (no shadowing).
  return label
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 128)
}

function columnKey(label: string, occurrence: number): string {
  return `${columnKeyBase(label) || 'column'}#${occurrence}`
}

/**
 * NUL-parity heuristic for BOM-less UTF-16: ASCII-range text carries NULs at
 * odd byte indices (LE) or even indices (BE). Returns the winning side only
 * when the pattern predominantly favors one parity, else null.
 */
function sniffUtf16NulParity(
  input: Uint8Array,
): 'utf-16le' | 'utf-16be' | null {
  if (input.length < 4) return null
  const sampleLength = Math.min(input.length, 2048)
  let evenNuls = 0
  let oddNuls = 0
  for (let index = 0; index < sampleLength; index += 1) {
    if (input[index] === 0) {
      if (index % 2 === 0) evenNuls += 1
      else oddNuls += 1
    }
  }
  const totalNuls = evenNuls + oddNuls
  if (totalNuls >= 2 && sampleLength % 2 === 0) {
    const dominant = Math.max(evenNuls, oddNuls)
    if (dominant >= totalNuls * 0.7) {
      // The 70% bar admits only a strict majority — a 1-1 (or any tied)
      // split scores 50% and falls through — so reaching here means one
      // lane wins outright, and this is LE iff the odd lane wins.
      return oddNuls > evenNuls ? 'utf-16le' : 'utf-16be'
    }
  }
  return null
}

export function decodeDelimitedBytes(
  bytes: ArrayBuffer,
  encoding: DelimitedEncoding = 'AUTO',
): { text: string; encoding: Exclude<DelimitedEncoding, 'AUTO'> } {
  const input = new Uint8Array(bytes)
  const utf16Encoding =
    input[0] === 0xff && input[1] === 0xfe
      ? 'utf-16le'
      : input[0] === 0xfe && input[1] === 0xff
        ? 'utf-16be'
        : null
  // Excel and some bank tools export UTF-16; without BOM sniffing the bytes
  // decode as mojibake under windows-1252. No-BOM UTF-16 is assumed
  // little-endian, the Windows convention — except an explicitly requested
  // UTF-16 decode still runs the NUL-parity heuristic below when no BOM is
  // present, so BE files don't mojibake on explicit selection either.
  if (encoding === 'UTF-16' || (encoding === 'AUTO' && utf16Encoding)) {
    return {
      text: new TextDecoder(
        utf16Encoding ?? sniffUtf16NulParity(input) ?? 'utf-16le',
      ).decode(input),
      encoding: 'UTF-16',
    }
  }
  if (encoding === 'AUTO' && !utf16Encoding && input.length >= 4) {
    // No-BOM UTF-16: ASCII-range text carries NULs at odd indices (LE) or
    // even indices (BE). Only decode when the pattern predominantly favors
    // one parity; otherwise keep the UTF-8-first behavior below.
    const parity = sniffUtf16NulParity(input)
    if (parity) {
      return {
        text: new TextDecoder(parity).decode(input),
        encoding: 'UTF-16',
      }
    }
  }
  if (encoding === 'WINDOWS-1252') {
    return {
      text: new TextDecoder('windows-1252').decode(input),
      encoding: 'WINDOWS-1252',
    }
  }
  if (encoding === 'UTF-8') {
    return {
      text: new TextDecoder('utf-8').decode(input),
      encoding: 'UTF-8',
    }
  }
  try {
    return {
      text: new TextDecoder('utf-8', { fatal: true }).decode(input),
      encoding: 'UTF-8',
    }
  } catch {
    // A UTF-8 BOM decoded as windows-1252 surfaces as `ï»¿` and would pollute
    // the first header name. Strip it so the header stays clean.
    const text = new TextDecoder('windows-1252').decode(input)
    return {
      text: text.startsWith('ï»¿') ? text.slice(3) : text,
      encoding: 'WINDOWS-1252',
    }
  }
}

/** Parse a delimited statement without interpreting expense fields. */
export function parseDelimitedText(
  input: string,
  options: {
    headerRow?: number
    delimiter?: string
    encoding?: Exclude<DelimitedEncoding, 'AUTO'>
  } = {},
): DelimitedParseResult {
  const cleaned = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  // `AUTO` is accepted only as an internal parse request. The returned table
  // always carries the concrete delimiter selected by detection.
  const requestedDelimiter =
    options.delimiter && options.delimiter !== 'AUTO'
      ? options.delimiter
      : undefined
  const detectedDelimiter =
    requestedDelimiter ??
    inferDelimiter(cleaned, Math.max(0, options.headerRow ?? 0))
  const parsed = Papa.parse<string[]>(cleaned, {
    skipEmptyLines: 'greedy',
    header: false,
    delimiter: detectedDelimiter,
  })
  // Single-column files make Papa report `UndetectableDelimiter` ("Unable to
  // auto-detect delimiting character"). That raw error is unfriendly: treat
  // auto-detect failure as `detectedDelimiter=undefined` and fall through to
  // the width check below ("header needs at least two named columns").
  const fatalError = parsed.errors.find(
    (error) =>
      error.code !== 'TooFewFields' &&
      error.code !== 'TooManyFields' &&
      error.code !== 'UndetectableDelimiter',
  )
  if (fatalError) {
    return {
      ok: false,
      error: `The file could not be parsed: ${fatalError.message}`,
      code: 'DELIMITED_PARSE_FAILED',
      params: { detail: fatalError.message },
    }
  }
  if (parsed.data.length < 2) {
    return {
      ok: false,
      error: 'The file needs a header and at least one row',
      code: 'DELIMITED_NEEDS_HEADER_AND_ROWS',
      params: {},
    }
  }

  const headerRow = Math.max(
    0,
    Math.min(options.headerRow ?? 0, parsed.data.length - 2),
  )
  const dataRowCount = parsed.data.length - headerRow - 1
  if (dataRowCount > MAX_DELIMITED_ROWS) {
    return {
      ok: false,
      error: `The file cannot contain more than ${MAX_DELIMITED_ROWS.toLocaleString('en-US')} rows`,
      code: 'DELIMITED_TOO_MANY_ROWS',
      params: { max: MAX_DELIMITED_ROWS.toLocaleString('en-US') },
    }
  }
  const header = parsed.data[headerRow] ?? []
  let width = header.length
  for (let index = headerRow + 1; index < parsed.data.length; index += 1) {
    width = Math.max(width, parsed.data[index]?.length ?? 0)
  }
  if (width > MAX_DELIMITED_COLUMNS) {
    return {
      ok: false,
      error: `The file cannot contain more than ${MAX_DELIMITED_COLUMNS.toLocaleString('en-US')} columns`,
      code: 'DELIMITED_TOO_MANY_COLUMNS',
      params: { max: MAX_DELIMITED_COLUMNS.toLocaleString('en-US') },
    }
  }
  if (width * dataRowCount > MAX_DELIMITED_CELLS) {
    return {
      ok: false,
      error: 'The file contains too many cells to preview safely',
      code: 'DELIMITED_TOO_MANY_CELLS',
      params: {},
    }
  }
  if (width < 2 || header.filter((cell) => cell.trim()).length < 2) {
    return {
      ok: false,
      error: 'The header needs at least two named columns',
      code: 'DELIMITED_NEEDS_TWO_COLUMNS',
      params: {},
    }
  }

  const usedLabels = new Map<string, number>()
  const columns = Array.from({ length: width }, (_, index) => {
    const sourceLabel = (header[index] ?? '').trim() || `Column ${index + 1}`
    // Count occurrences per collapsed key, not per raw label: distinct headers
    // such as `Amount $` and `Amount!` collapse to the same key and must still
    // receive unique keys, otherwise row values silently shadow each other.
    const base = columnKeyBase(sourceLabel) || 'column'
    const occurrence = (usedLabels.get(base) ?? 0) + 1
    usedLabels.set(base, occurrence)
    return {
      index,
      sourceLabel,
      occurrence,
      key: columnKey(sourceLabel, occurrence),
      label: occurrence > 1 ? `${sourceLabel} (${occurrence})` : sourceLabel,
    }
  })
  const rows = parsed.data
    .slice(headerRow + 1)
    .map((cells, index) => ({
      rowNumber: headerRow + index + 2,
      cells: Array.from({ length: width }, (_, column) => cells[column] ?? ''),
    }))
    .filter((row) => row.cells.some((cell) => cell.trim()))

  if (rows.length === 0)
    return {
      ok: false,
      error: 'The file has no data rows',
      code: 'DELIMITED_NO_DATA_ROWS',
      params: {},
    }
  if (rows.length > MAX_DELIMITED_ROWS) {
    return {
      ok: false,
      error: `The file cannot contain more than ${MAX_DELIMITED_ROWS.toLocaleString('en-US')} rows`,
      code: 'DELIMITED_TOO_MANY_ROWS',
      params: { max: MAX_DELIMITED_ROWS.toLocaleString('en-US') },
    }
  }

  return {
    ok: true,
    table: {
      columns,
      rows,
      // Papa reports the delimiter it actually used; prefer it over a
      // hardcoded fallback so the table never claims `,` when unsure.
      delimiter: detectedDelimiter ?? parsed.meta.delimiter ?? ',',
      headerRow,
      encoding: options.encoding ?? 'UTF-8',
    },
  }
}

export function delimitedColumnSignature(table: DelimitedTable): string[] {
  return table.columns.map((column) => column.key)
}

export function parseDelimitedNumber(
  value: string,
  format: DelimitedNumberFormat = 'AUTO',
): number | null {
  let trimmed = value.trim()
  if (!trimmed) return null
  let parenthesizedNegative = false
  if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
    parenthesizedNegative = true
    trimmed = trimmed.slice(1, -1)
  }
  // Bank exports use non-ASCII minus/dash characters (U+2212 minus, en/em
  // dashes, fullwidth hyphen). Stripping them would silently flip a negative
  // to positive, so normalize a leading run to ASCII '-' first. Every
  // remaining unicode dash is also normalized to '-': an interior dash (a
  // range like `10-20`) then survives stripping as '-' and fails Number()
  // → null instead of silently becoming `1020`.
  trimmed = trimmed.replace(
    /^[\u2212\u2012\u2013\u2014\u2015\uFE58\uFE63\uFF0D]+/,
    '-',
  )
  trimmed = trimmed.replace(
    /[\u2212\u2012\u2013\u2014\u2015\uFE58\uFE63\uFF0D]/g,
    '-',
  )
  // Trailing CR/DR markers (single-amount statements): CR = money in
  // (negative expense), DR = money out (positive expense). Full tokens only —
  // a bare `C`/`D` is too ambiguous — and never silent: an unparseable
  // remainder still returns null below. The marker overrides the magnitude
  // sign so `(100)DR` and `-100CR` resolve deterministically. Amounts glue
  // the marker to the digits (`100CR`), so a digit boundary counts in
  // addition to `\b`; `100 CAD` is unaffected (no digit before `C`, and
  // `CA` is not a marker).
  const marker = /(?:(?<=\d)|\b)(CR|DR)\s*$/i.exec(trimmed)
  const markerNegative = marker ? marker[1]!.toUpperCase() === 'CR' : null
  if (marker) trimmed = trimmed.slice(0, marker.index).trim()
  // An unbalanced parenthesis (e.g. `(100`) previously stripped `(` as an
  // illegal char and returned `100`. Any `(`/`)` must form a single outer
  // `(…)` pair with no nesting; otherwise the cell is not a number. This runs
  // after CR/DR removal so `(100)DR` still resolves via its marker.
  if (/[()]/.test(trimmed)) {
    if (parenthesizedNegative) return null
    if (!(trimmed.startsWith('(') && trimmed.endsWith(')'))) return null
    const inner = trimmed.slice(1, -1)
    if (/[()]/.test(inner)) return null
    parenthesizedNegative = true
    trimmed = inner
    if (!trimmed.trim()) return null
  }
  trimmed = trimmed.replace(/[\s'\u00a0]/g, '').replace(/[^0-9,.+-]/g, '')
  if (!trimmed) return null
  // Explicit formats pin the decimal separator: the opposite separator in
  // decimal position (e.g. `1,5` under DOT, `1.5` under COMMA) or invalid
  // thousands grouping returns null instead of silently scaling 10× (15).
  // AUTO keeps its historical leniency byte-identical.
  if (format === 'DOT' || format === 'COMMA') {
    const valid =
      format === 'DOT'
        ? /^[+-]?(?:\d{1,3}(,\d{3})+(\.\d*)?|\d+(\.\d*)?|\.\d+)$/.test(trimmed)
        : /^[+-]?(?:\d{1,3}(\.\d{3})+(,\d*)?|\d+(,\d*)?|,\d+)$/.test(trimmed)
    if (!valid) return null
  }
  const lastComma = trimmed.lastIndexOf(',')
  const lastDot = trimmed.lastIndexOf('.')
  let decimalSeparator: string | null = null
  if (format === 'COMMA') decimalSeparator = ','
  else if (format === 'DOT') decimalSeparator = '.'
  else if (lastComma >= 0 && lastDot >= 0) {
    decimalSeparator = lastComma > lastDot ? ',' : '.'
  } else if (lastComma >= 0) {
    decimalSeparator = trimmed.length - lastComma - 1 === 3 ? null : ','
  } else if (lastDot >= 0) {
    decimalSeparator = trimmed.length - lastDot - 1 === 3 ? null : '.'
  }
  if (decimalSeparator) {
    const thousands = decimalSeparator === ',' ? '.' : ','
    trimmed = trimmed.replaceAll(thousands, '').replace(decimalSeparator, '.')
  } else {
    trimmed = trimmed.replaceAll(',', '').replaceAll('.', '')
  }
  const number = Number(trimmed)
  if (!Number.isFinite(number)) return null
  if (markerNegative !== null)
    return markerNegative ? -Math.abs(number) : Math.abs(number)
  return parenthesizedNegative ? -Math.abs(number) : number
}

function autoDateFormats(order: 'DMY' | 'MDY'): string[] {
  // Dayjs strict parsing requires token width to match digit width, so every
  // day/month needs both single- and double-digit variants.
  const dayFirst = order === 'DMY'
  const formats: string[] = []
  for (const day of ['D', 'DD']) {
    for (const month of ['M', 'MM']) {
      for (const separator of ['/', '-', '.']) {
        const dated = dayFirst
          ? `${day}${separator}${month}`
          : `${month}${separator}${day}`
        for (const time of [' H:mm:ss', ' H:mm', ' h:mm:ss A', ' h:mm A', '']) {
          formats.push(`${dated}${separator}YYYY${time}`)
        }
      }
    }
  }
  // Two-digit years with and without times, including 12-hour variants like
  // `03/02/22 10:11 AM` (dayjs strict parsing needs the `h:mm A` token).
  for (const day of ['D', 'DD']) {
    for (const month of ['M', 'MM']) {
      for (const separator of ['/', '-', '.']) {
        const dated = dayFirst
          ? `${day}${separator}${month}`
          : `${month}${separator}${day}`
        for (const time of [' H:mm:ss', ' H:mm', ' h:mm:ss A', ' h:mm A', '']) {
          formats.push(`${dated}${separator}YY${time}`)
        }
      }
    }
  }
  // English month names are order-independent (`14-Mar-2022`, `Mar 14, 2022`)
  // so they join both DMY and MDY lists. Dayjs strict `MMM`/`MMMM` is
  // case-sensitive; values are case-normalized before trying these (see
  // normalizeMonthNameCase in parseDateTime). Month names remove MDY/DMY
  // ambiguity, so covering every TEXTUAL_DATE_RE separator (`-`, `/`, `.`,
  // space) and both YYYY/YY years here is safe: it only turns profiling hits
  // into parseable dates instead of INVALID_DATE.
  for (const time of [' H:mm:ss', ' H:mm', ' h:mm:ss A', ' h:mm A', '']) {
    for (const year of ['YYYY', 'YY']) {
      for (const separator of ['-', '/', '.']) {
        formats.push(
          `D${separator}MMM${separator}${year}${time}`,
          `DD${separator}MMM${separator}${year}${time}`,
          `D${separator}MMMM${separator}${year}${time}`,
          `DD${separator}MMMM${separator}${year}${time}`,
        )
      }
      formats.push(
        `D MMM ${year}${time}`,
        `DD MMM ${year}${time}`,
        `D MMMM ${year}${time}`,
        `DD MMMM ${year}${time}`,
        `MMM D, ${year}${time}`,
        `MMM DD, ${year}${time}`,
        `MMMM D, ${year}${time}`,
        `MMMM DD, ${year}${time}`,
        `MMM D ${year}${time}`,
        `MMM DD ${year}${time}`,
        `MMMM D ${year}${time}`,
        `MMMM DD ${year}${time}`,
      )
    }
  }
  return formats
}

/**
 * Normalize English month-name case (`MAR`, `march` → `Mar`, `March`) for
 * strict dayjs parsing; `Sept` is normalized to dayjs' `Sep` abbreviation.
 */
function normalizeMonthNameCase(value: string): string {
  return value
    .replace(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/gi,
      (word) => {
        const lower = word.toLowerCase()
        if (lower === 'sept') return 'Sep'
        return lower.charAt(0).toUpperCase() + lower.slice(1)
      },
    )
    .replace(/\bSept\b/g, 'Sep')
}

const strictIsoDateFormats = [
  'YYYY-MM-DDTHH:mm:ss.SSS',
  'YYYY-MM-DDTHH:mm:ss',
  'YYYY-MM-DDTHH:mm',
  'YYYY-MM-DD',
  'YYYY/MM/DD HH:mm:ss',
  'YYYY/MM/DD HH:mm',
  'YYYY/MM/DD',
  'YYYY.MM.DD HH:mm:ss',
  'YYYY.MM.DD HH:mm',
  'YYYY.MM.DD',
]

function strictDateValues(value: string): string[] {
  const withoutTimezone = value.replace(/(?:Z|[+-]\d{2}:?\d{2})$/i, '')
  return withoutTimezone === value ? [value] : [value, withoutTimezone]
}

/**
 * Dayjs' strict custom-format parser treats timezone tokens as literals in this
 * browser-only parser. When a value has a trailing offset, also try the
 * equivalent format without that token so an explicit user format such as
 * `YYYY-MM-DDTHH:mm:ssZ` remains usable. We intentionally keep the original
 * format first, preserving normal custom-format behaviour for literal text.
 */
function strictDateFormatsForValue(
  format: string,
  originalValue: string,
  candidateValue: string,
): string[] {
  if (candidateValue === originalValue) return [format]
  const withoutTimezoneToken = format.replace(/\s*(?:\[Z\]|ZZ|Z)$/i, '')
  return withoutTimezoneToken === format
    ? [format]
    : [format, withoutTimezoneToken]
}

function isStrictIsoDateValue(value: string): boolean {
  return strictDateValues(value).some((candidateValue) =>
    strictIsoDateFormats.some((format) =>
      dayjs(candidateValue, format, true).isValid(),
    ),
  )
}

function isAutoDateValue(value: string, order: 'DMY' | 'MDY'): boolean {
  const trimmed = value.trim()
  const candidates =
    /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(trimmed) &&
    trimmed.includes('.')
      ? [trimmed, trimmed.replaceAll('.', '-')]
      : [trimmed]
  return candidates.some((candidate) =>
    autoDateFormats(order).some((format) =>
      dayjs(candidate, format, true).isValid(),
    ),
  )
}

function hasExplicitOffset(value: string): boolean {
  const trimmed = value.trim()
  if (/Z\s*$/i.test(trimmed)) return true
  // A trailing `-YYYY` in dash-separated textual dates (`14-Mar-2022` ends
  // with `-2022`) is a year, not a `-20:22` timezone. Numeric offsets only
  // count when the value carries time evidence (`:`/`T`); real offsets always
  // follow a wall time, while date-only years do not.
  if (!/[:Tt]/.test(trimmed)) return false
  return /[+-]\d{2}:?\d{2}\s*$/.test(trimmed)
}

function parseDateTime(value: string, format: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (hasExplicitOffset(trimmed)) {
    // Preserve the instant for offset-bearing values: dayjs strict formats
    // cannot parse offsets (no utc/timezone plugins), so wall-time stripping
    // would land on the wrong wall date. `new Date` is instant-correct.
    // Date-only values with a vestigial `Z`/offset (`2022-03-14Z`) carry no
    // instant evidence — running them through the instant path formats in the
    // runtime's local zone and can shift the calendar day. They fall through
    // to the strict date-only formats below (noon-anchored like all dates).
    const dateOnlyWithOffset =
      /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
    if (!dateOnlyWithOffset) {
      const instant = new Date(trimmed)
      if (!Number.isNaN(instant.getTime())) {
        // Format the instant in UTC so the same file commits the same wall
        // time in every runtime zone (dayjs(instant).format uses the local
        // zone and shifts the calendar day). Built from getUTC* parts to avoid
        // adding the dayjs utc plugin for this single call site.
        const pad = (part: number) => String(part).padStart(2, '0')
        return `${instant.getUTCFullYear()}-${pad(instant.getUTCMonth() + 1)}-${pad(instant.getUTCDate())}T${pad(instant.getUTCHours())}:${pad(instant.getUTCMinutes())}`
      }
    }
  }
  if (format === 'AUTO_DMY' || format === 'AUTO_MDY') {
    const formats = [
      ...strictIsoDateFormats,
      ...autoDateFormats(format === 'AUTO_DMY' ? 'DMY' : 'MDY'),
    ]
    for (const candidateValue of strictDateValues(trimmed)) {
      const monthNormalized = normalizeMonthNameCase(candidateValue)
      const baseVariants =
        monthNormalized === candidateValue
          ? [candidateValue]
          : [candidateValue, monthNormalized]
      // Dayjs cannot parse textual months with `.` separators (`14.Sep.2022`
      // fails even loosely), so also try dots as dashes for month-name values.
      // `/` already parses via its own formats; numeric dotted dates
      // (`31.12.2024`) are untouched because they contain no month name.
      const variants = baseVariants.flatMap((variant) =>
        /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(variant) &&
        variant.includes('.')
          ? [variant, variant.replaceAll('.', '-')]
          : [variant],
      )
      for (const variant of variants) {
        for (const candidate of formats) {
          const parsed = dayjs(variant, candidate, true)
          if (parsed.isValid()) return parsed.format('YYYY-MM-DDTHH:mm')
        }
      }
    }
    return ''
  }
  for (const candidateValue of strictDateValues(trimmed)) {
    for (const candidateFormat of strictDateFormatsForValue(
      format,
      trimmed,
      candidateValue,
    )) {
      const parsed = dayjs(candidateValue, candidateFormat, true)
      if (parsed.isValid()) return parsed.format('YYYY-MM-DDTHH:mm')
    }
  }
  return ''
}

function clean(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ')
}

function regexExtract(value: string, pattern: string, group: bigint): string {
  if (hasDelimitedNestedQuantifier(pattern)) {
    throw new Error(
      `Nested quantifiers are not allowed in REGEX_EXTRACT: ${truncateDelimitedRaw(pattern)}`,
    )
  }
  let expression: RegExp
  try {
    expression = new RegExp(pattern, 'u')
  } catch {
    // Surface a bad pattern as a mapping failure naming the transform instead
    // of blanking the value (which misattributes the fault to MISSING_TITLE
    // and hides the typo).
    throw new Error(
      `Invalid regular expression in REGEX_EXTRACT: ${truncateDelimitedRaw(pattern)}`,
    )
  }
  const input = value.slice(0, MAX_REGEX_EXTRACT_INPUT_CHARS)
  return expression.exec(input)?.[Number(group)] ?? ''
}

const mappingEnvironment = new Environment({
  unlistedVariablesAreDyn: false,
  homogeneousAggregateLiterals: false,
  limits: {
    maxAstNodes: 500,
    maxDepth: 40,
    maxListElements: 100,
    maxMapEntries: 100,
    maxCallArguments: 16,
  },
})
  .registerVariable('row', 'map<string, string>')
  .registerFunction('clean(string): string', clean)
  .registerFunction('upperText(string): string', (value) => value.toUpperCase())
  .registerFunction('lowerText(string): string', (value) => value.toLowerCase())
  .registerFunction('absolute(double): double', (value) => Math.abs(value))
  .registerFunction(
    'firstNonEmpty(list<string>): string',
    (values) => values.map(clean).find(Boolean) ?? '',
  )
  .registerFunction(
    'joinNonEmpty(string, list<string>): string',
    (separator, values) => values.map(clean).filter(Boolean).join(separator),
  )
  .registerFunction(
    'replaceText(string, string, string): string',
    (value, search, replacement) => value.replaceAll(search, replacement),
  )
  .registerFunction('regexExtract(string, string, int): string', regexExtract)
  .registerFunction('parseDate(string, string): string', parseDateTime)
  .registerFunction(
    'debitCredit(string, string, string): double',
    (debit, credit, format) => {
      const parse = (value: string) =>
        value.trim()
          ? parseDelimitedNumber(value, format as DelimitedNumberFormat)
          : 0
      const debitValue = parse(debit)
      const creditValue = parse(credit)
      if (
        debitValue === null ||
        creditValue === null ||
        debitValue < 0 ||
        creditValue < 0
      ) {
        throw new Error('Debit and credit must contain unsigned numbers')
      }
      if (debitValue !== 0 && creditValue !== 0)
        throw new Error('Both debit and credit contain amounts')
      if (debitValue === 0 && creditValue === 0)
        throw new Error('Neither debit nor credit contains an amount')
      return debitValue || -creditValue
    },
  )
  .registerFunction(
    'parseNumber(string, string): double',
    (value, format) =>
      parseDelimitedNumber(value, format as DelimitedNumberFormat) ??
      Number.NaN,
  )
  .registerFunction('extractCurrency(string): string', (value) => {
    const evidence = inspectDelimitedCurrency(value)
    if (evidence.ambiguous)
      throw new Error(
        'Choose an explicit currency for ambiguous or conflicting currency values',
      )
    if (evidence.code) return evidence.code
    const direct = resolveCurrencyCode(clean(value))
    if (direct) return direct
    const code = /(?<![A-Za-z])([A-Za-z]{3})(?![A-Za-z])/.exec(value)?.[1]
    // Only return verified currency codes. An arbitrary three-letter word
    // (e.g. in a notes-like column) must fall back to blank so the caller can
    // use the group currency instead of raising UNSUPPORTED_CURRENCY.
    return code ? (resolveCurrencyCode(code) ?? '') : ''
  })

function quote(value: string): string {
  return JSON.stringify(value)
}

function sourceExpression(source: DelimitedSourceValue) {
  const keys = [source.primary, ...source.fallbacks]
  const values = keys.map((key) => `row[${quote(key)}]`)
  if (values.length === 1) return values[0]!
  return `firstNonEmpty([${values.join(', ')}])`
}

function visualSourceExpressions(mapping: DelimitedVisualMapping) {
  return mapping.sourceValues.map(sourceExpression)
}

/** Compile a visual mapping into the same CEL language used by Advanced mode. */
export function compileDelimitedMapping(
  mapping: DelimitedFieldMapping,
): string {
  if (mapping.mode === 'CEL') return mapping.expression
  const sourceExpressions = visualSourceExpressions(mapping)
  let expression: string | undefined
  if (
    sourceExpressions.length === 1 &&
    !mapping.transforms.some((transform) => transform.kind === 'JOIN')
  ) {
    expression = sourceExpressions[0]
  }
  for (const transform of mapping.transforms) {
    if (transform.kind === 'JOIN') {
      if (expression !== undefined) {
        expression = `joinNonEmpty(${quote(transform.separator)}, [${expression}])`
      } else {
        expression = `joinNonEmpty(${quote(transform.separator)}, [${sourceExpressions.join(', ')}])`
      }
    } else if (expression === undefined) {
      throw new Error(
        'A Join transformation is required when combining source values',
      )
    } else if (transform.kind === 'TRIM') expression = `clean(${expression})`
    else if (transform.kind === 'UPPER') expression = `upperText(${expression})`
    else if (transform.kind === 'LOWER') expression = `lowerText(${expression})`
    else if (transform.kind === 'REPLACE') {
      expression = `replaceText(${expression}, ${quote(transform.search)}, ${quote(transform.replacement)})`
    } else if (transform.kind === 'REGEX_EXTRACT') {
      expression = `regexExtract(${expression}, ${quote(transform.pattern)}, ${transform.group})`
    } else if (transform.kind === 'PARSE_DATE') {
      expression = `parseDate(${expression}, ${quote(transform.format)})`
    } else if (transform.kind === 'PARSE_NUMBER') {
      expression = `parseNumber(${expression}, ${quote(transform.format)})`
    } else if (transform.kind === 'DEBIT_CREDIT') {
      expression = `debitCredit(row[${quote(transform.debitColumn)}], row[${quote(transform.creditColumn)}], ${quote(transform.format)})`
    } else if (transform.kind === 'EXTRACT_CURRENCY') {
      expression = `extractCurrency(${expression})`
    } else if (transform.kind === 'SIGN_FROM_COLUMN') {
      const values = transform.negativeValues.map((value) =>
        quote(clean(value).toLowerCase()),
      )
      expression = `(clean(row[${quote(transform.columnKey)}]) == "" ? ${expression} : (lowerText(clean(row[${quote(transform.columnKey)}])) in [${values.join(', ')}] ? -absolute(${expression}) : absolute(${expression})))`
    }
  }
  if (expression === undefined) {
    if (sourceExpressions.length > 1) {
      throw new Error(
        'A Join transformation is required when combining source values',
      )
    }
    expression = sourceExpressions[0]!
  }
  return expression
}

export function compileDelimitedMoneyMapping(mapping: DelimitedMoneyMapping): {
  amount: string
  currency: string
} {
  if (mapping.mode === 'CEL') {
    return {
      amount: `${mapping.expression}["amount"]`,
      currency: `${mapping.expression}["currency"]`,
    }
  }
  return {
    amount: compileDelimitedMapping(mapping.amount),
    currency: mapping.currency
      ? compileDelimitedMapping(mapping.currency)
      : '""',
  }
}
function rowContext(
  table: DelimitedTable,
  row: DelimitedRow,
): Record<string, string> {
  return Object.fromEntries(
    table.columns.map((column) => [column.key, row.cells[column.index] ?? '']),
  )
}

export function evaluateDelimitedMapping(
  mapping: DelimitedFieldMapping,
  row: Record<string, string>,
): unknown {
  return mappingEnvironment.evaluate(compileDelimitedMapping(mapping), { row })
}

export function evaluateDelimitedMoneyMapping(
  mapping: DelimitedMoneyMapping,
  row: Record<string, string>,
): { amount: unknown; currency: unknown } {
  const compiled = compileDelimitedMoneyMapping(mapping)
  return {
    amount: mappingEnvironment.evaluate(compiled.amount, { row }),
    currency: mappingEnvironment.evaluate(compiled.currency, { row }),
  }
}

/**
 * Validate the serialized mapping and its CEL compilation without evaluating a
 * row.
 */
export function validateDelimitedMapping(
  mapping: DelimitedFieldMapping,
): DelimitedFieldMapping {
  const parsed = delimitedFieldMappingSchema.parse(mapping)
  if (parsed.mode === 'VISUAL') assertVisualTransformOrder(parsed)
  mappingEnvironment.parse(compileDelimitedMapping(parsed))
  return parsed
}

/** Debit/credit replaces the source value; sign needs a parsed number first. */
function assertVisualTransformOrder(mapping: DelimitedVisualMapping) {
  const kinds = mapping.transforms.map((transform) => transform.kind)
  if (kinds.includes('DEBIT_CREDIT')) {
    const allowed =
      kinds.length === 1 ||
      (kinds.length === 2 &&
        kinds[0] === 'DEBIT_CREDIT' &&
        kinds[1] === 'SIGN_FROM_COLUMN')
    if (!allowed) {
      throw new Error(
        'Debit/credit conversion must be the only transformation; it replaces the source value.',
      )
    }
  }
  const signIndex = kinds.indexOf('SIGN_FROM_COLUMN')
  if (
    signIndex >= 0 &&
    !kinds
      .slice(0, signIndex)
      .some((kind) => kind === 'PARSE_NUMBER' || kind === 'DEBIT_CREDIT')
  ) {
    throw new Error(
      'Sign from column needs a parsed number: add a number step before it.',
    )
  }
}

/** Validate both coordinated CEL lanes of a Money mapping. */
export function validateDelimitedMoneyMapping(
  mapping: DelimitedMoneyMapping,
): DelimitedMoneyMapping {
  const parsed = delimitedMoneyMappingSchema.parse(mapping)
  if (parsed.mode === 'VISUAL') {
    assertVisualTransformOrder(parsed.amount)
    if (parsed.currency?.mode === 'VISUAL')
      assertVisualTransformOrder(parsed.currency)
  }
  const compiled = compileDelimitedMoneyMapping(parsed)
  mappingEnvironment.parse(compiled.amount)
  mappingEnvironment.parse(compiled.currency)
  return parsed
}

export const importCategorySourceKey = (value: string) =>
  value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    // Collapse whitespace/punctuation runs to a canonical `/` so `Food /
    // Drinks`, `food/drinks`, and `food drinks` share one key. Shared with
    // categoryBindings, so both sides stay consistent.
    .replace(/[\s\p{P}]+/gu, '/')
    .replace(/^\/+|\/+$/g, '')

function normalizedFingerprintCell(value: string): string {
  return clean(value).toLowerCase()
}

function encodePart(value: string): string {
  return `${value.length}:${value}`
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

function valueAsString(value: unknown): string {
  return typeof value === 'string' ? clean(value) : ''
}

function valueAsNumber(value: unknown): number | null {
  if (typeof value === 'bigint') return Number(value)
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function expenseTime(value: string): { date: string; minutes: number } | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  return {
    date: match[1]!,
    minutes: Number(match[2]) * 60 + Number(match[3]),
  }
}

type EvaluatedDelimitedRow = Omit<DelimitedPreviewRow, 'rowId'>
type PendingDelimitedRowIssue = Omit<DelimitedRowIssue, 'rowNumber'>
type CompiledDelimitedMapping = (context: Record<string, string>) => unknown
type CompiledDelimitedMoneyMapping = {
  amount: CompiledDelimitedMapping
  currency: CompiledDelimitedMapping
}
type CompiledMappings = Partial<
  Record<DelimitedRowIssue['field'], CompiledDelimitedMapping> & {
    money: CompiledDelimitedMoneyMapping
  }
>

function ambiguousDateValue(value: string): boolean {
  const match = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-]/.exec(value)
  if (!match) return false
  const first = Number(match[1])
  const second = Number(match[2])
  return first >= 1 && first <= 12 && second >= 1 && second <= 12
}

function rawVisualValue(
  mapping: DelimitedFieldMapping | undefined,
  context: Record<string, string>,
): string {
  if (!mapping || mapping.mode !== 'VISUAL') return ''
  const values = mapping.sourceValues.map(
    (source) =>
      [source.primary, ...source.fallbacks]
        .map((key) => context[key] ?? '')
        .map(clean)
        .find(Boolean) ?? '',
  )
  const join = mapping.transforms.find((transform) => transform.kind === 'JOIN')
  return values.filter(Boolean).join(join?.separator ?? ' ')
}

export function truncateDelimitedRaw(value: string, max = 40): string {
  // Bounded snippets of already-user-visible cell data. These flow into row
  // issues, which reach client state, duplicate-check payloads, and logs —
  // keep the cap small and never log full rows elsewhere.
  const cleaned = value.trim().replace(/\s+/g, ' ')
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned
}

function dateOrderRawValue(
  mapping: DelimitedFieldMapping,
  context: Record<string, string>,
): string {
  return rawVisualValue(mapping, context)
}

export function analyzeDelimitedDateOrder(
  table: DelimitedTable,
  mapping: DelimitedFieldMapping,
  preferredOrder: DelimitedDateOrder = 'MDY',
): DelimitedDateOrderAnalysis {
  if (mapping.mode === 'CEL') {
    return {
      status: 'EXPLICIT',
      order: preferredOrder,
      dmyRows: [],
      mdyRows: [],
      ambiguousRows: [],
    }
  }
  if (
    mapping.transforms.some(
      (transform) =>
        transform.kind === 'PARSE_DATE' &&
        transform.format !== 'AUTO_MDY' &&
        transform.format !== 'AUTO_DMY',
    )
  ) {
    const dateTransform = mapping.transforms.find(
      (transform) => transform.kind === 'PARSE_DATE',
    )
    const format =
      dateTransform?.kind === 'PARSE_DATE' ? dateTransform.format : ''
    const dayIndex = format.search(/D+/i)
    const monthIndex = format.search(/M+/i)
    return {
      status: 'EXPLICIT',
      order:
        dayIndex >= 0 && monthIndex >= 0
          ? dayIndex < monthIndex
            ? 'DMY'
            : 'MDY'
          : preferredOrder,
      dmyRows: [],
      mdyRows: [],
      ambiguousRows: [],
    }
  }
  const dmyRows: number[] = []
  const mdyRows: number[] = []
  const ambiguousRows: number[] = []
  let isoValueCount = 0
  let nonIsoValueCount = 0
  for (const row of table.rows) {
    const raw = dateOrderRawValue(mapping, rowContext(table, row))
    if (/^\s*\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[T ]|$)/.test(raw)) {
      if (isStrictIsoDateValue(raw.trim())) isoValueCount += 1
      continue
    }
    if (raw.trim()) nonIsoValueCount += 1
    const match = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-]/.exec(raw)
    if (!match) continue
    const first = Number(match[1])
    const second = Number(match[2])
    if (first > 12 && second <= 12 && isAutoDateValue(raw, 'DMY'))
      dmyRows.push(row.rowNumber)
    else if (second > 12 && first <= 12 && isAutoDateValue(raw, 'MDY'))
      mdyRows.push(row.rowNumber)
    else if (
      first >= 1 &&
      first <= 12 &&
      second >= 1 &&
      second <= 12 &&
      (isAutoDateValue(raw, 'DMY') || isAutoDateValue(raw, 'MDY'))
    )
      ambiguousRows.push(row.rowNumber)
  }
  if (dmyRows.length && mdyRows.length) {
    return {
      status: 'MIXED',
      order: preferredOrder,
      dmyRows,
      mdyRows,
      ambiguousRows,
    }
  }
  if (dmyRows.length)
    return { status: 'DECISIVE', order: 'DMY', dmyRows, mdyRows, ambiguousRows }
  if (mdyRows.length)
    return { status: 'DECISIVE', order: 'MDY', dmyRows, mdyRows, ambiguousRows }
  if (isoValueCount > 0 && nonIsoValueCount === 0) {
    return {
      status: 'EXPLICIT',
      order: preferredOrder,
      dmyRows,
      mdyRows,
      ambiguousRows,
    }
  }
  return {
    status: 'AMBIGUOUS',
    order: preferredOrder,
    dmyRows,
    mdyRows,
    ambiguousRows,
  }
}

function rowIssue(
  field: DelimitedRowIssue['field'],
  severity: DelimitedRowIssue['severity'],
  code: DelimitedRowIssue['code'],
  message: string,
  params: ImportMessageParams,
): PendingDelimitedRowIssue {
  return { field, severity, code, message, params }
}

// Row membership lookups run per evaluated row; cache Set views per analysis
// object so mixed-order files stay linear instead of quadratic.
const dateOrderSetCache = new WeakMap<
  DelimitedDateOrderAnalysis,
  { dmy: Set<number>; mdy: Set<number>; ambiguous: Set<number> }
>()
function dateOrderSets(analysis: DelimitedDateOrderAnalysis | undefined) {
  if (!analysis) return null
  const cached = dateOrderSetCache.get(analysis)
  if (cached) return cached
  const sets = {
    dmy: new Set(analysis.dmyRows),
    mdy: new Set(analysis.mdyRows),
    ambiguous: new Set(analysis.ambiguousRows),
  }
  dateOrderSetCache.set(analysis, sets)
  return sets
}

function evaluateMoneyMapping(
  mapping: DelimitedMoneyMapping,
  context: Record<string, string>,
  compiled?: CompiledDelimitedMoneyMapping,
): {
  amount: number | null
  currency: string
  amountError?: unknown
  currencyError?: unknown
} {
  if (!compiled) {
    try {
      const evaluated = evaluateDelimitedMoneyMapping(mapping, context)
      return {
        amount: valueAsNumber(evaluated.amount),
        currency: valueAsString(evaluated.currency),
      }
    } catch (error) {
      return { amount: null, currency: '', amountError: error }
    }
  }
  let amountValue: unknown
  let currencyValue: unknown
  let amountError: unknown
  let currencyError: unknown
  try {
    amountValue = compiled.amount(context)
  } catch (error) {
    amountError = error
  }
  try {
    currencyValue = compiled.currency(context)
  } catch (error) {
    currencyError = error
  }
  return {
    amount: valueAsNumber(amountValue),
    currency: valueAsString(currencyValue),
    ...(amountError ? { amountError } : {}),
    ...(currencyError ? { currencyError } : {}),
  }
}

function mappingFailedContext(
  table: DelimitedTable,
  fieldMapping: DelimitedFieldMapping | DelimitedVisualMapping | undefined,
  context: Record<string, string>,
  expressionForCel?: string,
): string {
  const labelFor = (key: string) =>
    table.columns.find((column) => column.key === key)?.label ?? key
  const describeKey = (key: string) => {
    const raw = context[key] ?? ''
    const received = raw.trim()
      ? `, received “${truncateDelimitedRaw(raw)}”`
      : ''
    return `column “${labelFor(key)}” (${key}${received})`
  }
  if (!fieldMapping) return ''
  if (fieldMapping.mode === 'VISUAL') {
    const keys = fieldMapping.sourceValues.flatMap((source) => [
      source.primary,
      ...source.fallbacks,
    ])
    const extraKeys =
      'transforms' in fieldMapping
        ? fieldMapping.transforms.flatMap((transform) =>
            transform.kind === 'DEBIT_CREDIT'
              ? [transform.debitColumn, transform.creditColumn]
              : transform.kind === 'SIGN_FROM_COLUMN'
                ? [transform.columnKey]
                : [],
          )
        : []
    const allKeys = [...keys, ...extraKeys].filter((key, index, list) =>
      key ? list.indexOf(key) === index : false,
    )
    if (allKeys.length === 0) return ''
    return ` for ${allKeys.map(describeKey).join(', ')}`
  }
  const expression = expressionForCel ?? fieldMapping.expression
  const keys = [...expression.matchAll(/row\["([^"]+)"\]/g)].map(
    (match) => match[1]!,
  )
  const unique = [...new Set(keys)]
  if (unique.length === 0) return ''
  return ` for ${unique.map(describeKey).join(', ')}`
}

/**
 * User-facing mapping failure text. Never include the raw engine
 * `error.message` frame (`No such key…>1|row["…"] ^`) or absolute paths; the
 * WHICH-column hint comes from structured fields via mappingFailedContext
 * detail (labels/keys plus truncated cell snippets), not from the message.
 */
function mappingFailedMessage(detail: string): string {
  return `Mapping failed${detail}`
}

function evaluateDelimitedRow(
  table: DelimitedTable,
  mapping: DelimitedExpenseMappingV1,
  row: DelimitedRow,
  options: { includeAmbiguousDateIssue?: boolean } = {},
  compiledMappings?: CompiledMappings,
  dateOrder?: DelimitedDateOrderAnalysis,
): EvaluatedDelimitedRow {
  const context = rowContext(table, row)
  const issues: PendingDelimitedRowIssue[] = []
  const evaluate = <T>(
    field: DelimitedRowIssue['field'],
    mapping: DelimitedFieldMapping | undefined,
    convert: (value: unknown) => T,
    fallback: T,
  ): T => {
    if (!mapping) return fallback
    try {
      const compiled = compiledMappings?.[field]
      return convert(
        compiled
          ? compiled(context)
          : evaluateDelimitedMapping(mapping, context),
      )
    } catch (error) {
      void error
      const detail = mappingFailedContext(table, mapping, context)
      issues.push(
        rowIssue(
          field,
          'error',
          'MAPPING_FAILED',
          mappingFailedMessage(detail),
          { detail },
        ),
      )
      return fallback
    }
  }

  // Inference leaves required fields pointing at UNMAPPED_COLUMN_KEY when no
  // source column fits. Evaluating those would throw `No such key` and leak
  // the placeholder into user errors — short-circuit to actionable
  // choose-a-source-column errors instead. Optional fields (notes, external
  // ids, …) legitimately stay unmapped and keep evaluating to ''.
  const dateTimeUnmapped = isUnmappedVisual(mapping.mappings.dateTime)
  const titleUnmapped = isUnmappedVisual(mapping.mappings.title)
  const amountUnmapped =
    mapping.mappings.money.mode === 'VISUAL' &&
    isUnmappedVisual(mapping.mappings.money.amount)
  const currencyUnmapped =
    mapping.mappings.money.mode === 'VISUAL' &&
    mapping.mappings.money.currency !== undefined &&
    isUnmappedVisual(mapping.mappings.money.currency)

  const dateTime = dateTimeUnmapped
    ? ''
    : evaluate('dateTime', mapping.mappings.dateTime, valueAsString, '')
  const rawDateTime = rawVisualValue(mapping.mappings.dateTime, context)
  const title = titleUnmapped
    ? ''
    : evaluate('title', mapping.mappings.title, valueAsString, '')
  const compiledMoney = compiledMappings?.money as
    | CompiledDelimitedMoneyMapping
    | undefined
  const money = evaluateMoneyMapping(
    mapping.mappings.money,
    context,
    compiledMoney,
  )
  if (money.amountError && !amountUnmapped) {
    const amountMapping =
      mapping.mappings.money.mode === 'VISUAL'
        ? mapping.mappings.money.amount
        : undefined
    const detail = mappingFailedContext(
      table,
      amountMapping,
      context,
      mapping.mappings.money.mode === 'CEL'
        ? mapping.mappings.money.expression
        : undefined,
    )
    issues.push(
      rowIssue(
        'amount',
        'error',
        'MAPPING_FAILED',
        mappingFailedMessage(detail),
        { detail },
      ),
    )
  }
  if (money.currencyError && !currencyUnmapped) {
    const currencyMapping =
      mapping.mappings.money.mode === 'VISUAL'
        ? (mapping.mappings.money.currency ?? undefined)
        : undefined
    const detail = mappingFailedContext(
      table,
      currencyMapping,
      context,
      mapping.mappings.money.mode === 'CEL'
        ? mapping.mappings.money.expression
        : undefined,
    )
    issues.push(
      rowIssue(
        'currency',
        'error',
        'MAPPING_FAILED',
        mappingFailedMessage(detail),
        { detail },
      ),
    )
  }
  // SIGN_FROM_COLUMN silently takes absolute() for unlisted values. When the
  // cell is non-empty and unlisted but the parsed magnitude was explicitly
  // negative, the sign was ignored: warn instead of quietly flipping the sign.
  if (mapping.mappings.money.mode === 'VISUAL') {
    const amountVisual = mapping.mappings.money.amount
    if (amountVisual.mode === 'VISUAL') {
      const signTransforms = amountVisual.transforms.filter(
        (transform) => transform.kind === 'SIGN_FROM_COLUMN',
      )
      for (const sign of signTransforms) {
        const rawSign = context[sign.columnKey] ?? ''
        if (!clean(rawSign)) continue
        const lowered = clean(rawSign).toLowerCase()
        const listed = sign.negativeValues
          .map((value) => clean(value).toLowerCase())
          .includes(lowered)
        if (listed) continue
        // A recognized positive value (e.g. `Expense` next to negative
        // `Income`) yields absolute() by design — warning would mislead.
        if (
          (sign.positiveValues ?? [])
            .map((value) => clean(value).toLowerCase())
            .includes(lowered)
        )
          continue
        let innerNegative = false
        try {
          const withoutSign: DelimitedVisualMapping = {
            ...amountVisual,
            transforms: amountVisual.transforms.filter(
              (transform) => transform.kind !== 'SIGN_FROM_COLUMN',
            ),
          }
          const inner = mappingEnvironment.evaluate(
            compileDelimitedMapping(withoutSign),
            { row: context },
          )
          const innerNumber = valueAsNumber(inner)
          innerNegative =
            innerNumber !== null
              ? innerNumber < 0
              : (parseDelimitedNumber(
                  rawVisualValue(withoutSign, context),
                  'AUTO',
                ) ?? 0) < 0
        } catch {
          innerNegative = false
        }
        if (innerNegative) {
          const label =
            table.columns.find((column) => column.key === sign.columnKey)
              ?.label ?? sign.columnKey
          issues.push(
            rowIssue(
              'amount',
              'warning',
              'SIGN_COLUMN_IGNORED',
              `Sign column “${label}” (${sign.columnKey}, received “${truncateDelimitedRaw(rawSign)}”) is not listed, so the negative amount was treated as positive`,
              {
                label,
                columnKey: sign.columnKey,
                received: truncateDelimitedRaw(rawSign),
              },
            ),
          )
          break
        }
      }
    }
  }
  const amountMajor = money.amount
  const currencyRaw = money.currency
  const categorySource = evaluate(
    'categorySource',
    mapping.mappings.categorySource,
    valueAsString,
    '',
  )
  const notes = evaluate('notes', mapping.mappings.notes, valueAsString, '')
  const externalId = evaluate(
    'externalId',
    mapping.mappings.externalId,
    valueAsString,
    '',
  )
  const sourceAccount = evaluate(
    'sourceAccount',
    mapping.mappings.sourceAccount,
    valueAsString,
    '',
  )

  const parsedDate = expenseTime(dateTime)
  const rawAmount =
    mapping.mappings.money.mode === 'VISUAL'
      ? rawVisualValue(mapping.mappings.money.amount, context)
      : ''
  const rawCurrency =
    mapping.mappings.money.mode === 'VISUAL' && mapping.mappings.money.currency
      ? rawVisualValue(mapping.mappings.money.currency, context)
      : ''
  const resolvedCurrency =
    resolveCurrencyCode(currencyRaw) ?? currencyRaw.toUpperCase()
  const currency =
    resolvedCurrency || mapping.defaults.currencyCode.toUpperCase()
  const amount =
    amountMajor === null || !currency
      ? 0
      : amountAsMinorUnitsByCode(amountMajor, currency)
  const categoryKey = importCategorySourceKey(categorySource)
  const boundCategory = categoryKey
    ? mapping.categoryBindings[categoryKey]
    : undefined
  const category =
    amount < 0
      ? INCOME_CATEGORY_ID
      : categoryKey
        ? (boundCategory ?? 'general')
        : mapping.defaults.categoryId
  const hasIssue = (field: DelimitedRowIssue['field']) =>
    issues.some(({ field: issueField }) => issueField === field)

  if (!parsedDate && !hasIssue('dateTime')) {
    if (dateTimeUnmapped) {
      issues.push(
        rowIssue(
          'dateTime',
          'error',
          'DATE_SOURCE_UNMAPPED',
          'Date could not be determined from the file; choose a source column in the mapping step',
          {},
        ),
      )
    } else {
      const receivedSuffix = rawDateTime.trim()
        ? ` (received “${truncateDelimitedRaw(rawDateTime)}”)`
        : ''
      issues.push(
        rowIssue(
          'dateTime',
          'error',
          'INVALID_DATE',
          `Date and time could not be parsed${receivedSuffix}`,
          { receivedSuffix },
        ),
      )
    }
  }
  if (title.length < 2 && !hasIssue('title')) {
    if (titleUnmapped) {
      issues.push(
        rowIssue(
          'title',
          'error',
          'TITLE_SOURCE_UNMAPPED',
          'Title could not be determined from the file; choose a source column in the mapping step',
          {},
        ),
      )
    } else {
      const receivedSuffix = title
        ? ` (received “${truncateDelimitedRaw(title)}”)`
        : ''
      issues.push(
        rowIssue(
          'title',
          'error',
          'MISSING_TITLE',
          `Title needs at least two characters${receivedSuffix}`,
          { receivedSuffix },
        ),
      )
    }
  }
  if ((amountMajor === null || amount === 0) && !hasIssue('amount')) {
    if (amountUnmapped) {
      issues.push(
        rowIssue(
          'amount',
          'error',
          'AMOUNT_SOURCE_UNMAPPED',
          'Amount could not be determined from the file; choose a source column in the mapping step',
          {},
        ),
      )
    } else {
      const receivedSuffix = rawAmount.trim()
        ? ` (received “${truncateDelimitedRaw(rawAmount)}”)`
        : ''
      issues.push(
        rowIssue(
          'amount',
          'error',
          'INVALID_AMOUNT',
          `Amount must be a non-zero number${receivedSuffix}`,
          { receivedSuffix },
        ),
      )
    }
  }
  if (
    (!currency || !getCurrency(currency)) &&
    !hasIssue('currency') &&
    // An unmapped amount already blocks the row; a jointly unmapped currency
    // would only add a redundant `blank is not supported` error.
    !(amountUnmapped && currencyUnmapped)
  ) {
    const receivedSuffix =
      rawCurrency.trim() && rawCurrency.trim() !== (currency || '')
        ? ` (received “${truncateDelimitedRaw(rawCurrency)}”)`
        : ''
    issues.push(
      rowIssue(
        'currency',
        'error',
        'UNSUPPORTED_CURRENCY',
        `Currency “${currency || 'blank'}” is not supported${receivedSuffix}`,
        { currency: currency || 'blank', receivedSuffix },
      ),
    )
  }
  if (
    options.includeAmbiguousDateIssue &&
    dateOrder?.status === 'AMBIGUOUS' &&
    ambiguousDateValue(rawDateTime) &&
    !hasIssue('dateTime')
  ) {
    issues.push(
      rowIssue(
        'dateTime',
        'warning',
        'AMBIGUOUS_DATE',
        'This date could be month/day or day/month',
        {},
      ),
    )
  }
  const orderSets = dateOrderSets(dateOrder)
  if (
    dateOrder?.status === 'MIXED' &&
    orderSets &&
    (orderSets.dmy.has(row.rowNumber) || orderSets.mdy.has(row.rowNumber))
  ) {
    const receivedSuffix = rawDateTime.trim()
      ? ` (received “${truncateDelimitedRaw(rawDateTime)}”)`
      : ''
    issues.push(
      rowIssue(
        'dateTime',
        'error',
        'INCONSISTENT_DATE_ORDER',
        `Date order conflicts with other rows (${dateOrder.dmyRows.length} day/month and ${dateOrder.mdyRows.length} month/day examples)${receivedSuffix}`,
        {
          dmyCount: dateOrder.dmyRows.length,
          mdyCount: dateOrder.mdyRows.length,
          receivedSuffix,
        },
      ),
    )
  } else if (
    dateOrder?.status === 'MIXED' &&
    orderSets?.ambiguous.has(row.rowNumber) &&
    !hasIssue('dateTime')
  ) {
    // Ambiguous rows in a mixed file silently follow the mapping order; flag
    // them so the least certain rows are not the quietest.
    issues.push(
      rowIssue(
        'dateTime',
        'warning',
        'AMBIGUOUS_DATE',
        'This date could be month/day or day/month',
        {},
      ),
    )
  }
  if (categoryKey && !boundCategory && amount >= 0) {
    issues.push(
      rowIssue(
        'category',
        'warning',
        'CATEGORY_FALLBACK',
        `Category “${categorySource}” will use General`,
        { source: categorySource },
      ),
    )
  }

  // Date-only values carry no wall-time evidence (no `:` or `T<digit>`);
  // default to noon like the unparsed fallback instead of midnight.
  // CEL mappings are exempt: their evaluated string is the author's explicit
  // value (midnight included), and there is no raw cell to consult — forcing
  // noon would make explicit midnight inexpressible.
  let expenseTimeMinutes = parsedDate?.minutes ?? 12 * 60
  if (parsedDate?.minutes === 0 && mapping.mappings.dateTime?.mode !== 'CEL') {
    const hasTime = /\d\s*:\s*\d/.test(rawDateTime) || /T\d/i.test(rawDateTime)
    if (!hasTime) expenseTimeMinutes = 12 * 60
  }

  return {
    rowNumber: row.rowNumber,
    title,
    expenseDate: parsedDate?.date ?? '',
    expenseTimeMinutes,
    amount,
    currency,
    category,
    categorySource: categorySource || null,
    notes: notes || null,
    externalId: externalId || null,
    sourceAccount: sourceAccount || null,
    issues: issues.map((issue) => ({ ...issue, rowNumber: row.rowNumber })),
    warning:
      issues.find(({ severity }) => severity === 'warning')?.message ?? null,
    error: issues.find(({ severity }) => severity === 'error')?.message ?? null,
  }
}

function assertColumnSignature(
  table: DelimitedTable,
  mapping: DelimitedExpenseMappingV1,
): void {
  const expected = mapping.parsing.columnSignature
  const actual = delimitedColumnSignature(table)
  if (
    expected.length !== actual.length ||
    expected.some((key, index) => key !== actual[index])
  ) {
    // Cap the key lists: wide files would otherwise inline hundreds of
    // (already user-visible, but noisy) 128-char keys into a thrown error.
    const describeKeys = (keys: string[]) =>
      keys.length > 5
        ? `[${keys.slice(0, 5).join(', ')}, …${keys.length - 5} more]`
        : `[${keys.join(', ')}]`
    throw new Error(
      `The file columns changed since this mapping was created (expected ${expected.length} columns ${describeKeys(expected)}, found ${actual.length} columns ${describeKeys(actual)}). Please re-select the mapping.`,
    )
  }
}

function assertPreviewVisualOrder(mapping: DelimitedExpenseMappingV1): void {
  for (const [field, fieldMapping] of Object.entries(mapping.mappings)) {
    if (!fieldMapping) continue
    if (field === 'money') {
      const money = fieldMapping as DelimitedMoneyMapping
      if (money.mode === 'VISUAL') {
        assertVisualTransformOrder(money.amount)
        if (money.currency?.mode === 'VISUAL')
          assertVisualTransformOrder(money.currency)
      }
      continue
    }
    const typed = fieldMapping as DelimitedFieldMapping
    if (typed.mode === 'VISUAL') assertVisualTransformOrder(typed)
  }
}

/** Evaluate every row for the live mapping preview without hashing raw data. */
export function previewDelimitedRows(
  table: DelimitedTable,
  mapping: DelimitedExpenseMappingV1,
  options: {
    includeAmbiguousDateIssue?: boolean
    preferredDateOrder?: DelimitedDateOrder
    categories?: ImportCategoryContext
  } = {},
): DelimitedPreviewRow[] {
  const parsedMapping = delimitedExpenseMappingSchema.parse(mapping)
  assertColumnSignature(table, parsedMapping)
  assertPreviewVisualOrder(parsedMapping)
  const dateOrder = analyzeDelimitedDateOrder(
    table,
    parsedMapping.mappings.dateTime,
    options.preferredDateOrder ?? 'MDY',
  )
  // When every date is ambiguous, the file carries no decisive evidence and
  // the caller's explicit preference disambiguates parsing. Only an explicit
  // option rewrites an AUTO mapping; an omitted option keeps today's
  // mapping-driven parsing byte-identical.
  if (
    options.preferredDateOrder !== undefined &&
    dateOrder.status === 'AMBIGUOUS' &&
    parsedMapping.mappings.dateTime.mode === 'VISUAL'
  ) {
    const dateVisual = parsedMapping.mappings.dateTime
    const autoIndex = dateVisual.transforms.findIndex(
      (transform) =>
        transform.kind === 'PARSE_DATE' &&
        (transform.format === 'AUTO_MDY' || transform.format === 'AUTO_DMY'),
    )
    if (autoIndex >= 0) {
      const wanted = dateOrder.order === 'DMY' ? 'AUTO_DMY' : 'AUTO_MDY'
      const current = dateVisual.transforms[autoIndex]
      if (current?.kind === 'PARSE_DATE' && current.format !== wanted) {
        dateVisual.transforms[autoIndex] = {
          kind: 'PARSE_DATE',
          format: wanted,
        }
      }
    }
  }
  const compiledMappings = Object.fromEntries(
    Object.entries(parsedMapping.mappings).map(([field, mapping]) => {
      if (!mapping) return [field, undefined]
      if (field === 'money') {
        try {
          const compiled = compileDelimitedMoneyMapping(
            mapping as DelimitedMoneyMapping,
          )
          const amount = mappingEnvironment.parse(compiled.amount)
          const currency = mappingEnvironment.parse(compiled.currency)
          return [
            field,
            {
              amount: (context: Record<string, string>) =>
                amount({ row: context }),
              currency: (context: Record<string, string>) =>
                currency({ row: context }),
            },
          ]
        } catch (error) {
          return [
            field,
            {
              amount: () => {
                throw error
              },
              currency: () => {
                throw error
              },
            },
          ]
        }
      }
      try {
        const parsed = mappingEnvironment.parse(
          compileDelimitedMapping(mapping as DelimitedFieldMapping),
        )
        return [
          field,
          (context: Record<string, string>) => parsed({ row: context }),
        ]
      } catch (error) {
        // Preserve row-level issue attribution for invalid advanced mappings.
        return [
          field,
          () => {
            throw error
          },
        ]
      }
    }),
  ) as CompiledMappings
  const rows = table.rows.map((row) => ({
    rowId: `preview-${row.rowNumber}`,
    ...evaluateDelimitedRow(
      table,
      parsedMapping,
      row,
      options,
      compiledMappings,
      dateOrder,
    ),
  }))
  return options.categories
    ? resolveImportCategories(rows, parsedMapping, options.categories)
    : rows
}

/** Apply a confirmed mapping and produce hash-only source identities. */
export async function mapDelimitedRows(
  table: DelimitedTable,
  mapping: DelimitedExpenseMappingV1,
  categories?: ImportCategoryContext,
  options: { preferredDateOrder?: DelimitedDateOrder } = {},
): Promise<DelimitedMappedRow[]> {
  const parsedMapping = delimitedExpenseMappingSchema.parse(mapping)
  assertColumnSignature(table, parsedMapping)
  const evaluated = previewDelimitedRows(table, parsedMapping, {
    includeAmbiguousDateIssue: false,
    // Default MDY via preview when omitted (today's behavior, byte-identical);
    // an explicit option also disambiguates AUTO parsing for all-ambiguous files.
    ...(options.preferredDateOrder
      ? { preferredDateOrder: options.preferredDateOrder }
      : {}),
    categories,
  })
  const signature = delimitedColumnSignature(table).join('|')
  const occurrences = new Map<string, number>()
  const rows: DelimitedMappedRow[] = []

  const baseFingerprints = await Promise.all(
    evaluated.map(async (mapped, index) => {
      const row = table.rows[index]!
      const rawBaseMaterial = mapped.externalId
        ? [
            'external-id',
            signature,
            mapped.sourceAccount ?? '',
            mapped.externalId,
          ]
        : ['raw-row', signature, ...row.cells.map(normalizedFingerprintCell)]
      return sha256Hex(
        ['expense-file-import', '2', ...rawBaseMaterial]
          .map(encodePart)
          .join('|'),
      )
    }),
  )
  const resolvedOrigins = await Promise.all(
    baseFingerprints.map((baseFingerprint) => {
      const occurrence = (occurrences.get(baseFingerprint) ?? 0) + 1
      occurrences.set(baseFingerprint, occurrence)
      return sha256Hex(`${baseFingerprint}|occurrence:${occurrence}`)
    }),
  )

  for (const [index, mapped] of evaluated.entries()) {
    const row = table.rows[index]!
    const baseFingerprint = baseFingerprints[index]!
    const originFingerprint = resolvedOrigins[index]!
    rows.push({
      ...mapped,
      rowId: `${row.rowNumber}-${originFingerprint.slice(0, 12)}`,
      source: { baseFingerprint, originFingerprint },
    })
  }
  return rows
}

export function portableDelimitedMapping(
  mapping: DelimitedExpenseMappingV1,
): DelimitedExpenseMappingV1 {
  const parsed = delimitedExpenseMappingSchema.parse(mapping)
  const { groupBindings: _groupBindings, ...portable } = parsed
  return portable
}

export function parseDelimitedMappingJson(
  input: string,
): DelimitedExpenseMappingV1 {
  let value: unknown
  try {
    value = JSON.parse(input)
  } catch {
    throw new Error('The mapping file is not valid JSON')
  }
  if (
    value &&
    typeof value === 'object' &&
    'kind' in value &&
    value.kind !== DELIMITED_MAPPING_KIND
  ) {
    throw new Error(`Mapping type ${String(value.kind)} is not supported`)
  }
  if (
    value &&
    typeof value === 'object' &&
    'version' in value &&
    value.version !== DELIMITED_MAPPING_VERSION
  ) {
    throw new Error(`Mapping version ${String(value.version)} is not supported`)
  }
  const parsed = delimitedExpenseMappingSchema.safeParse(value)
  if (!parsed.success) throw new Error('The mapping file has an invalid shape')
  return parsed.data
}

/** Shared adapter contract for typed delimited-field mappings. */
export type DelimitedMapperAdapter<TMapping, TValue> = {
  kind: 'TEXT' | 'DATE_TIME' | 'MONEY'
  schema: z.ZodType<TMapping>
  infer: (mapping: TMapping) => TMapping
  classify: (mapping: TMapping) => DelimitedMappingMode
  simplify: (mapping: TMapping) => TMapping
  compile: (mapping: TMapping) => unknown
  evaluate: (mapping: TMapping, row: Record<string, string>) => TValue
  validate: (value: TValue) => string | null
  summarize: (mapping: TMapping, table: DelimitedTable) => string
}

export type DelimitedMappingMode = 'SIMPLE' | 'ADVANCED' | 'CODE'

/**
 * Batch-safe payer and beneficiary defaults used by expense-file imports.
 * Shares are copied to each generated expense; fixed-amount and itemized
 * distributions intentionally are not representable here because imported rows
 * have different amounts.
 */
export type ExpenseImportBatchDefaults = {
  paidBy:
    | {
        mode: 'SINGLE'
        participantId: string
      }
    | {
        mode: 'EVENLY' | 'BY_SHARES' | 'BY_PERCENTAGE'
        shares: Array<{ participant: string; shares: number }>
      }
  paidFor: {
    mode: 'EVENLY' | 'BY_SHARES' | 'BY_PERCENTAGE'
    shares: Array<{ participant: string; shares: number }>
  }
}

type SimpleFieldKind = 'text' | 'dateTime' | 'amount' | 'currency'

function simpleTransformKinds(kind: SimpleFieldKind) {
  switch (kind) {
    case 'text':
      return new Set<DelimitedVisualTransform['kind']>(['TRIM'])
    case 'dateTime':
      return new Set<DelimitedVisualTransform['kind']>(['TRIM', 'PARSE_DATE'])
    case 'amount':
      return new Set<DelimitedVisualTransform['kind']>([
        'TRIM',
        'PARSE_NUMBER',
        'SIGN_FROM_COLUMN',
      ])
    case 'currency':
      return new Set<DelimitedVisualTransform['kind']>([
        'TRIM',
        'EXTRACT_CURRENCY',
      ])
  }
}

function isSimpleVisualMapping(
  mapping: DelimitedVisualMapping,
  kind: SimpleFieldKind,
) {
  if (
    mapping.sourceValues.length !== 1 ||
    mapping.sourceValues[0]?.fallbacks.length
  )
    return false
  const allowed = simpleTransformKinds(kind)
  return mapping.transforms.every((transform) => allowed.has(transform.kind))
}

export function classifyDelimitedFieldMapping(
  mapping: DelimitedFieldMapping,
  kind: SimpleFieldKind,
): DelimitedMappingMode {
  if (mapping.mode === 'CEL') return 'CODE'
  return isSimpleVisualMapping(mapping, kind) ? 'SIMPLE' : 'ADVANCED'
}

export function classifyDelimitedMoneyMapping(
  mapping: DelimitedMoneyMapping,
): DelimitedMappingMode {
  if (mapping.mode === 'CEL') return 'CODE'
  return isSimpleVisualMapping(mapping.amount, 'amount') &&
    (!mapping.currency || isSimpleVisualMapping(mapping.currency, 'currency'))
    ? 'SIMPLE'
    : 'ADVANCED'
}

function simplifyVisualMapping(
  mapping: DelimitedVisualMapping,
  kind: SimpleFieldKind,
): DelimitedVisualMapping {
  const allowed = simpleTransformKinds(kind)
  const transforms = mapping.transforms.filter((transform) =>
    allowed.has(transform.kind),
  )
  const order: DelimitedVisualTransform['kind'][] =
    kind === 'dateTime'
      ? ['TRIM', 'PARSE_DATE']
      : kind === 'amount'
        ? ['TRIM', 'PARSE_NUMBER', 'SIGN_FROM_COLUMN']
        : kind === 'currency'
          ? ['TRIM', 'EXTRACT_CURRENCY']
          : ['TRIM']
  transforms.sort(
    (left, right) => order.indexOf(left.kind) - order.indexOf(right.kind),
  )
  return {
    mode: 'VISUAL',
    sourceValues: [
      {
        primary: mapping.sourceValues[0]?.primary ?? '',
        fallbacks: [],
      },
    ],
    transforms,
  }
}

export function simplifyDelimitedFieldMapping(
  mapping: DelimitedFieldMapping,
  kind: SimpleFieldKind,
): DelimitedFieldMapping {
  if (mapping.mode === 'CEL') return mapping
  return simplifyVisualMapping(mapping, kind)
}

export function simplifyDelimitedMoneyMapping(
  mapping: DelimitedMoneyMapping,
): DelimitedMoneyMapping {
  if (mapping.mode === 'CEL') return mapping
  // A paired debit/credit amount cannot be expressed with the simple
  // transforms; dropping DEBIT_CREDIT would silently read the wrong column.
  if (
    mapping.amount.mode === 'VISUAL' &&
    mapping.amount.transforms.some(
      (transform) => transform.kind === 'DEBIT_CREDIT',
    )
  )
    return mapping
  return {
    mode: 'VISUAL',
    amount: simplifyVisualMapping(mapping.amount, 'amount'),
    currency: mapping.currency
      ? simplifyVisualMapping(mapping.currency, 'currency')
      : undefined,
  }
}

function dateFormatLabel(format: string): string {
  if (format === 'AUTO_MDY') return 'M/D/YYYY H:mm (month/day)'
  if (format === 'AUTO_DMY') return 'D/M/YYYY H:mm (day/month)'
  return format
}

/**
 * Label an AUTO date format by the order preview and MAP actually parse with:
 * the mapping's AUTO default, except that an explicitly passed locale
 * preference rewrites AUTO for AMBIGUOUS files (see previewDelimitedRows /
 * mapDelimitedRows) — so only that combination follows the preference. Decisive
 * vote winners never drive parsing (a DECISIVE file under a disagreeing AUTO
 * default parses as the default, or INVALID), so the label must not follow the
 * votes. Summaries without a caller preference keep the AUTO default.
 */
export function resolvedAutoDateFormatLabel(
  format: string,
  dateMapping: DelimitedFieldMapping,
  table: DelimitedTable,
  preferredDateOrder?: DelimitedDateOrder,
): string {
  if (format !== 'AUTO_MDY' && format !== 'AUTO_DMY')
    return dateFormatLabel(format)
  try {
    const analysis = analyzeDelimitedDateOrder(
      table,
      dateMapping,
      preferredDateOrder ?? 'MDY',
    )
    if (analysis.status === 'AMBIGUOUS' && preferredDateOrder !== undefined) {
      return dateFormatLabel(analysis.order === 'DMY' ? 'AUTO_DMY' : 'AUTO_MDY')
    }
  } catch {
    // Labeling is best-effort; preview and MAP surface real failures.
  }
  return dateFormatLabel(format)
}
