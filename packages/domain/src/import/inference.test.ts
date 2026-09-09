import { describe, expect, it } from 'vitest'

import { createImportTitleIndex } from './category-resolution'
import {
  parseDelimitedText,
  previewDelimitedRows,
  mapDelimitedRows,
  compileDelimitedMapping,
  type DelimitedTable,
} from './generic-csv'
import {
  inferDelimitedExpenseMapping,
  inferNumberFormat,
  remainingMoneyDetections,
} from './inference'

function parse(csv: string): DelimitedTable {
  const result = parseDelimitedText(csv)
  if (!result.ok) throw new Error(result.error)
  return result.table
}
const sample = (rows: string) =>
  parse(`Date,Description,Amount,Category\n${rows}`)

describe('content-aware import inference', () => {
  it('preserves a signed refund when the discriminator is blank', () => {
    const table = parse(
      'Date,Description,Amount,Type\n2022-03-14,Income,50,Income\n2022-03-15,Refund,-20,',
    )
    const { mapping } = inferDelimitedExpenseMapping(table, 'USD')
    expect(
      previewDelimitedRows(table, mapping).map((row) => row.amount),
    ).toEqual([-5000, -2000])
  })
  it('keeps descriptions containing numbers as title candidates', () => {
    const table = sample('2022-03-14,Shop 123,50,\n2022-03-15,Merchant 456,20,')
    const rows = previewDelimitedRows(
      table,
      inferDelimitedExpenseMapping(table, 'USD').mapping,
    )
    expect(rows.map((row) => row.title)).toEqual(['Shop 123', 'Merchant 456'])
    expect(rows.every((row) => !row.error)).toBe(true)
  })
  it('extracts unambiguous symbols and blocks unresolved or conflicting currency evidence', () => {
    for (const input of ['€50', '50 EUR']) {
      const table = sample(`2022-03-14,Cafe,${input},`)
      expect(
        previewDelimitedRows(
          table,
          inferDelimitedExpenseMapping(table, 'USD').mapping,
        )[0]?.currency,
      ).toBe('EUR')
    }
    for (const input of ['$50', '50 EUR USD']) {
      const table = sample(`2022-03-14,Cafe,${input},`)
      const { mapping, detections } = inferDelimitedExpenseMapping(table, 'USD')
      expect(
        detections.some(
          (entry) => entry.reason === 'CURRENCY' && entry.requiresConfirmation,
        ),
      ).toBe(true)
      expect(
        previewDelimitedRows(table, mapping)[0]?.issues.some(
          (issue) => issue.field === 'currency' && issue.severity === 'error',
        ),
      ).toBe(true)
      expect(
        remainingMoneyDetections(
          detections,
          mapping.mappings.money,
          table,
        ).some((entry) => entry.reason === 'CURRENCY'),
      ).toBe(true)
      if (mapping.mappings.money.mode !== 'VISUAL')
        throw Error('Expected visual')
      mapping.mappings.money.currency = undefined
      expect(
        remainingMoneyDetections(
          detections,
          mapping.mappings.money,
          table,
        ).filter((entry) => entry.field === 'money'),
      ).toEqual([])
    }
  })
  it('does not dismiss ambiguous numbers until the decimal format is chosen', () => {
    const table = sample('2022-03-14,Cafe,"1,234",')
    const { mapping, detections } = inferDelimitedExpenseMapping(table, 'USD')
    expect(
      remainingMoneyDetections(detections, mapping.mappings.money, table).some(
        (entry) => entry.reason === 'NUMBER_FORMAT',
      ),
    ).toBe(true)
    if (mapping.mappings.money.mode !== 'VISUAL') throw Error('Expected visual')
    mapping.mappings.money.amount.transforms = [
      { kind: 'PARSE_NUMBER', format: 'COMMA' },
    ]
    expect(
      remainingMoneyDetections(
        detections,
        mapping.mappings.money,
        table,
      ).filter((entry) => entry.field === 'money'),
    ).toEqual([])
    expect(previewDelimitedRows(table, mapping)[0]?.amount).toBe(123)
  })
  it('detects Debit/Credit pairs with an entirely empty lane', () => {
    for (const [debit, credit, expected] of [
      ['', '100', -10000],
      ['100', '', 10000],
    ] as const) {
      const table = parse(
        `Date,Description,Debit,Credit\n2022-03-14,Payment,${debit},${credit}`,
      )
      expect(
        previewDelimitedRows(
          table,
          inferDelimitedExpenseMapping(table, 'USD').mapping,
        )[0]?.amount,
      ).toBe(expected)
    }
  })
  it('prefers populated duplicate headers, ignores balances and finds complementary title fallbacks', () => {
    const table = parse(
      'Date,Note,Note,Merchant,Amount,Balance\n3/14/2022,,Dinner,,50,9000\n3/15/2022,,,Cafe,20,8980',
    )
    const { mapping } = inferDelimitedExpenseMapping(table, 'USD')
    const rows = previewDelimitedRows(table, mapping)
    expect(rows.map((row) => row.title)).toEqual(['Dinner', 'Cafe'])
    expect(rows.map((row) => row.amount)).toEqual([5000, 2000])
  })
  it('requires a source choice rather than mapping an account number as an amount', () => {
    const { mapping, detections } = inferDelimitedExpenseMapping(
      parse('Date,Description,Account\n2022-03-14,Cafe,12345'),
      'USD',
    )
    expect(
      detections.find((entry) => entry.field === 'money')?.requiresConfirmation,
    ).toBe(true)
    expect(
      previewDelimitedRows(
        parse('Date,Description,Account\n2022-03-14,Cafe,12345'),
        mapping,
      )[0]?.error,
    ).toBeTruthy()
  })
  it('uses decisive DMY dates and number formats while reporting ambiguous formats', () => {
    const { mapping } = inferDelimitedExpenseMapping(
      sample('14/3/2022,Cafe,50,\n3/2/2022,Shop,20,'),
      'USD',
    )
    expect(
      previewDelimitedRows(
        sample('14/3/2022,Cafe,50,\n3/2/2022,Shop,20,'),
        mapping,
      )[1]?.expenseDate,
    ).toBe('2022-02-03')
    expect(inferNumberFormat(['1.234,56', '20,50'])).toEqual({
      format: 'COMMA',
      ambiguous: false,
    })
    expect(inferNumberFormat(['1,234', '2,456']).ambiguous).toBe(true)
    expect(inferNumberFormat(['12.50', '12,50']).ambiguous).toBe(true)
  })
  it('preserves signed amounts unless discriminator values are understood', () => {
    const table = parse(
      'Date,Description,Amount,Type\n2022-03-14,Salary,-50,ACH',
    )
    expect(
      previewDelimitedRows(
        table,
        inferDelimitedExpenseMapping(table, 'USD').mapping,
      )[0]?.amount,
    ).toBe(-5000)
  })
  it('compiles editable debit/credit mappings and attributes invalid pairs to money', () => {
    const table = parse(
      'Date,Description,Debit,Credit\n2022-03-14,Cafe,50,0\n2022-03-15,Salary,,100\n2022-03-16,Both,5,6\n2022-03-17,Neither,0,\n2022-03-18,Signed,-1,',
    )
    const { mapping } = inferDelimitedExpenseMapping(table, 'USD')
    const rows = previewDelimitedRows(table, mapping)
    expect(rows.slice(0, 2).map((row) => row.amount)).toEqual([5000, -10000])
    expect(rows[1]?.category).toBe('income')
    for (const row of rows.slice(2))
      expect(
        row.issues.some(
          (issue) => issue.field === 'amount' && issue.severity === 'error',
        ),
      ).toBe(true)
    if (mapping.mappings.money.mode !== 'VISUAL')
      throw new Error('Expected visual mapping')
    expect(compileDelimitedMapping(mapping.mappings.money.amount)).toContain(
      'debitCredit(',
    )
  })
})

describe('local import categories', () => {
  it('learns the reviewed title instead of teaching its category to the original title', () => {
    const table = sample(
      '2022-03-14,Original merchant,50,\n2022-03-15,Original merchant,20,\n2022-03-16,Edited merchant,30,',
    )
    const { mapping } = inferDelimitedExpenseMapping(table, 'USD')
    const rows = previewDelimitedRows(table, mapping, {
      categories: {
        explicitRows: { 2: 'groceries' },
        reviewedRows: { 2: { title: 'Edited merchant', amount: 5000 } },
      },
    })
    expect(rows.map((row) => row.category)).toEqual([
      'groceries',
      'general',
      'groceries',
    ])
    expect(rows[0]?.title).toBe('Edited merchant')
  })
  it('matches source labels, ignores bad labels per source, and preserves explicit General', () => {
    const table = sample(
      '2022-03-14,Uber,50,Groceris\n2022-03-15,Uber,20,Bad data',
    )
    const { mapping } = inferDelimitedExpenseMapping(table, 'USD')
    let rows = previewDelimitedRows(table, mapping, {
      categories: { ignoredSources: ['bad data'] },
    })
    expect(rows[0]?.category).toBe('groceries')
    expect(rows[1]?.category).toBe('groceries') // Trusted same-title source evidence.
    mapping.categoryBindings['groceris'] = 'general'
    rows = previewDelimitedRows(table, mapping, {
      categories: { ignoredSources: ['bad data'] },
    })
    expect(rows[0]?.category).toBe('general')
    expect(rows[0]?.warning).toBeNull()
    expect(rows[1]?.category).toBe('taxi')
  })
  it('keeps title guesses per row and respects disabled suggestions and fallback', () => {
    const table = sample(
      '2022-03-14,Uber,50,Other\n2022-03-15,Unknown xyz,20,Other',
    )
    const { mapping } = inferDelimitedExpenseMapping(table, 'USD')
    mapping.defaults.categoryId = 'groceries'
    const options = { ignoredSources: ['other'] }
    const rows = previewDelimitedRows(table, mapping, { categories: options })
    expect(rows.map((row) => row.category)).toEqual(['taxi', 'groceries'])
    expect(mapping.categoryBindings).toEqual({})
    expect(
      previewDelimitedRows(table, mapping, {
        categories: { ...options, suggestUnmatched: false },
      }).map((row) => row.category),
    ).toEqual(['groceries', 'groceries'])
  })
  it('uses history and explicit import choices without recursively learning guesses', async () => {
    const table = sample(
      '2022-03-14,Zorb market,50,\n2022-03-15,Zorb market,20,\n2022-03-16,Zorb markat,10,',
    )
    const { mapping } = inferDelimitedExpenseMapping(table, 'USD')
    const categories = { explicitRows: { 2: 'groceries' as const } }
    const rows = previewDelimitedRows(table, mapping, { categories })
    expect(rows.map((row) => row.category)).toEqual([
      'groceries',
      'groceries',
      'general',
    ])
    const mapped = await mapDelimitedRows(table, mapping, categories)
    expect(mapped.map((row) => [row.title, row.amount, row.category])).toEqual(
      rows.map((row) => [row.title, row.amount, row.category]),
    )
    const historyRows = previewDelimitedRows(table, mapping, {
      categories: {
        history: [
          { title: 'Zorb market', categoryId: 'groceries' },
          { title: 'Zorb market', categoryId: 'groceries' },
        ],
      },
    })
    expect(historyRows[2]?.category).toBe('groceries')
  })
  it('produces identical categories in preview and final mapping', async () => {
    const table = sample(
      '2022-03-14,Uber ride,50,Other\n2022-03-15,Unknown xyz,20,Other\n2022-03-16,Salary,-40,',
    )
    const { mapping } = inferDelimitedExpenseMapping(table, 'USD')
    mapping.defaults.categoryId = 'groceries'
    const categories = {
      ignoredSources: ['other'],
      suggestUnmatched: true,
      history: [{ title: 'Uber ride', categoryId: 'groceries' as const }],
    }
    const preview = previewDelimitedRows(table, mapping, { categories })
    const mapped = await mapDelimitedRows(table, mapping, categories)
    expect(mapped.map((row) => [row.title, row.amount, row.category])).toEqual(
      preview.map((row) => [row.title, row.amount, row.category]),
    )
    // Disabled suggestions still match between preview and final mapping.
    const off = { ...categories, suggestUnmatched: false }
    expect(
      (await mapDelimitedRows(table, mapping, off)).map((row) => row.category),
    ).toEqual(
      previewDelimitedRows(table, mapping, { categories: off }).map(
        (row) => row.category,
      ),
    )
  })
  it('does not propagate conflicting imported choices or infer accounting categories', () => {
    const table = sample(
      '2022-03-14,Zorb,50,\n2022-03-15,Zorb,20,\n2022-03-16,Zorb,10,\n2022-03-17,Salary,-40,',
    )
    const { mapping } = inferDelimitedExpenseMapping(table, 'USD')
    const rows = previewDelimitedRows(table, mapping, {
      categories: {
        explicitRows: { 2: 'groceries', 3: 'taxi' },
        history: [{ title: 'Zorb', categoryId: 'income' }],
      },
    })
    expect(rows[2]?.category).toBe('general')
    expect(rows[3]?.category).toBe('income')
  })
  it('separates exact and fuzzy title candidates without changing meaningful digits', () => {
    const match = createImportTitleIndex(
      ['Zorb 12', 'Zorb 13', 'Zarb 12', 'ZORB 12'],
      (value) => value,
    )('Zorb 12')
    expect(match.exact).toEqual(['Zorb 12', 'ZORB 12'])
    expect(match.fuzzy).toEqual(['Zarb 12'])
  })
  it('evaluates ten thousand rows with repeated and unique titles', () => {
    const table = sample(
      Array.from(
        { length: 10000 },
        (_, index) =>
          `2022-03-14,${index % 2 ? 'Uber' : `Merchant ${index}`},10,`,
      ).join('\n'),
    )
    const { mapping } = inferDelimitedExpenseMapping(table, 'USD')
    const rows = previewDelimitedRows(table, mapping, {
      categories: {
        history: Array.from({ length: 200 }, (_, index) => ({
          title: `Merchant ${index}`,
          categoryId: 'groceries',
        })),
      },
    })
    expect(rows).toHaveLength(10000)
    expect(rows[9999]?.category).toBe('taxi')
  }, 15000)
  it('infers a lone Credit column as the amount source', () => {
    const table = parse(
      'Date,Description,Credit\n2022-03-14,Refund A,100\n2022-03-15,Refund B,200',
    )
    const { mapping, detections } = inferDelimitedExpenseMapping(table, 'USD')
    expect(
      detections.find((entry) => entry.field === 'money')?.requiresConfirmation,
    ).toBe(false)
    expect(
      previewDelimitedRows(table, mapping).map((row) => row.amount),
    ).toEqual([10000, 20000])
  })
  it('lets a manual override beat the negative-amount income rule', async () => {
    const table = sample('2022-03-14,Refund,-50,\n2022-03-15,Salary,-40,')
    const { mapping } = inferDelimitedExpenseMapping(table, 'USD')
    const rows = previewDelimitedRows(table, mapping, {
      categories: { explicitRows: { 2: 'groceries' } },
    })
    expect(rows[0]?.category).toBe('groceries')
    expect(rows[0]?.categoryProvenance).toBe('manual')
    expect(rows[1]?.category).toBe('income')
    const mapped = await mapDelimitedRows(table, mapping, {
      explicitRows: { 2: 'groceries' },
    })
    expect(mapped[0]?.category).toBe('groceries')
  })
})

describe('csv import follow-ups', () => {
  it('ignores mixed-case bad labels per normalized source', () => {
    const table = sample(
      '2022-03-14,Uber,50,Bad Data\n2022-03-15,Uber,20,bad data',
    )
    const { mapping } = inferDelimitedExpenseMapping(table, 'USD')
    const rows = previewDelimitedRows(table, mapping, {
      categories: { ignoredSources: ['Bad Data'] },
    })
    expect(rows.map((row) => row.category)).toEqual(['taxi', 'taxi'])
  })
  it('infers a lone Debit column as the amount source', () => {
    const table = parse(
      'Date,Description,Debit\n2022-03-14,Payment A,100\n2022-03-15,Payment B,200',
    )
    const { mapping, detections } = inferDelimitedExpenseMapping(table, 'USD')
    expect(
      detections.find((entry) => entry.field === 'money')?.requiresConfirmation,
    ).toBe(false)
    expect(
      previewDelimitedRows(table, mapping).map((row) => row.amount),
    ).toEqual([10000, 20000])
  })
  it('marks paired Debit/Credit lanes as confirmed', () => {
    const table = parse(
      'Date,Description,Debit,Credit\n2022-03-14,Payment,100,\n2022-03-15,Refund,,50',
    )
    const { mapping, detections } = inferDelimitedExpenseMapping(table, 'USD')
    const money = detections.find((entry) => entry.field === 'money')
    expect(money?.requiresConfirmation).toBe(false)
    expect(money?.candidates).toEqual(
      expect.arrayContaining([expect.stringMatching(/debit/i)]),
    )
    expect(
      previewDelimitedRows(table, mapping).map((row) => row.amount),
    ).toEqual([10000, -5000])
  })
  it('commits identical preview and final categories with stripped portable bindings', async () => {
    const table = sample('2022-03-14,Uber ride,50,Other')
    const { mapping } = inferDelimitedExpenseMapping(table, 'USD')
    const preview = previewDelimitedRows(table, mapping, {
      categories: { ignoredSources: ['other'] },
    })
    const mapped = await mapDelimitedRows(table, mapping, {
      ignoredSources: ['other'],
    })
    expect(mapped.map((row) => row.category)).toEqual(
      preview.map((row) => row.category),
    )
  })
  it('penalizes quantity columns so the price column wins the amount', () => {
    const table = parse(
      'Date,Description,Quantity,Price\n2022-03-14,Meal,2,50\n2022-03-15,Snack,1,20',
    )
    const { mapping } = inferDelimitedExpenseMapping(table, 'USD', 'MDY')
    const money = mapping.mappings.money
    expect(money.mode).toBe('VISUAL')
    // A blind accept must import prices (5000/2000c), never counts (200/100c).
    expect(
      money.mode === 'VISUAL'
        ? money.amount.sourceValues[0]?.primary
        : undefined,
    ).toBe('price#1')
  })
  it('refuses to claim the same column as both date and title', () => {
    const table = parse('Info,Amount\nMeeting 3/2/2022,50\nLunch 4/2/2022,20')
    const { mapping, detections } = inferDelimitedExpenseMapping(
      table,
      'USD',
      'MDY',
    )
    const dateTime = mapping.mappings.dateTime
    const title = mapping.mappings.title
    // The date column also reads as prose, so its confident pick is suspect
    // (its values can never strictly parse as dates) — force confirmation…
    expect(
      detections.find((entry) => entry.field === 'dateTime')
        ?.requiresConfirmation,
    ).toBe(true)
    // …and the title must not double-claim the date column.
    expect(
      title?.mode === 'VISUAL' ? title.sourceValues[0]?.primary : undefined,
    ).not.toBe(
      dateTime?.mode === 'VISUAL'
        ? dateTime.sourceValues[0]?.primary
        : undefined,
    )
    expect(
      detections.find((entry) => entry.field === 'title')?.requiresConfirmation,
    ).toBe(true)
  })
  it('profiles textual month dates as dates', () => {
    const table = parse(
      'Date,Title,Amount\n14-Mar-2022,Meal,10\n"Mar 4, 2022",Snack,20',
    )
    const { mapping } = inferDelimitedExpenseMapping(table, 'USD', 'MDY')
    const dateTime = mapping.mappings.dateTime
    expect(
      dateTime?.mode === 'VISUAL'
        ? dateTime.sourceValues[0]?.primary
        : undefined,
    ).toBe('date#1')
  })
  it('prefers qualified amount headers over a bare total', () => {
    for (const header of ['Amount INR', 'Total Amount']) {
      const table = parse(
        `Date,Description,${header},Total\n2022-03-14,Cafe,50,9000\n2022-03-15,Shop,20,8980`,
      )
      const { mapping } = inferDelimitedExpenseMapping(table, 'USD', 'MDY')
      expect(mapping.mappings.money.mode).toBe('VISUAL')
      if (mapping.mappings.money.mode !== 'VISUAL')
        throw new Error('Expected visual money')
      // Word-boundary matching gives `Amount INR`/`Total Amount` the amount
      // bonus so they beat the bare `Total` column.
      expect(mapping.mappings.money.amount.sourceValues[0]?.primary).not.toBe(
        'total#1',
      )
    }
    // Exact `Amount`/`Total` behavior is unchanged.
    const exact = parse(
      'Date,Description,Amount,Total\n2022-03-14,Cafe,50,9000\n2022-03-15,Shop,20,8980',
    )
    const { mapping } = inferDelimitedExpenseMapping(exact, 'USD', 'MDY')
    expect(mapping.mappings.money.mode).toBe('VISUAL')
    if (mapping.mappings.money.mode !== 'VISUAL')
      throw new Error('Expected visual money')
    expect(mapping.mappings.money.amount.sourceValues[0]?.primary).toBe(
      'amount#1',
    )
  })
  it('prefers exact amount/total headers over qualified lookalikes', () => {
    const table = parse(
      'Date,Description,Amount,Corrected amount\n2022-03-14,Cafe,50,51\n2022-03-15,Shop,20,22',
    )
    const { mapping } = inferDelimitedExpenseMapping(table, 'USD', 'MDY')
    expect(mapping.mappings.money.mode).toBe('VISUAL')
    if (mapping.mappings.money.mode !== 'VISUAL')
      throw new Error('Expected visual money')
    // Exact `Amount` (5 pts) outranks `Corrected amount` (4 pts); without
    // tiering the two tie and the pick is arbitrary.
    expect(mapping.mappings.money.amount.sourceValues[0]?.primary).toBe(
      'amount#1',
    )
    const totals = parse(
      'Date,Description,Total,Subtotal\n2022-03-14,Cafe,50,51\n2022-03-15,Shop,20,22',
    )
    const { mapping: totalMapping } = inferDelimitedExpenseMapping(
      totals,
      'USD',
      'MDY',
    )
    expect(totalMapping.mappings.money.mode).toBe('VISUAL')
    if (totalMapping.mappings.money.mode !== 'VISUAL')
      throw new Error('Expected visual money')
    expect(totalMapping.mappings.money.amount.sourceValues[0]?.primary).toBe(
      'total#1',
    )
  })
  it('ignores category sources across spacing and punctuation', () => {
    const table = parse(
      'Date,Description,Amount,Category\n2022-03-14,Uber,50,Food / Drinks\n2022-03-15,Uber,20,food/drinks',
    )
    const { mapping } = inferDelimitedExpenseMapping(table, 'USD')
    const rows = previewDelimitedRows(table, mapping, {
      categories: { ignoredSources: ['food/drinks'] },
    })
    // Both spellings collapse to `food/drinks`, so both rows ignore the source
    // and fall back to the title guess instead of the source dictionary.
    expect(rows.map((row) => row.category)).toEqual(['taxi', 'taxi'])
  })
})
