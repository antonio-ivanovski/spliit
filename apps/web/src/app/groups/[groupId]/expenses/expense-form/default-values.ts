import { z } from 'zod'

import type { CreateExpenseSearch } from '@/router/schemas'
import type { AppRouterOutput } from '@spliit/api/router'
import type {
  Currency,
  Expense,
  ExpenseFormInputValues,
  ExpenseFormItemValues,
  SplitMode,
} from '@spliit/domain'
import {
  DEFAULT_CATEGORY_ID,
  SETTLEMENT_CATEGORY_ID,
  amountAsDecimal,
  categoryIdSchema,
  getCurrency,
  randomId,
  sharesAsDecimal,
  utcToWallTime,
  formatTimeMinutes,
} from '@spliit/domain'

// Legacy storage-units shape retained for backward-compatible helper tests.
// New reusable splits are group-owned split presets.
const savedDefaultSplitSchema = z.object({
  splitMode: z.enum(['EVENLY', 'BY_SHARES', 'BY_PERCENTAGE', 'BY_AMOUNT']),
  paidFor: z.array(
    z.object({
      participant: z.string(),
      shares: z.number().int(),
    }),
  ),
})

export type SavedDefaultSplit = z.infer<typeof savedDefaultSplitSchema>

const itemSplitModeSchema = z.enum([
  'EVENLY',
  'BY_SHARES',
  'BY_PERCENTAGE',
  'BY_AMOUNT',
])

const prefilledExpenseItemsSchema = z.array(
  z.object({
    id: z.string().optional(),
    title: z.string().optional().catch(''),
    unitPrice: z.coerce.number().finite().optional().catch(0),
    quantity: z.coerce.number().int().positive().optional().catch(1),
    splitMode: itemSplitModeSchema.optional().catch('EVENLY'),
    paidFor: z
      .array(
        z.object({
          participant: z.string(),
          shares: z.coerce.number().finite().positive().catch(1),
        }),
      )
      .optional()
      .catch(undefined),
  }),
)

const prefilledSettlementSchema = z.object({
  direction: z.enum(['pay', 'receive']),
  participantId: z.string().min(1),
  legs: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        amount: z.number().int().positive(),
      }),
    )
    .min(1),
})

export type GroupShape = NonNullable<AppRouterOutput['groups']['get']['group']>
export type LoadedExpense = NonNullable<
  AppRouterOutput['groups']['expenses']['get']['expense']
>

/** Adapt an in-memory import draft to the storage-shaped form input boundary. */
export function importDraftAsLoadedExpense(expense: Expense): LoadedExpense {
  const converted = expense.conversion != null
  return {
    ...expense,
    id: `import-draft-${randomId()}`,
    ledgerId: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    createdByAccountId: '',
    categoryId: expense.category,
    originalAmount: converted ? expense.amount : null,
    originalCurrency: converted ? expense.conversion!.currency : null,
    conversionRate:
      expense.conversion?.type === 'custom' ? expense.conversion.rate : null,
    conversionSource: expense.conversion
      ? expense.conversion.type === 'custom'
        ? 'CUSTOM'
        : 'EXCHANGE'
      : null,
    paidByList: expense.paidByList.map((row) => ({
      ...row,
      expenseId: '',
      ledgerParticipantId: row.participant,
    })),
    paidFor: expense.paidFor.map((row) => ({
      ...row,
      expenseId: '',
      ledgerParticipantId: row.participant,
    })),
    items: (expense.items ?? []).map((item) => ({
      ...item,
      id: item.id ?? randomId(),
      expenseId: '',
      paidFor: item.paidFor.map((row) => ({
        ...row,
        expenseItemId: '',
        ledgerParticipantId: row.participant,
      })),
    })),
    itemizedRemainder: expense.itemizedRemainder
      ? {
          ...expense.itemizedRemainder,
          expenseId: '',
          paidFor: expense.itemizedRemainder.paidFor.map((row) => ({
            ...row,
            expenseId: '',
            ledgerParticipantId: row.participant,
          })),
        }
      : null,
    recurrence: expense.recurrence ?? null,
    recurrenceSequence: null,
    recurringSeriesId: null,
    originType: null,
  } as unknown as LoadedExpense
}

type ExpenseItemPaidForInput =
  | { ledgerParticipantId: string; shares: number }
  | { participant: string; shares: number }

function getPaidForParticipantId(pf: ExpenseItemPaidForInput): string {
  return 'ledgerParticipantId' in pf ? pf.ledgerParticipantId : pf.participant
}

function dateToIsoDay(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

export type DefaultSplittingOptions = {
  splitMode: SplitMode
  paidFor: ExpenseFormInputValues['paidFor']
}

function recurrenceForCopy(
  recurrence: ExpenseFormInputValues['recurrence'],
  sourceDate: Date,
  copyDate: Date,
): ExpenseFormInputValues['recurrence'] {
  if (!recurrence || recurrence.end.type !== 'DATE') return recurrence

  const sourceDay = Date.UTC(
    sourceDate.getUTCFullYear(),
    sourceDate.getUTCMonth(),
    sourceDate.getUTCDate(),
  )
  const endDay = Date.UTC(
    recurrence.end.endDate.getUTCFullYear(),
    recurrence.end.endDate.getUTCMonth(),
    recurrence.end.endDate.getUTCDate(),
  )
  const durationDays = Math.max(0, (endDay - sourceDay) / 86_400_000)
  const shiftedEnd = new Date(copyDate)
  shiftedEnd.setUTCDate(shiftedEnd.getUTCDate() + durationDays)

  return { ...recurrence, end: { type: 'DATE', endDate: shiftedEnd } }
}

export const parseCategoryIdFromUrl = (raw: string | null | undefined) => {
  if (!raw) return DEFAULT_CATEGORY_ID
  const parsed = categoryIdSchema.safeParse(raw)
  return parsed.success ? parsed.data : DEFAULT_CATEGORY_ID
}

const parsePrefilledItems = (
  rawItems: string | undefined,
  group: GroupShape,
): ExpenseFormItemValues[] => {
  if (!rawItems) return []
  try {
    const parsed = prefilledExpenseItemsSchema.safeParse(JSON.parse(rawItems))
    if (!parsed.success) return []

    const validParticipantIds = new Set(group.participants.map((p) => p.id))
    return parsed.data.map((item) => {
      const seen = new Set<string>()
      const paidFor = (item.paidFor ?? []).flatMap(
        ({ participant, shares }) => {
          if (!validParticipantIds.has(participant)) return []
          if (seen.has(participant)) return []
          seen.add(participant)
          return [{ participant, shares }]
        },
      )

      // Missing assignments keep URL-prefilled items as documentation. The
      // participant editor supplies all members when the user opts into an
      // item split.
      return {
        id: item.id ?? randomId(),
        title: item.title ?? '',
        unitPrice: item.unitPrice ?? 0,
        quantity: item.quantity ?? 1,
        splitMode: item.splitMode ?? 'EVENLY',
        paidFor,
      }
    })
  } catch {
    return []
  }
}

function parsePrefilledSettlement(
  raw: string | undefined,
  group: GroupShape,
): z.infer<typeof prefilledSettlementSchema> | null {
  if (!raw) return null
  try {
    const parsed = prefilledSettlementSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) return null
    const validIds = new Set(group.participants.map(({ id }) => id))
    const legs = parsed.data.legs.filter(
      ({ from, to }) => validIds.has(from) && validIds.has(to) && from !== to,
    )
    if (!validIds.has(parsed.data.participantId) || legs.length === 0) {
      return null
    }
    return { ...parsed.data, legs }
  } catch {
    return null
  }
}

/** Resolve the neutral new-expense split: `EVENLY` over all participants. */
export function getNeutralDefaultSplit(
  group: GroupShape,
): DefaultSplittingOptions {
  return {
    splitMode: 'EVENLY',
    paidFor: group.participants.map(({ id }) => ({
      participant: id,
      shares: 1,
    })),
  }
}

/** Legacy helper retained only for importing old account preference snapshots. */
export function savedDefaultToFormValues(
  raw: unknown,
  group: GroupShape,
  groupCurrency: Currency,
): DefaultSplittingOptions | null {
  const parsed = savedDefaultSplitSchema.safeParse(raw)
  if (!parsed.success) return null
  const validIds = new Set(group.participants.map((p) => p.id))
  const paidFor = parsed.data.paidFor.flatMap(({ participant, shares }) =>
    validIds.has(participant)
      ? [
          {
            participant,
            shares:
              parsed.data.splitMode === 'BY_PERCENTAGE'
                ? shares / 100
                : parsed.data.splitMode === 'BY_AMOUNT'
                  ? amountAsDecimal(shares, groupCurrency)
                  : parsed.data.splitMode === 'BY_SHARES'
                    ? sharesAsDecimal(shares)
                    : shares,
          },
        ]
      : [],
  )
  if (!paidFor.length) return null
  return { splitMode: parsed.data.splitMode, paidFor }
}

export function buildExpenseFormDefaults(args: {
  isCreate: boolean
  expense?: LoadedExpense
  isCopy?: boolean
  searchParams: CreateExpenseSearch
  group: GroupShape
  groupCurrency: Currency
  currentLedgerParticipantId: string | null | undefined
  settlementTitle: string
  today?: Date
  now?: Date
  timeZone?: string
  /** Persisted default for this user+group, if any. */
  savedDefault?: unknown
}): ExpenseFormInputValues {
  const {
    isCreate,
    expense,
    isCopy,
    searchParams,
    group,
    groupCurrency,
    currentLedgerParticipantId,
    settlementTitle,
    today = new Date(),
    now = new Date(),
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
  } = args

  // Copy: prefill like edit, but force today's date.
  if (isCopy && expense) {
    const copyDate = today
    const defaults = buildExpenseFormDefaults({
      isCreate: false,
      expense,
      searchParams,
      group,
      groupCurrency,
      currentLedgerParticipantId,
      settlementTitle,
      today,
      now,
      timeZone,
    })
    return {
      ...defaults,
      expenseDay: dateToIsoDay(copyDate),
      recurrence: recurrenceForCopy(
        defaults.recurrence,
        expense.expenseDate,
        copyDate,
      ),
    }
  }

  if (!isCreate && expense) {
    // Storage units (cents / basis points) → display units (decimal /
    // display %). BY_AMOUNT shares use minor-units via amountAsDecimal;
    // BY_PERCENTAGE shares are stored in basis points and shown as %.
    const conversionRequired = !!(
      expense.originalCurrency &&
      expense.originalCurrency.length &&
      expense.originalCurrency !== group.currencyCode
    )
    const originalCurrency = conversionRequired
      ? (getCurrency(expense.originalCurrency ?? '') ?? groupCurrency)
      : groupCurrency
    const conversionRate = expense.conversionRate ?? 1

    // paidFor shares are stored in the expense-currency minor units
    // (original currency when conversion is required, group currency
    // otherwise). Legacy rows that pre-date the server-authoritative
    // conversion model stored BY_AMOUNT shares in the ledger currency;
    // detect that when the stored sum matches ledger `amount` rather
    // than `originalAmount`, then convert back to expense-currency
    // display units via the stored rate (major ÷ rate). BY_SHARES
    // shares are stored as fixed units (100 = 1 displayed share).
    const storedSharesSum = expense.paidFor.reduce(
      (sum, { shares }) => sum + shares,
      0,
    )
    const paidForInOriginal =
      conversionRequired &&
      expense.originalAmount != null &&
      storedSharesSum === expense.originalAmount
    const paidFor =
      expense.splitMode === 'BY_AMOUNT'
        ? expense.paidFor.map(({ ledgerParticipantId, shares }) => {
            if (paidForInOriginal) {
              return {
                participant: ledgerParticipantId,
                shares: amountAsDecimal(shares, originalCurrency),
              }
            }
            if (conversionRequired) {
              // Legacy ledger-currency minor units → expense major units.
              const ledgerDisplay = amountAsDecimal(shares, groupCurrency)
              return {
                participant: ledgerParticipantId,
                shares: ledgerDisplay / conversionRate,
              }
            }
            return {
              participant: ledgerParticipantId,
              shares: amountAsDecimal(shares, groupCurrency),
            }
          })
        : expense.splitMode === 'BY_SHARES'
          ? expense.paidFor.map(({ ledgerParticipantId, shares }) => ({
              participant: ledgerParticipantId,
              shares: sharesAsDecimal(shares),
            }))
          : expense.paidFor.map(({ ledgerParticipantId, shares }) => ({
              participant: ledgerParticipantId,
              shares:
                expense.splitMode === 'BY_PERCENTAGE' ? shares / 100 : shares,
            }))

    // paidBy shares are stored in originalCurrency minor units when
    // conversion is required, otherwise in Ledger minor units. BY_SHARES
    // paidBy rows are stored as fixed units (100 = 1 displayed share).
    const paidByCurrency = conversionRequired ? originalCurrency : groupCurrency
    const paidByList =
      expense.paidBySplitMode === 'BY_AMOUNT'
        ? expense.paidByList.map(({ ledgerParticipantId, shares }) => ({
            participant: ledgerParticipantId,
            shares: amountAsDecimal(shares, paidByCurrency),
          }))
        : expense.paidBySplitMode === 'BY_SHARES'
          ? expense.paidByList.map(({ ledgerParticipantId, shares }) => ({
              participant: ledgerParticipantId,
              shares: sharesAsDecimal(shares),
            }))
          : expense.paidByList.map(({ ledgerParticipantId, shares }) => ({
              participant: ledgerParticipantId,
              shares:
                expense.paidBySplitMode === 'BY_PERCENTAGE'
                  ? shares / 100
                  : shares,
            }))

    const itemAmountAsDisplay = (amount: number) =>
      amountAsDecimal(amount, originalCurrency)

    const itemShareAsDisplay = (
      shares: number,
      splitMode: ExpenseFormItemValues['splitMode'],
    ) =>
      splitMode === 'BY_AMOUNT'
        ? itemAmountAsDisplay(shares)
        : splitMode === 'BY_PERCENTAGE'
          ? shares / 100
          : splitMode === 'BY_SHARES'
            ? sharesAsDecimal(shares)
            : shares

    const items: ExpenseFormItemValues[] = (expense.items ?? []).map((item) => {
      const splitMode = (item.splitMode ??
        'EVENLY') as ExpenseFormItemValues['splitMode']
      const unitPrice = itemAmountAsDisplay(item.unitPrice)
      const paidFor = item.paidFor.map((pf) => ({
        participant: getPaidForParticipantId(pf as ExpenseItemPaidForInput),
        shares: itemShareAsDisplay(pf.shares, splitMode),
      }))
      return {
        id: item.id,
        title: item.title,
        unitPrice,
        quantity: item.quantity,
        paidFor,
        splitMode,
      }
    })

    type ItemizedRemainder = NonNullable<LoadedExpense['itemizedRemainder']>
    type ItemizedRemainderWithParticipant = Omit<
      ItemizedRemainder,
      'paidFor'
    > & {
      paidFor: ExpenseItemPaidForInput[]
    }
    const rawRemainder = (expense as { itemizedRemainder?: unknown })
      .itemizedRemainder as ItemizedRemainderWithParticipant | null | undefined
    const itemizedRemainder = rawRemainder
      ? {
          splitMode: (rawRemainder.splitMode ??
            'EVENLY') as ExpenseFormItemValues['splitMode'],
          paidFor: rawRemainder.paidFor.map((pf) => ({
            participant: getPaidForParticipantId(pf),
            shares: itemShareAsDisplay(
              pf.shares,
              (rawRemainder.splitMode ??
                'EVENLY') as ExpenseFormItemValues['splitMode'],
            ),
          })),
        }
      : {
          splitMode: 'EVENLY' as const,
          paidFor: group.participants.map(({ id }) => ({
            participant: id,
            shares: 1,
          })),
        }

    const editAt = new Date(expense.expenseDate)
    const editTz = expense.expenseTimeZone
    const editWall = utcToWallTime(editAt, editTz)
    const editTime = formatTimeMinutes(editWall.timeMinutes)
    return {
      title: expense.title,
      expenseDay: editWall.dateIso,
      expenseTime: editTime,
      expenseTimeZone: editTz,
      amount: conversionRequired
        ? expense.originalAmount != null
          ? amountAsDecimal(expense.originalAmount, originalCurrency)
          : amountAsDecimal(expense.amount, groupCurrency) / conversionRate
        : amountAsDecimal(expense.amount, groupCurrency),
      originalCurrency: expense.originalCurrency ?? group.currencyCode,
      conversionRate: expense.conversionRate ?? undefined,
      conversionType:
        expense.conversionSource === 'CUSTOM' ||
        expense.conversionSource === 'EXCHANGE'
          ? expense.conversionSource
          : expense.originalCurrency && expense.conversionRate
            ? ('CUSTOM' as const)
            : undefined,
      category: expense.categoryId,
      paidBySplitMode: expense.paidBySplitMode,
      paidByList,
      isMultiPayer: expense.paidByList.length > 1,
      paidFor,
      splitMode: expense.splitMode,
      documents: expense.documents,
      notes: expense.notes ?? '',
      recurrence: expense.recurrence ?? null,
      recurrenceRule: 'NONE',
      items,
      itemizedRemainder,
    }
  }

  // Create flows always start from the neutral split. Reusable group presets
  // are applied explicitly through the Split preset picker.
  const defaultSplittingOptions = getNeutralDefaultSplit(group)
  const prefilledItems = parsePrefilledItems(searchParams.items, group)
  const hasPrefilledItemSplits = prefilledItems.some(
    (item) => item.paidFor.length > 0,
  )
  const searchCurrency =
    searchParams.originalCurrency && searchParams.originalCurrency.length
      ? (getCurrency(searchParams.originalCurrency) ?? groupCurrency)
      : groupCurrency
  const searchOriginalCurrency =
    searchParams.originalCurrency ?? group.currencyCode ?? undefined
  const defaultPaidByList = currentLedgerParticipantId
    ? [
        {
          participant: currentLedgerParticipantId,
          shares: amountAsDecimal(
            Number(searchParams.amount) || 0,
            searchCurrency,
          ),
        },
      ]
    : []
  const validParticipantIds = new Set(group.participants.map(({ id }) => id))
  const prefilledPayer =
    searchParams.payer && validParticipantIds.has(searchParams.payer)
      ? searchParams.payer
      : undefined
  const prefilledParticipants = (searchParams.participants ?? '')
    .split(',')
    .map((participant) => participant.trim())
    .filter(
      (participant, index, values) =>
        participant.length > 0 &&
        validParticipantIds.has(participant) &&
        values.indexOf(participant) === index,
    )

  if (
    searchParams.settlement === 'yes' ||
    searchParams.reimbursement === 'yes'
  ) {
    const settlementNeedsConversion =
      searchOriginalCurrency != null &&
      searchOriginalCurrency !== group.currencyCode
    const prefilledSettlement = parsePrefilledSettlement(
      searchParams.settlements,
      group,
    )
    if (prefilledSettlement) {
      const totalMinor = prefilledSettlement.legs.reduce(
        (sum, leg) => sum + leg.amount,
        0,
      )
      const totalDisplay = amountAsDecimal(totalMinor, searchCurrency)
      const paidByList =
        prefilledSettlement.direction === 'pay'
          ? [
              {
                participant: prefilledSettlement.participantId,
                shares: totalDisplay,
              },
            ]
          : prefilledSettlement.legs.map((leg) => ({
              participant: leg.from,
              shares: amountAsDecimal(leg.amount, searchCurrency),
            }))
      const paidFor =
        prefilledSettlement.direction === 'pay'
          ? prefilledSettlement.legs.map((leg) => ({
              participant: leg.to,
              shares: amountAsDecimal(leg.amount, searchCurrency),
            }))
          : [
              {
                participant: prefilledSettlement.participantId,
                shares: totalDisplay,
              },
            ]
      return {
        title: settlementTitle,
        expenseDay: dateToIsoDay(today),
        expenseTime: formatTimeMinutes(
          utcToWallTime(now, timeZone).timeMinutes,
        ),
        expenseTimeZone: timeZone,
        amount: totalDisplay,
        originalCurrency: searchOriginalCurrency,
        conversionRate: undefined,
        conversionType: settlementNeedsConversion ? 'EXCHANGE' : undefined,
        category: SETTLEMENT_CATEGORY_ID,
        paidBySplitMode: 'BY_AMOUNT' as const,
        paidByList,
        isMultiPayer:
          prefilledSettlement.direction === 'receive' && paidByList.length > 1,
        paidFor,
        splitMode: 'BY_AMOUNT' as const,
        documents: [],
        notes: '',
        recurrence: null,
        recurrenceRule: 'NONE',
        itemizedRemainder: {
          splitMode: 'EVENLY' as const,
          paidFor: group.participants.map(({ id }) => ({
            participant: id,
            shares: 1,
          })),
        },
      }
    }
    return {
      title: settlementTitle,
      expenseDay: dateToIsoDay(today),
      expenseTime: formatTimeMinutes(utcToWallTime(now, timeZone).timeMinutes),
      expenseTimeZone: timeZone,
      amount:
        searchParams.amount != null
          ? amountAsDecimal(Number(searchParams.amount) || 0, searchCurrency)
          : ('' as unknown as number),
      originalCurrency: searchOriginalCurrency,
      conversionRate: undefined,
      conversionType: settlementNeedsConversion ? 'EXCHANGE' : undefined,
      category: SETTLEMENT_CATEGORY_ID,
      paidBySplitMode: 'BY_AMOUNT' as const,
      paidByList: searchParams.from
        ? [
            {
              participant: searchParams.from,
              shares: amountAsDecimal(
                Number(searchParams.amount) || 0,
                searchCurrency,
              ),
            },
          ]
        : [],
      isMultiPayer: false,
      paidFor: searchParams.to
        ? [
            {
              participant: searchParams.to,
              shares: 1,
            },
          ]
        : [],
      splitMode: 'EVENLY' as const,
      documents: [],
      notes: '',
      recurrence: null,
      recurrenceRule: 'NONE',
      itemizedRemainder: {
        splitMode: 'EVENLY' as const,
        paidFor: group.participants.map(({ id }) => ({
          participant: id,
          shares: 1,
        })),
      },
    }
  }

  const nowTime = formatTimeMinutes(utcToWallTime(now, timeZone).timeMinutes)
  return {
    title: searchParams.title ?? '',
    expenseDay: searchParams.date?.slice(0, 10) ?? dateToIsoDay(today),
    expenseTime: nowTime,
    expenseTimeZone: timeZone,
    amount:
      searchParams.amount != null
        ? amountAsDecimal(Number(searchParams.amount) || 0, searchCurrency)
        : prefilledItems.length
          ? prefilledItems.reduce(
              (sum, item) =>
                sum + Number(item.unitPrice) * Number(item.quantity),
              0,
            )
          : ('' as unknown as number),
    originalCurrency: searchOriginalCurrency,
    conversionRate: undefined,
    conversionType: undefined,
    category: parseCategoryIdFromUrl(searchParams.categoryId),
    paidBySplitMode: 'BY_AMOUNT' as const,
    paidByList:
      prefilledPayer && searchParams.amount != null
        ? [
            {
              participant: prefilledPayer,
              shares: amountAsDecimal(
                Number(searchParams.amount) || 0,
                searchCurrency,
              ),
            },
          ]
        : defaultPaidByList,
    isMultiPayer: false,
    paidFor: prefilledParticipants.length
      ? prefilledParticipants.map((participant) => ({ participant, shares: 1 }))
      : defaultSplittingOptions.paidFor,
    splitMode: hasPrefilledItemSplits
      ? ('ITEMIZED' as const)
      : prefilledParticipants.length
        ? ('EVENLY' as const)
        : defaultSplittingOptions.splitMode,
    documents: searchParams.imageUrl
      ? [
          {
            id: randomId(),
            url: searchParams.imageUrl,
            width: Number(searchParams.imageWidth),
            height: Number(searchParams.imageHeight),
          },
        ]
      : [],
    notes: '',
    recurrence: null,
    recurrenceRule: 'NONE',
    items: prefilledItems,
    itemizedRemainder: {
      splitMode: 'EVENLY' as const,
      paidFor: group.participants.map(({ id }) => ({
        participant: id,
        shares: 1,
      })),
    },
  }
}
