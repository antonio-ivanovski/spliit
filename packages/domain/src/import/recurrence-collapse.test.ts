import { describe, expect, it } from 'vitest'

import {
  collapseExpenseFromNormalized,
  fingerprintLegacyRecurringExpense,
  firstRecurrenceAfterToday,
  firstRecurrenceDateAfterToday,
  planLegacyRecurringImport,
  summarizeLegacyRecurringImport,
  type LegacyRecurringCollapseExpense,
} from './recurrence-collapse'

function expense(
  overrides: Partial<LegacyRecurringCollapseExpense> = {},
): LegacyRecurringCollapseExpense {
  return {
    title: overrides.title ?? 'Spotify Monthly',
    expenseDate: overrides.expenseDate ?? '2025-06-19',
    amount: overrides.amount ?? 1000,
    recurrenceRule: overrides.recurrenceRule ?? 'MONTHLY',
    recurrence: overrides.recurrence ?? null,
    splitMode: overrides.splitMode ?? 'EVENLY',
    category: overrides.category ?? 'general',
    paidBy: overrides.paidBy ?? [{ id: 'p1', shares: 1000 }],
    paidFor: overrides.paidFor ?? [
      { id: 'p1', shares: 1 },
      { id: 'p2', shares: 1 },
    ],
    originalCurrency: overrides.originalCurrency ?? null,
    conversionRate: overrides.conversionRate ?? null,
  }
}

describe('fingerprintLegacyRecurringExpense', () => {
  it('returns null for NONE', () => {
    expect(
      fingerprintLegacyRecurringExpense(expense({ recurrenceRule: 'NONE' })),
    ).toBeNull()
  })

  it('matches identical schedules and differs on amount', () => {
    const a = fingerprintLegacyRecurringExpense(expense())
    const b = fingerprintLegacyRecurringExpense(
      expense({ expenseDate: '2025-07-19' }),
    )
    const c = fingerprintLegacyRecurringExpense(expense({ amount: 2000 }))
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('treats settlement and ordinary payment as different fingerprints', () => {
    const payment = fingerprintLegacyRecurringExpense(
      expense({ category: 'payment' }),
    )
    const settlement = fingerprintLegacyRecurringExpense(
      expense({ category: 'settlement' }),
    )
    expect(payment).not.toBe(settlement)
  })
})

describe('planLegacyRecurringImport', () => {
  const today = new Date('2026-07-23T12:00:00.000Z')

  it('plans a single recurring row', () => {
    const expenses = [expense({ expenseDate: '2026-06-01' })]
    const plan = planLegacyRecurringImport(expenses, today)
    expect(plan.series).toHaveLength(1)
    expect(plan.membership).toEqual([
      {
        expenseIndex: 0,
        seriesKey: plan.series[0]!.seriesKey,
        sequence: 1,
        isSeriesAnchor: true,
      },
    ])
    expect(plan.series[0]!.occurrenceCount).toBe(1)
    expect(plan.series[0]!.nextOccurrenceDate!.toISOString().slice(0, 10)).toBe(
      '2026-08-01',
    )
  })

  it('collapses three matching monthly rows into one series', () => {
    const expenses = [
      expense({ expenseDate: '2025-05-19' }),
      expense({ expenseDate: '2025-06-19' }),
      expense({ expenseDate: '2025-07-19' }),
    ]
    const plan = planLegacyRecurringImport(expenses, today)
    expect(plan.series).toHaveLength(1)
    expect(plan.series[0]!.occurrenceCount).toBe(3)
    expect(plan.series[0]!.anchorIndex).toBe(2)
    expect(plan.series[0]!.nextOccurrenceDate!.toISOString().slice(0, 10)).toBe(
      '2026-08-19',
    )
    expect(plan.series[0]!.nextOccurrenceOrdinal).toBe(14)
    expect(
      plan.membership.map((row) => ({
        expenseIndex: row.expenseIndex,
        sequence: row.sequence,
        isSeriesAnchor: row.isSeriesAnchor,
      })),
    ).toEqual([
      { expenseIndex: 0, sequence: 1, isSeriesAnchor: false },
      { expenseIndex: 1, sequence: 2, isSeriesAnchor: false },
      { expenseIndex: 2, sequence: 3, isSeriesAnchor: true },
    ])
    expect(summarizeLegacyRecurringImport(expenses)).toEqual([
      {
        title: 'Spotify Monthly',
        recurrenceRule: 'MONTHLY',
        config: {
          frequency: 'MONTHLY',
          interval: 1,
          end: { type: 'INDEFINITE' },
        },
      },
    ])
  })

  it('collapses a long Spotify-style monthly history into one series', () => {
    const expenses = Array.from({ length: 14 }, (_, i) => {
      const monthIndex = 4 + i // May 2025 .. June 2026
      const year = 2025 + Math.floor(monthIndex / 12)
      const month = (monthIndex % 12) + 1
      const mm = String(month).padStart(2, '0')
      return expense({
        title: 'Preeti Monthly',
        expenseDate: `${year}-${mm}-19`,
      })
    })
    const plan = planLegacyRecurringImport(expenses, today)
    expect(plan.series).toHaveLength(1)
    expect(plan.series[0]!.occurrenceCount).toBe(14)
    expect(plan.membership).toHaveLength(14)
    expect(plan.membership.map((m) => m.sequence)).toEqual(
      Array.from({ length: 14 }, (_, i) => i + 1),
    )
    expect(plan.membership.filter((m) => m.isSeriesAnchor)).toHaveLength(1)
    expect(expenses[plan.series[0]!.anchorIndex]!.expenseDate).toBe(
      '2026-06-19',
    )
    expect(plan.series[0]!.nextOccurrenceDate!.toISOString().slice(0, 10)).toBe(
      '2026-08-19',
    )
    expect(plan.series[0]!.nextOccurrenceOrdinal).toBe(3)
  })

  it('keeps different amounts as separate series', () => {
    const expenses = [
      expense({ title: 'Rent', amount: 1000, expenseDate: '2026-01-01' }),
      expense({ title: 'Rent', amount: 1200, expenseDate: '2026-02-01' }),
    ]
    const plan = planLegacyRecurringImport(expenses, today)
    expect(plan.series).toHaveLength(2)
    expect(summarizeLegacyRecurringImport(expenses)).toEqual([
      {
        title: 'Rent',
        recurrenceRule: 'MONTHLY',
        config: {
          frequency: 'MONTHLY',
          interval: 1,
          end: { type: 'INDEFINITE' },
        },
      },
      {
        title: 'Rent',
        recurrenceRule: 'MONTHLY',
        config: {
          frequency: 'MONTHLY',
          interval: 1,
          end: { type: 'INDEFINITE' },
        },
      },
    ])
  })

  it('ignores NONE rows', () => {
    const expenses = [
      expense({ recurrenceRule: 'NONE' }),
      expense({
        title: 'Gym',
        recurrenceRule: 'WEEKLY',
        expenseDate: '2026-07-01',
      }),
    ]
    const plan = planLegacyRecurringImport(expenses, today)
    expect(plan.series).toHaveLength(1)
    expect(plan.series[0]!.title).toBe('Gym')
    expect(plan.membership).toHaveLength(1)
  })
})

describe('firstRecurrenceDateAfterToday', () => {
  it('advances past overdue dates', () => {
    const next = firstRecurrenceDateAfterToday(
      { frequency: 'MONTHLY', interval: 1, end: { type: 'INDEFINITE' } },
      '2026-06-01',
      new Date('2026-07-23T00:00:00.000Z'),
    )
    expect(next!.toISOString().slice(0, 10)).toBe('2026-08-01')
  })
})

describe('firstRecurrenceAfterToday', () => {
  it('returns matching ordinal for the advanced date', () => {
    const next = firstRecurrenceAfterToday(
      { frequency: 'MONTHLY', interval: 1, end: { type: 'INDEFINITE' } },
      '2026-06-01',
      new Date('2026-07-23T00:00:00.000Z'),
    )
    expect(next!.date.toISOString().slice(0, 10)).toBe('2026-08-01')
    expect(next!.ordinal).toBe(3)
  })

  it('keeps month-end anchors on the 31st after overdue skip (not iterative clamp drift)', () => {
    // Iterative Jan31→Feb28→Mar28… would land on Jul 28; anchored math stays Jul 31.
    const next = firstRecurrenceAfterToday(
      { frequency: 'MONTHLY', interval: 1, end: { type: 'INDEFINITE' } },
      '2025-01-31',
      new Date('2026-07-23T00:00:00.000Z'),
    )
    expect(next!.date.toISOString().slice(0, 10)).toBe('2026-07-31')
    expect(next!.ordinal).toBe(19)
  })

  it('recovers leap-day yearly anchors to Feb 29 (not stuck on iterative Feb 28)', () => {
    // After 2024-02-29, non-leap years clamp to Feb 28; ordinal 5 returns to Feb 29.
    // Iterative stepping from Feb 28 would stay on the 28th forever.
    const next = firstRecurrenceAfterToday(
      { frequency: 'YEARLY', interval: 1, end: { type: 'INDEFINITE' } },
      '2024-02-29',
      new Date('2027-03-01T00:00:00.000Z'),
    )
    expect(next!.date.toISOString().slice(0, 10)).toBe('2028-02-29')
    expect(next!.ordinal).toBe(5)
  })

  it('honours a multi-interval config (every 3 months)', () => {
    const next = firstRecurrenceAfterToday(
      { frequency: 'MONTHLY', interval: 3, end: { type: 'INDEFINITE' } },
      '2026-01-15',
      new Date('2026-07-23T00:00:00.000Z'),
    )
    expect(next!.date.toISOString().slice(0, 10)).toBe('2026-10-15')
  })

  it('returns null when a DATE end precedes the next candidate after today', () => {
    const next = firstRecurrenceAfterToday(
      {
        frequency: 'MONTHLY',
        interval: 1,
        end: {
          type: 'DATE',
          endDate: new Date('2026-07-01T00:00:00.000Z'),
        },
      },
      '2026-01-01',
      new Date('2026-07-15T00:00:00.000Z'),
    )
    expect(next).toBeNull()
  })

  it('returns null when a COUNT end is exhausted', () => {
    const next = firstRecurrenceAfterToday(
      { frequency: 'MONTHLY', interval: 1, end: { type: 'COUNT', count: 3 } },
      '2026-01-01',
      new Date('2026-02-15T00:00:00.000Z'),
      3,
    )
    expect(next).toBeNull()
  })
})

describe('planLegacyRecurringImport month-end', () => {
  it('plans next cursor with anchored math for a 31st-day monthly history', () => {
    const today = new Date('2026-07-23T12:00:00.000Z')
    const expenses = [
      expense({ title: 'Rent', expenseDate: '2026-01-31' }),
      expense({ title: 'Rent', expenseDate: '2026-03-31' }),
      expense({ title: 'Rent', expenseDate: '2026-05-31' }),
    ]
    const plan = planLegacyRecurringImport(expenses, today)
    expect(plan.series).toHaveLength(1)
    expect(plan.series[0]!.nextOccurrenceDate!.toISOString().slice(0, 10)).toBe(
      '2026-07-31',
    )
    expect(plan.series[0]!.nextOccurrenceOrdinal).toBe(3)
  })

  it('preserves null nextOccurrenceDate when recurrence end is exhausted', () => {
    const today = new Date('2026-07-23T12:00:00.000Z')
    const expenses = [
      expense({
        title: 'Limited Gym',
        expenseDate: '2026-01-01',
        recurrence: {
          frequency: 'MONTHLY',
          interval: 1,
          end: {
            type: 'DATE',
            endDate: new Date('2026-05-01T00:00:00.000Z'),
          },
        },
      }),
    ]
    const plan = planLegacyRecurringImport(expenses, today)
    expect(plan.series).toHaveLength(1)
    expect(plan.series[0]!.nextOccurrenceDate).toBeNull()
    expect(plan.series[0]!.nextOccurrenceOrdinal).toBeNull()
    expect(summarizeLegacyRecurringImport(expenses)).toHaveLength(0)
  })
})

describe('collapseExpenseFromNormalized', () => {
  it('maps paidBySourceId when paidBy is absent', () => {
    const collapsed = collapseExpenseFromNormalized({
      title: 'Netflix',
      expenseDate: '2026-06-01',
      amount: 500,
      recurrenceRule: 'MONTHLY',
      splitMode: 'EVENLY',
      category: 'general',
      paidBySourceId: 'p1',
      paidFor: [{ sourceId: 'p1', shares: 1 }],
    })
    expect(collapsed.paidBy).toEqual([{ id: 'p1', shares: 500 }])
  })
})
