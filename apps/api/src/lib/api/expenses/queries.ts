import type { Prisma } from '@spliit/db'
import { prisma } from '@spliit/db'
import {
  COMMON_CURRENCY_LIMIT,
  SETTLEMENT_CATEGORY_ID,
  expandCategorySelection,
  commonCurrencyLookbackDate,
  isSupportedCurrencyCode,
  loadLocaleDictionary,
  rankCommonCurrencies,
} from '@spliit/domain'

import { resolveParticipantDisplayName } from '../../invitations/display'
import { toRecurrenceConfig } from '../recurrence-series'
import { balanceExpenseSelect } from '../selects/balance-expense'
import { groupExpenseListCardSelect } from '../selects/expense-list'
import { narrowCategoryId, resolveCategory } from './helpers'
import {
  expenseTextSearchOr,
  findSimilarExpenseTitleIds,
  mergeWhereAnd,
} from './title-search'

/** Prisma row shape fed into `mapExpenseListRow`. */
export type ExpenseListDbRow = Prisma.ExpenseGetPayload<{
  select: typeof groupExpenseListCardSelect
}>

/**
 * Map a Prisma row selected with `groupExpenseListCardSelect` into the public
 * expense-list-item shape. Shared by `getGroupExpenses` and external callers
 * (e.g. the budgets router) that need the same wire shape.
 */
export function mapExpenseListRow(row: ExpenseListDbRow) {
  const {
    _count,
    recurringSeries,
    paidByList: _paidByList,
    paidFor: _paidFor,
    items: _items,
    fileImportSource,
    ...rest
  } = row
  void _paidByList
  void _paidFor
  void _items
  return {
    ...rest,
    // Import provenance lives in the side table; the list wire shape keeps
    // the legacy `originType` field populated from the import provider.
    originType: fileImportSource?.provider ?? null,
    permissions: {
      canEdit: false,
      canDelete: false,
      canManageRecurrence: false,
    },
    documentCount: _count.documents,
    paidByList: row.paidByList.map((pb) => ({
      ledgerParticipant: {
        id: pb.ledgerParticipant.id,
        name: resolveParticipantDisplayName(pb.ledgerParticipant),
        account: pb.ledgerParticipant.groupMember?.account ?? null,
        removed: pb.ledgerParticipant.removedAt != null,
      },
      shares: pb.shares,
    })),
    paidFor: row.paidFor.map((pf) => ({
      ledgerParticipant: {
        id: pf.ledgerParticipant.id,
        name: resolveParticipantDisplayName(pf.ledgerParticipant),
        account: pf.ledgerParticipant.groupMember?.account ?? null,
        removed: pf.ledgerParticipant.removedAt != null,
      },
      shares: pf.shares,
    })),
    items: row.items.map((item) => ({
      id: item.id,
      title: item.title,
      amount: item.amount,
    })),
    categoryId: narrowCategoryId(row.categoryId),
    category: resolveCategory(row.categoryId),
    conversionRate: row.conversionRate ?? null,
    conversionSource: row.conversionSource,
    recurringSeriesId: recurringSeries?.id ?? null,
    recurringSeriesCreatorAccountId: recurringSeries?.creatorAccountId ?? null,
    recurrenceSequence: row.recurrenceSequence,
    recurringSeriesStatus: recurringSeries?.status ?? null,
  }
}

export async function getGroupExpensesParticipants(groupId: string) {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: { ledgerId: true },
  })
  if (!group?.ledgerId) return []

  const [paidBy, paidFor] = await Promise.all([
    prisma.expensePaidBy.findMany({
      where: { expense: { ledgerId: group.ledgerId } },
      select: { ledgerParticipantId: true },
      distinct: ['ledgerParticipantId'],
    }),
    prisma.expensePaidFor.findMany({
      where: { expense: { ledgerId: group.ledgerId } },
      select: { ledgerParticipantId: true },
      distinct: ['ledgerParticipantId'],
    }),
  ])

  return Array.from(
    new Set([
      ...paidBy.map((row) => row.ledgerParticipantId),
      ...paidFor.map((row) => row.ledgerParticipantId),
    ]),
  )
}

export async function getGroupBalanceExpenses(
  groupId: string,
  ledgerId?: string,
) {
  const resolvedLedgerId =
    ledgerId ??
    (
      await prisma.group.findUnique({
        where: { id: groupId },
        select: { ledgerId: true },
      })
    )?.ledgerId
  if (!resolvedLedgerId) return []

  return prisma.expense.findMany({
    where: { ledgerId: resolvedLedgerId },
    select: balanceExpenseSelect,
  })
}

type GetGroupExpensesSortBy = 'expenseDate' | 'createdAt' | 'amount'
type GetGroupExpensesSortDir = 'asc' | 'desc'
type GetGroupExpensesMatch = 'any' | 'all' | 'exact'

type GetGroupExpensesOptions = {
  ledgerId?: string
  offset?: number
  length?: number
  filter?: string
  locale?: string
  hideSettlements?: boolean
  categories?: string[]
  paidBy?: string[]
  paidByMatch?: GetGroupExpensesMatch
  paidFor?: string[]
  paidForMatch?: GetGroupExpensesMatch
  dateFrom?: Date
  dateTo?: Date
  minAmount?: number
  maxAmount?: number
  currencies?: string[]
  sortBy?: GetGroupExpensesSortBy
  sortDir?: GetGroupExpensesSortDir
}

function buildParticipantMatch(
  selected: string[] | undefined,
  match: GetGroupExpensesMatch | undefined,
  relation: 'paidByList' | 'paidFor',
): Prisma.ExpenseWhereInput | undefined {
  if (!selected || selected.length === 0) return undefined
  const relationFilter = {
    [relation]: {
      some: { ledgerParticipantId: { in: selected } },
    },
  } as const
  if ((match ?? 'any') === 'any') return relationFilter
  if (match === 'exact') {
    return {
      AND: selected.map((id) => ({
        [relation]: { some: { ledgerParticipantId: id } },
      })),
      NOT: {
        [relation]: { some: { ledgerParticipantId: { notIn: selected } } },
      },
    } as Prisma.ExpenseWhereInput
  }
  return {
    AND: selected.map((id) => ({
      [relation]: { some: { ledgerParticipantId: id } },
    })),
  } as Prisma.ExpenseWhereInput
}

export async function getGroupExpenses(
  groupId: string,
  options?: GetGroupExpensesOptions,
) {
  const ledgerId =
    options?.ledgerId ??
    (
      await prisma.group.findUnique({
        where: { id: groupId },
        select: { ledgerId: true },
      })
    )?.ledgerId
  if (!ledgerId) return []

  const expenseDateRange: Prisma.DateTimeFilter | undefined =
    options?.dateFrom || options?.dateTo
      ? {
          ...(options.dateFrom ? { gte: options.dateFrom } : {}),
          ...(options.dateTo ? { lte: options.dateTo } : {}),
        }
      : undefined

  const amountRange: Prisma.IntFilter | undefined =
    options?.minAmount !== undefined || options?.maxAmount !== undefined
      ? {
          ...(options.minAmount !== undefined
            ? { gte: options.minAmount }
            : {}),
          ...(options.maxAmount !== undefined
            ? { lte: options.maxAmount }
            : {}),
        }
      : undefined

  let where: Prisma.ExpenseWhereInput = {
    ledgerId,
    categoryId: (() => {
      if (options?.categories && options.categories.length > 0) {
        const expanded = expandCategorySelection(options.categories)
        return {
          in: expanded.length > 0 ? expanded : options.categories,
        }
      }
      if (options?.hideSettlements) {
        return { not: SETTLEMENT_CATEGORY_ID }
      }
      return undefined
    })(),
    originalCurrency:
      options?.currencies && options.currencies.length > 0
        ? { in: options.currencies }
        : undefined,
    expenseDate: expenseDateRange,
    amount: amountRange,
    ...buildParticipantMatch(
      options?.paidBy,
      options?.paidByMatch,
      'paidByList',
    ),
    ...buildParticipantMatch(
      options?.paidFor,
      options?.paidForMatch,
      'paidFor',
    ),
  }

  const filter = options?.filter?.trim()
  if (filter) {
    await loadLocaleDictionary(options?.locale)
    const similarTitleIds = await findSimilarExpenseTitleIds({
      ledgerIds: [ledgerId],
      query: filter,
    })
    where = mergeWhereAnd(
      where,
      expenseTextSearchOr({
        query: filter,
        locale: options?.locale,
        similarTitleIds,
      }),
    )
  }

  const effectiveField = options?.sortBy ?? 'expenseDate'
  const sortDir = options?.sortDir ?? 'desc'
  const primaryOrder: Prisma.ExpenseOrderByWithRelationInput = {
    [effectiveField]: sortDir,
  }
  const orderBy: Prisma.ExpenseOrderByWithRelationInput[] =
    effectiveField === 'expenseDate'
      ? [primaryOrder, { createdAt: 'desc' }, { id: 'desc' }]
      : [primaryOrder, { id: 'desc' }]

  const rows = await prisma.expense.findMany({
    select: groupExpenseListCardSelect,
    where,
    orderBy,
    skip: options && options.offset,
    take: options && options.length,
  })

  return rows.map(mapExpenseListRow)
}
export async function getGroupExpenseCount(groupId: string) {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: { ledgerId: true },
  })
  if (!group?.ledgerId) return 0
  return prisma.expense.count({ where: { ledgerId: group.ledgerId } })
}

/**
 * Rank currencies previously used in the group (excluding the pinned group
 * ledger currency). Loads only `originalCurrency` + `expenseDate` within a
 * recency lookback so large ledgers stay cheap; scoring uses a 90-day half-life
 * (see `@spliit/domain` `rankCommonCurrencies`).
 */
export function mergeCurrencyRecommendations(
  groupCurrency: string | null | undefined,
  learnedCurrencyCodes: ReadonlyArray<string>,
): string[] {
  const recommendations: string[] = []
  const seen = new Set<string>()

  for (const code of learnedCurrencyCodes) {
    if (code === groupCurrency || seen.has(code)) continue
    if (!isSupportedCurrencyCode(code)) continue
    seen.add(code)
    recommendations.push(code)
    if (recommendations.length === COMMON_CURRENCY_LIMIT) break
  }

  return recommendations
}

export async function getGroupCommonCurrencies(groupId: string) {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: {
      ledgerId: true,
      ledger: { select: { currencyCode: true } },
    },
  })
  if (!group?.ledgerId) return [] as string[]

  const since = commonCurrencyLookbackDate()
  const rows = await prisma.expense.findMany({
    where: {
      ledgerId: group.ledgerId,
      expenseDate: { gte: since },
    },
    select: {
      originalCurrency: true,
      expenseDate: true,
    },
  })

  const learnedCurrencyCodes = rankCommonCurrencies(rows, {
    groupCurrency: group.ledger.currencyCode,
  })
  return mergeCurrencyRecommendations(
    group.ledger.currencyCode,
    learnedCurrencyCodes,
  )
}

export async function getExpense(groupId: string, expenseId: string) {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: { ledgerId: true },
  })
  if (!group?.ledgerId) return null
  const expense = await prisma.expense.findFirst({
    where: { id: expenseId, ledgerId: group.ledgerId },
    include: {
      paidByList: { include: { ledgerParticipant: true } },
      paidFor: true,
      documents: true,
      recurringSeries: true,
      fileImportSource: { select: { provider: true } },
      items: {
        include: { paidFor: true },
      },
      itemizedRemainder: {
        include: { paidFor: true },
      },
    },
  })
  if (!expense) return null
  const previousExpense =
    expense.recurringSeries && expense.recurrenceSequence
      ? await prisma.expense.findFirst({
          where: {
            recurringSeriesId: expense.recurringSeriesId,
            recurrenceSequence: { lt: expense.recurrenceSequence },
          },
          orderBy: { recurrenceSequence: 'desc' },
          select: { id: true },
        })
      : null
  const nextExpense =
    expense.recurringSeries && expense.recurrenceSequence
      ? await prisma.expense.findFirst({
          where: {
            recurringSeriesId: expense.recurringSeriesId,
            recurrenceSequence: { gt: expense.recurrenceSequence },
          },
          orderBy: { recurrenceSequence: 'asc' },
          select: { id: true },
        })
      : null
  const { fileImportSource, ...expenseRest } = expense
  return {
    ...expenseRest,
    originType: fileImportSource?.provider ?? null,
    categoryId: narrowCategoryId(expense.categoryId),
    category: resolveCategory(expense.categoryId),
    recurrence: expense.recurringSeries
      ? toRecurrenceConfig(expense.recurringSeries)
      : null,
    previousExpenseId: previousExpense?.id ?? null,
    nextExpenseId: nextExpense?.id ?? null,
  }
}

export async function getRecurringExpenseSeries(
  groupId: string,
  options?: {
    cursor?: string
    limit?: number
    seriesId?: string
    occurrenceCursor?: number
    occurrenceLimit?: number
  },
) {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: { ledgerId: true },
  })
  if (!group?.ledgerId) return { series: [], nextCursor: null }
  const limit = Math.min(Math.max(options?.limit ?? 20, 1), 100)
  const rows = await prisma.recurringExpenseSeries.findMany({
    where: {
      ledgerId: group.ledgerId,
      ...(options?.seriesId ? { id: options.seriesId } : {}),
    },
    orderBy: [{ anchorDate: 'desc' }, { id: 'desc' }],
    ...(options?.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    take: limit + 1,
    include: {
      expenses: options?.seriesId
        ? {
            where: options.occurrenceCursor
              ? { recurrenceSequence: { gt: options.occurrenceCursor } }
              : undefined,
            orderBy: { recurrenceSequence: 'asc' },
            take: Math.min(Math.max(options.occurrenceLimit ?? 50, 1), 100) + 1,
            select: {
              id: true,
              expenseDate: true,
              expenseTimeZone: true,
              recurrenceSequence: true,
              title: true,
              amount: true,
            },
          }
        : false,
    },
  })
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit)
  return {
    series: page.map((series) => {
      const expenses = Array.isArray(series.expenses) ? series.expenses : []
      const occurrenceLimit = options?.occurrenceLimit ?? 50
      return {
        id: series.id,
        timeZone: series.timeZone,
        frequency: series.frequency,
        interval: series.interval,
        anchorDate: series.anchorDate,
        nextOccurrenceDate: series.nextOccurrenceDate,
        endType: series.endType,
        occurrenceLimit: series.occurrenceLimit,
        endDate: series.endDate,
        occurrencesCreated: series.occurrencesCreated,
        status: series.status,
        recurrence: toRecurrenceConfig(series),
        expenses: expenses.slice(0, occurrenceLimit),
        hasMoreOccurrences: expenses.length > occurrenceLimit,
        nextOccurrenceCursor:
          expenses.length > occurrenceLimit
            ? (expenses[occurrenceLimit - 1]?.recurrenceSequence ?? null)
            : null,
      }
    }),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  }
}
