import { describe, expect, it } from 'vitest'

import { cospendCategoryToId } from './cospend-categories'
import { tryParseCospendCsv } from './cospend-csv'

/**
 * Build a minimal Cospend project CSV. Sections are separated by a single blank
 * line, matching the real export format.
 */
function cospendCsv(
  opts: {
    members?: Array<[name: string, weight: number]>
    bills?: Array<{
      what: string
      amount: number
      date: string
      payer: string
      owers: string
      repeat?: string
      repeatfreq?: number
      repeatuntil?: string
      categoryid?: string | number
      comment?: string
      deleted?: number
    }>
    categories?: Array<[name: string, id: number]>
    currencies?: string[]
  } = {},
): string {
  const members = opts.members ?? [
    ['Alex', 1],
    ['Sam', 1],
  ]
  const lines: string[] = []
  lines.push('name,weight,active,color')
  for (const [name, weight] of members) {
    lines.push(`"${name}",${weight},1,"#d6b461"`)
  }
  lines.push('')
  lines.push(
    'what,amount,date,timestamp,payer_name,payer_weight,payer_active,owers,repeat,repeatfreq,repeatallactive,repeatuntil,categoryid,paymentmode,paymentmodeid,comment,deleted',
  )
  for (const b of opts.bills ?? []) {
    lines.push(
      `"${b.what}",${b.amount},${b.date},1785690155,"${b.payer}",1,1,"${b.owers}",${b.repeat ?? 'n'},${b.repeatfreq ?? 1},0,${b.repeatuntil ?? ''},${b.categoryid ?? 0},n,0,"${b.comment ?? ''}",${b.deleted ?? 0}`,
    )
  }
  if (opts.categories) {
    lines.push('')
    lines.push('categoryname,categoryid,icon,color')
    for (const [name, id] of opts.categories) {
      lines.push(`"${name}",${id},"🏠","#da8733"`)
    }
  }
  if (opts.currencies) {
    lines.push('')
    lines.push('currencyname,exchange_rate')
    for (const code of opts.currencies) {
      lines.push(`"${code}",1.0`)
    }
  }
  return lines.join('\n')
}

describe('tryParseCospendCsv', () => {
  it('parses members and a basic bill', () => {
    const result = tryParseCospendCsv(
      cospendCsv({
        bills: [
          {
            what: 'Parken DUS',
            amount: 10,
            date: '2026-08-02',
            payer: 'Alex',
            owers: 'Alex,Sam',
          },
        ],
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source.provider).toBe('COSPEND')
    expect(result.source.name).toBe('Imported from Cospend')
    expect(result.source.currencyCode).toBe('EUR')
    expect(result.source.participants).toEqual([
      { sourceId: 'cospend-member-0', sourceName: 'Alex' },
      { sourceId: 'cospend-member-1', sourceName: 'Sam' },
    ])
    expect(result.source.expenses).toHaveLength(1)
    const expense = result.source.expenses[0]!
    expect(expense.title).toBe('Parken DUS')
    expect(expense.expenseDate).toBe('2026-08-02')
    expect(expense.amount).toBe(1000)
    expect(expense.amountCurrency).toBe('EUR')
    expect(expense.paidBySourceId).toBe('cospend-member-0')
    // Even split between two equal-weight members.
    expect(expense.paidFor).toEqual([
      { sourceId: 'cospend-member-0', shares: 500 },
      { sourceId: 'cospend-member-1', shares: 500 },
    ])
    expect(expense.splitMode).toBe('EVENLY')
    expect(expense.recurrence).toBeNull()
    expect(expense.recurrenceRule).toBe('NONE')
  })

  it('splits proportionally to member weights', () => {
    const result = tryParseCospendCsv(
      cospendCsv({
        members: [
          ['Alex', 1],
          ['Sam', 3],
        ],
        bills: [
          {
            what: 'Miete',
            amount: 400,
            date: '2026-08-01',
            payer: 'Alex',
            owers: 'Alex,Sam',
          },
        ],
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const expense = result.source.expenses[0]!
    // Alex (weight 1) : Sam (weight 3) → BY_SHARES normalised to a 1:3 ratio.
    // The actual amounts (100.00 / 300.00) are recomputed from this ratio.
    expect(expense.paidFor).toEqual([
      { sourceId: 'cospend-member-0', shares: 100 },
      { sourceId: 'cospend-member-1', shares: 300 },
    ])
    expect(expense.splitMode).toBe('BY_SHARES')
  })

  it('maps monthly recurrence to a MONTHLY config', () => {
    const result = tryParseCospendCsv(
      cospendCsv({
        bills: [
          {
            what: 'Spotify',
            amount: 10.99,
            date: '2026-08-01',
            payer: 'Alex',
            owers: 'Alex,Sam',
            repeat: 'm',
          },
        ],
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const expense = result.source.expenses[0]!
    expect(expense.recurrence).toEqual({
      frequency: 'MONTHLY',
      interval: 1,
      end: { type: 'INDEFINITE' },
    })
    // A plain monthly schedule maps back to the legacy MONTHLY rule.
    expect(expense.recurrenceRule).toBe('MONTHLY')
  })

  it('maps yearly recurrence to a YEARLY config with a NONE legacy rule', () => {
    const result = tryParseCospendCsv(
      cospendCsv({
        bills: [
          {
            what: 'KFZ Haftpflicht',
            amount: 500,
            date: '2026-08-01',
            payer: 'Alex',
            owers: 'Alex,Sam',
            repeat: 'y',
          },
        ],
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const expense = result.source.expenses[0]!
    expect(expense.recurrence).toEqual({
      frequency: 'YEARLY',
      interval: 1,
      end: { type: 'INDEFINITE' },
    })
    // Yearly has no legacy equivalent, so the rule is NONE.
    expect(expense.recurrenceRule).toBe('NONE')
  })

  it('multiplies the interval by repeatfreq', () => {
    const result = tryParseCospendCsv(
      cospendCsv({
        bills: [
          {
            what: 'GEZ',
            amount: 18.36,
            date: '2026-08-01',
            payer: 'Alex',
            owers: 'Alex,Sam',
            repeat: 'm',
            repeatfreq: 3,
          },
        ],
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const expense = result.source.expenses[0]!
    expect(expense.recurrence).toEqual({
      frequency: 'MONTHLY',
      interval: 3,
      end: { type: 'INDEFINITE' },
    })
    // Interval > 1 has no legacy equivalent, so the rule is NONE.
    expect(expense.recurrenceRule).toBe('NONE')
  })

  it('maps biweekly to WEEKLY with interval 2', () => {
    const result = tryParseCospendCsv(
      cospendCsv({
        bills: [
          {
            what: 'Einkauf',
            amount: 50,
            date: '2026-08-01',
            payer: 'Alex',
            owers: 'Alex,Sam',
            repeat: 'b',
          },
        ],
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const expense = result.source.expenses[0]!
    expect(expense.recurrence).toEqual({
      frequency: 'WEEKLY',
      interval: 2,
      end: { type: 'INDEFINITE' },
    })
  })

  it('honours a dated repeatuntil as a DATE end', () => {
    const result = tryParseCospendCsv(
      cospendCsv({
        bills: [
          {
            what: 'Strom',
            amount: 100,
            date: '2026-08-01',
            payer: 'Alex',
            owers: 'Alex,Sam',
            repeat: 'm',
            repeatuntil: '2027-01-01',
          },
        ],
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const expense = result.source.expenses[0]!
    expect(expense.recurrence).toEqual({
      frequency: 'MONTHLY',
      interval: 1,
      end: { type: 'DATE', endDate: new Date('2027-01-01T00:00:00.000Z') },
    })
    // A dated end has no legacy equivalent, so the rule is NONE.
    expect(expense.recurrenceRule).toBe('NONE')
  })

  it('skips deleted bills', () => {
    const result = tryParseCospendCsv(
      cospendCsv({
        bills: [
          {
            what: 'Kept',
            amount: 10,
            date: '2026-08-02',
            payer: 'Alex',
            owers: 'Alex,Sam',
          },
          {
            what: 'Deleted',
            amount: 20,
            date: '2026-08-03',
            payer: 'Alex',
            owers: 'Alex,Sam',
            deleted: 1,
          },
        ],
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source.expenses).toHaveLength(1)
    expect(result.source.expenses[0]!.title).toBe('Kept')
  })

  it('maps known categories and falls back to general', () => {
    const result = tryParseCospendCsv(
      cospendCsv({
        categories: [
          ['Miete', 129],
          ['Strom', 130],
        ],
        bills: [
          {
            what: 'Miete',
            amount: 500,
            date: '2026-08-01',
            payer: 'Alex',
            owers: 'Alex,Sam',
            categoryid: 129,
          },
          {
            what: 'Mystery',
            amount: 10,
            date: '2026-08-02',
            payer: 'Alex',
            owers: 'Alex,Sam',
            categoryid: 999,
          },
        ],
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source.expenses[0]!.category).toBe('rent')
    expect(result.source.expenses[1]!.category).toBe('general')
  })

  it('decodes URL-encoded comments into notes', () => {
    const result = tryParseCospendCsv(
      cospendCsv({
        bills: [
          {
            what: 'Pizza',
            amount: 20,
            date: '2026-08-06',
            payer: 'Alex',
            owers: 'Alex,Sam',
            comment: 'pizza+%26+drinks',
          },
        ],
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source.expenses[0]!.notes).toBe('pizza & drinks')
  })

  it('maps categoryid -11 to settlement', () => {
    const result = tryParseCospendCsv(
      cospendCsv({
        bills: [
          {
            what: 'Alex paid Sam',
            amount: 15,
            date: '2026-08-05',
            payer: 'Alex',
            owers: 'Sam',
            categoryid: -11,
          },
        ],
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source.expenses[0]!.category).toBe('settlement')
  })

  it('preserves DEFAULT_CURRENCY when main currency row has an empty name', () => {
    const csv = [
      'name,weight,active,color',
      '"Alex",1,1,"#d6b461"',
      '',
      'what,amount,date,timestamp,payer_name,payer_weight,payer_active,owers,repeat,repeatfreq,repeatallactive,repeatuntil,categoryid,paymentmode,paymentmodeid,comment,deleted',
      '"Bill",10,2026-08-02,1785690155,"Alex",1,1,"Alex",n,1,0,,0,n,0,"",0',
      '',
      'currencyname,exchange_rate',
      '"",1',
      '"CHF",0.92',
    ].join('\n')
    const result = tryParseCospendCsv(csv)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source.currencyCode).toBe('EUR')
  })

  it('uses the first currency row as the base currency', () => {
    const result = tryParseCospendCsv(
      cospendCsv({
        currencies: ['USD', 'EUR'],
        bills: [
          {
            what: 'Bill',
            amount: 10,
            date: '2026-08-02',
            payer: 'Alex',
            owers: 'Alex,Sam',
          },
        ],
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source.currencyCode).toBe('USD')
    expect(result.source.expenses[0]!.amountCurrency).toBe('USD')
  })

  it('rejects files that are not Cospend exports', () => {
    const result = tryParseCospendCsv('a,b,c\n1,2,3\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/members or bills/i)
  })

  it('rejects exports with no members', () => {
    const csv = [
      'name,weight,active,color',
      '',
      'what,amount,date,timestamp,payer_name,payer_weight,payer_active,owers,repeat,repeatfreq,repeatallactive,repeatuntil,categoryid,paymentmode,paymentmodeid,comment,deleted',
      '"Bill",10,2026-08-02,1785690155,"Alex",1,1,"Alex",n,1,0,,0,n,0,"",0',
    ].join('\n')
    const result = tryParseCospendCsv(csv)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/no members/i)
  })

  it('rejects exports with no parseable bills', () => {
    const csv = [
      'name,weight,active,color',
      '"Alex",1,1,"#d6b461"',
      '',
      'what,amount,date,timestamp,payer_name,payer_weight,payer_active,owers,repeat,repeatfreq,repeatallactive,repeatuntil,categoryid,paymentmode,paymentmodeid,comment,deleted',
    ].join('\n')
    const result = tryParseCospendCsv(csv)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatch(/no parseable bills/i)
  })
})

describe('cospendCategoryToId', () => {
  it('maps German and English keywords', () => {
    expect(cospendCategoryToId('Lebensmittel')).toBe('groceries')
    expect(cospendCategoryToId('Restaurant')).toBe('dining-out')
    expect(cospendCategoryToId('Miete')).toBe('rent')
    expect(cospendCategoryToId('insurance')).toBe('insurance')
    expect(cospendCategoryToId('Unterkunft')).toBe('hotel')
    expect(cospendCategoryToId('Flug')).toBe('plane')
    expect(cospendCategoryToId('SUV')).toBe('car')
    expect(cospendCategoryToId('Rückzahlung')).toBe('settlement')
  })

  it('falls back to general for unknown or empty names', () => {
    expect(cospendCategoryToId('Blablabla')).toBe('general')
    expect(cospendCategoryToId('')).toBe('general')
    expect(cospendCategoryToId(null)).toBe('general')
  })
})
