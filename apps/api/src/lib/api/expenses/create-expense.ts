import type { Expense as DbExpense, Prisma } from '@spliit/db'
import { prisma } from '@spliit/db'
import {
  calculateRecurrenceDate,
  computePaidForFromItems,
  dateOnlyInTimeZone,
  isSettlementCategory,
  toSecondPrecision,
  utcToWallTime,
  type Expense,
} from '@spliit/domain'
import { env as jobsEnv, type SpliitBoss } from '@spliit/jobs'

import {
  resolveConversion,
  type ConversionResolution,
} from '../../expense-conversion'
import {
  buildExpenseActivityData,
  logActivity,
  planNotificationForActivity,
} from '../activities'
import { getApiBoss } from '../boss'
import {
  buildRecurringTemplate,
  createSeriesForExpense,
  getApiBossForWrite,
  getExpenseRecurrence,
} from '../recurrence-series'
import { catchUpDueThrough } from '../recurrence/catch-up-date'
import { randomId } from '../shared'
import { promoteExpenseDocuments } from './helpers'

export type PreparedExpenseCreate = {
  conversion: ConversionResolution
  documents: Awaited<ReturnType<typeof promoteExpenseDocuments>>
  notificationBoss: SpliitBoss | null
  recurrenceBoss?: SpliitBoss
  /** Optional IDs allocated before opening the transaction for batch callers. */
  expenseId?: string
  activityId?: string
  itemIds?: string[]
  documentIds?: string[]
  /** Optional preallocated id for recurring-series creation in a batch. */
  recurringSeriesId?: string
}

/** Resolve network/object-store dependencies before an interactive transaction. */
export async function prepareExpenseCreate(
  expense: Expense,
  groupId: string,
  options: { prepareNotification?: boolean } = {},
): Promise<PreparedExpenseCreate> {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: { ledger: true },
  })
  if (!group?.ledgerId) throw new Error(`Invalid group ID: ${groupId}`)

  const rawExpenseDate = new Date(expense.expenseDate)
  const wallForFx0 = utcToWallTime(
    rawExpenseDate,
    expense.expenseTimeZone,
  ).dateIso
  const recurrence = getExpenseRecurrence(
    expense as unknown as { recurrence?: unknown; recurrenceRule?: string },
    new Date(`${wallForFx0}T00:00:00.000Z`),
  )
  // UTC convention: pass the instant Date so `toIsoDate` derives the UTC
  // date, matching the CSV/group-import batch builders and web preview.
  // `wallForFx0` below stays wall-based for recurrence calendar purposes.
  const [conversion, documents, notificationBoss, recurrenceBoss] =
    await Promise.all([
      resolveConversion(expense, {
        ledgerCurrency: group.ledger.currencyCode ?? null,
        expenseDate: rawExpenseDate,
      }),
      promoteExpenseDocuments(expense.documents),
      options.prepareNotification === false
        ? Promise.resolve(null)
        : getApiBoss(),
      recurrence && jobsEnv.JOBS_ENABLED
        ? getApiBossForWrite()
        : Promise.resolve(undefined),
    ])

  return { conversion, documents, notificationBoss, recurrenceBoss }
}

export async function createExpense(
  expense: Expense,
  groupId: string,
  actor: { accountId: string },
  options?: {
    assistantRequestId?: string
    /**
     * A server-resolved conversion sealed into an assistant confirmation. This
     * keeps the persisted conversion identical to the preview even if an
     * exchange-rate provider changes between preview and confirmation.
     */
    conversionResolution?: ConversionResolution
    /**
     * Aggregate itemized shares already normalized and sealed by the assistant
     * preview. Ordinary callers continue to use the canonical expense-id-seeded
     * calculation below.
     */
    itemizedPaidForResolution?: Expense['paidFor']
    prepared?: PreparedExpenseCreate
    tx?: Prisma.TransactionClient
    /** Internal batch-create controls used by the expense file importer. */
    batchContext?: {
      groupLockHeld: boolean
      visibleInGroupFeed: boolean
      suppressNotification: boolean
      /** Provenance for the side table (only present for file imports). */
      fileImport?: {
        provider: string
        importKey: string
        externalIdentityHash: string | null
        semanticHash: string
        rawHash: string
        importedByAccountId: string
      }
      /**
       * Participant ids already read under the caller's group lock in the same
       * transaction. Skips the per-row participant queries for batch callers;
       * ordinary creates always query fresh.
       */
      participants?: { active: string[]; removed: string[] }
    }
  },
): Promise<DbExpense> {
  const client = options?.tx ?? prisma
  const group = await client.group.findUnique({
    where: { id: groupId },
    include: { ledger: true },
  })
  if (!group || !group.ledgerId) throw new Error(`Invalid group ID: ${groupId}`)

  const ledgerId = group.ledgerId

  const resolvedExpenseDate = new Date(expense.expenseDate)
  // UTC convention (see above): pass the instant Date for FX lookup.
  const conversion =
    options?.conversionResolution ??
    options?.prepared?.conversion ??
    (await resolveConversion(expense, {
      ledgerCurrency: group.ledger.currencyCode ?? null,
      expenseDate: resolvedExpenseDate,
    }))

  const expenseAmount = conversion.ledgerAmountMinor

  const batchParticipants = options?.batchContext?.participants
  const activeParticipants = batchParticipants
    ? batchParticipants.active.map((id) => ({ id }))
    : await client.ledgerParticipant.findMany({
        where: {
          ledgerId,
          removedAt: null,
          OR: [
            { groupMemberId: { not: null } },
            { invitations: { some: { status: 'PENDING' } } },
            { kind: 'UNLINKED_PARTICIPANT' },
          ],
        },
        select: { id: true },
      })
  // Settlements may involve soft-removed participants who still appear in
  // balances. Keep them off new ordinary expenses, but allow settlements.
  const removedParticipants = isSettlementCategory(expense.category)
    ? batchParticipants
      ? batchParticipants.removed.map((id) => ({ id }))
      : await client.ledgerParticipant.findMany({
          where: { ledgerId, removedAt: { not: null } },
          select: { id: true },
        })
    : []
  const participantIds = new Set([
    ...activeParticipants.map((p) => p.id),
    ...removedParticipants.map((p) => p.id),
  ])

  for (const participantId of [
    ...expense.paidByList.map((p) => p.participant),
    ...expense.paidFor.map((p) => p.participant),
    ...(expense.items ?? []).flatMap((item) =>
      item.paidFor.map((p) => p.participant),
    ),
    ...(expense.itemizedRemainder?.paidFor ?? []).map((p) => p.participant),
  ]) {
    if (!participantIds.has(participantId)) {
      throw new Error(`Invalid participant ID: ${participantId}`)
    }
  }

  const expenseId = options?.prepared?.expenseId ?? randomId()

  const expenseDate = toSecondPrecision(new Date(expense.expenseDate))
  const expenseTimeZone = expense.expenseTimeZone
  const wallDate = dateOnlyInTimeZone(expenseDate, expenseTimeZone)
  const expenseDateStr = wallDate.toISOString().slice(0, 10)

  const recurrence = getExpenseRecurrence(
    expense as unknown as { recurrence?: unknown; recurrenceRule?: string },
    wallDate,
  )
  const isCreateRecurrence = recurrence !== null
  const queueBoss =
    options?.prepared?.recurrenceBoss ??
    (recurrence && jobsEnv.JOBS_ENABLED
      ? await getApiBossForWrite()
      : undefined)

  const documents =
    options?.prepared?.documents ??
    (await promoteExpenseDocuments(expense.documents))
  const itemizedPaidFor =
    expense.splitMode === 'ITEMIZED'
      ? (options?.itemizedPaidForResolution ??
        computePaidForFromItems(
          expense.items ?? [],
          [...participantIds],
          conversion.originalAmount ?? expenseAmount,
          expense.itemizedRemainder,
          expenseId,
        ).paidFor)
      : null
  const recurringPaidFor =
    expense.splitMode === 'ITEMIZED' ? itemizedPaidFor! : expense.paidFor

  const activityType = isCreateRecurrence
    ? ('RECURRING_EXPENSE_CREATED' as const)
    : ('EXPENSE_CREATED' as const)

  const recurringSeriesId = isCreateRecurrence
    ? (options?.prepared?.recurringSeriesId ?? randomId())
    : undefined
  const creatorTimeZone = expenseTimeZone
  const anchorTimeMinutes = utcToWallTime(
    expenseDate,
    expenseTimeZone,
  ).timeMinutes

  // When the anchor date is in the past and more than one occurrence is
  // immediately due, seed a catch-up batch so the worker produces one
  // combined summary instead of a schedule-created notification plus
  // individual catch-up notifications.
  let catchUpSeed:
    | {
        id: string
        startDate: string
        count: number
        mode: 'INITIAL_CREATION'
        dueThrough: string
      }
    | undefined
  if (recurrence && recurringSeriesId) {
    const todayIso = catchUpDueThrough(new Date(), creatorTimeZone)
    const today = new Date(`${todayIso}T00:00:00.000Z`)
    const occ2Date = calculateRecurrenceDate(
      wallDate,
      recurrence.frequency,
      recurrence.interval,
      2,
    )
    // Only seed a catch-up batch when occurrence two is both due and
    // permitted by the termination config. COUNT 1 schedules have no
    // occurrence two; DATE schedules where occurrence two falls after
    // the end date likewise have no second occurrence to catch up.
    const occ2Permitted =
      recurrence.end.type === 'INDEFINITE' ||
      (recurrence.end.type === 'COUNT' && recurrence.end.count >= 2) ||
      (recurrence.end.type === 'DATE' && occ2Date <= recurrence.end.endDate)
    if (occ2Date <= today && occ2Permitted) {
      catchUpSeed = {
        id: `recurring-catchup:${recurringSeriesId}:${expenseDateStr}`,
        startDate: expenseDateStr,
        count: 1,
        mode: 'INITIAL_CREATION',
        dueThrough: todayIso,
      }
    }
  }

  const boss = options?.prepared
    ? options.prepared.notificationBoss
    : await getApiBoss()
  const run = async (tx: Prisma.TransactionClient) => {
    if (!options?.batchContext?.groupLockHeld) {
      await tx.$queryRaw`SELECT id FROM "Group" WHERE id = ${groupId} FOR UPDATE`
    }
    const lockedGroup = await tx.group.findUnique({
      where: { id: groupId },
      select: { archived: true },
    })
    if (lockedGroup?.archived)
      throw new Error('This group is archived and no new expenses can be added')
    const activity = await logActivity(
      groupId,
      {
        id: options?.prepared?.activityId,
        type: activityType,
        actor: { type: 'ACCOUNT', id: actor.accountId },
        subject: { type: 'EXPENSE', id: expenseId },
        data: buildExpenseActivityData({
          summary: expense.title,
          title: expense.title,
          amount: expenseAmount,
          currencyCode: conversion.originalCurrency,
          date: expenseDateStr,
          originalAmount: conversion.originalAmount ?? undefined,
          conversionRate: conversion.conversionRate ?? undefined,
          conversionSource: conversion.conversionSource,
          ledgerCurrencyCode: group.ledger.currencyCode ?? null,
          ...(recurrence && recurringSeriesId
            ? {
                recurrence: {
                  seriesId: recurringSeriesId,
                  frequency: recurrence.frequency,
                  interval: recurrence.interval,
                  endType: recurrence.end.type,
                  occurrenceLimit:
                    recurrence.end.type === 'COUNT'
                      ? recurrence.end.count
                      : null,
                  endDate:
                    recurrence.end.type === 'DATE'
                      ? recurrence.end.endDate.toISOString().slice(0, 10)
                      : null,
                },
              }
            : {}),
        }),
        visibleInGroupFeed: options?.batchContext?.visibleInGroupFeed ?? true,
      },
      tx,
      ledgerId,
    )

    if (recurrence && recurringSeriesId) {
      await createSeriesForExpense({
        tx,
        seriesId: recurringSeriesId,
        ledgerId,
        creatorAccountId: actor.accountId,
        timeZone: creatorTimeZone,
        anchorTimeMinutes,
        anchorDate: wallDate,
        config: recurrence,
        template: buildRecurringTemplate({
          expense: { ...expense, paidForOverride: recurringPaidFor },
          conversion,
        }),
        boss: queueBoss,
        catchUpBatch: catchUpSeed,
      })
    }

    const createdExpense = await tx.expense.create({
      data: {
        id: expenseId,
        ledgerId,
        createdByAccountId: actor.accountId,
        expenseDate,
        expenseTimeZone,
        categoryId: expense.category,
        amount: expenseAmount,
        originalAmount: conversion.originalAmount,
        originalCurrency: conversion.originalCurrency,
        conversionRate: conversion.conversionRate,
        conversionSource: conversion.conversionSource,
        title: expense.title,
        paidBySplitMode: expense.paidBySplitMode,
        paidByList: {
          createMany: {
            data: expense.paidByList.map((paidBy) => ({
              ledgerParticipantId: paidBy.participant,
              shares: paidBy.shares,
            })),
          },
        },
        splitMode: expense.splitMode,
        ...(recurringSeriesId
          ? { recurringSeriesId, recurrenceSequence: 1 }
          : {}),
        paidFor: {
          createMany: {
            data:
              expense.splitMode === 'ITEMIZED'
                ? itemizedPaidFor!.map((p) => ({
                    ledgerParticipantId: p.participant,
                    shares: p.shares,
                  }))
                : expense.paidFor.map((paidFor) => ({
                    ledgerParticipantId: paidFor.participant,
                    shares: paidFor.shares,
                  })),
          },
        },
        items: {
          create: (expense.items ?? []).map((item, index) => ({
            // Item IDs are database-global. Batch callers may preallocate
            // them before opening the transaction; ordinary creates still get
            // fresh IDs here.
            id: options?.prepared?.itemIds?.[index] ?? randomId(),
            title: item.title,
            unitPrice: item.unitPrice,
            quantity: item.quantity,
            amount: item.amount,
            splitMode: item.splitMode,
            paidFor: {
              createMany: {
                data: item.paidFor.map((pf) => ({
                  ledgerParticipantId: pf.participant,
                  shares: pf.shares,
                })),
              },
            },
          })),
        },
        ...(expense.itemizedRemainder
          ? {
              itemizedRemainder: {
                create: {
                  splitMode: expense.itemizedRemainder.splitMode,
                  paidFor: {
                    createMany: {
                      data: expense.itemizedRemainder.paidFor.map((pf) => ({
                        ledgerParticipantId: pf.participant,
                        shares: pf.shares,
                      })),
                    },
                  },
                },
              },
            }
          : {}),
        documents: {
          createMany: {
            data: documents.map((doc, index) => ({
              id: options?.prepared?.documentIds?.[index] ?? randomId(),
              url: doc.url,
              fileName: doc.fileName,
              contentType: doc.contentType,
              width: doc.width,
              height: doc.height,
              ledgerId,
            })),
          },
        },
        notes: expense.notes,
        assistantRequestId: options?.assistantRequestId,
      },
    })
    if (options?.batchContext?.fileImport) {
      await tx.expenseFileImportSource.create({
        data: {
          expenseId: createdExpense.id,
          ledgerId,
          ...options.batchContext.fileImport,
        },
      })
    }

    if (!catchUpSeed && !options?.batchContext?.suppressNotification) {
      await planNotificationForActivity(
        tx,
        activity,
        isCreateRecurrence ? { includeActorAsRecipient: true } : {},
        { boss },
      )
    }

    return createdExpense
  }

  const createdExpense = options?.tx
    ? await run(options.tx)
    : await prisma.$transaction(run)

  return createdExpense
}
