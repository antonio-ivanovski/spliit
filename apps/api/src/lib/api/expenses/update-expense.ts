import type { Prisma } from '@spliit/db'
import { prisma } from '@spliit/db'
import {
  computePaidForFromItems,
  dateOnlyInTimeZone,
  getCurrency,
  utcToWallTime,
  wallTimeToUtc,
  type Expense,
} from '@spliit/domain'
import { env as jobsEnv } from '@spliit/jobs'

import { deleteS3Object } from '../../../routes/upload'
import { resolveConversion } from '../../expense-conversion'
import { resolveParticipantDisplayName } from '../../invitations'
import {
  buildExpenseActivityData,
  logActivity,
  planNotificationForActivity,
} from '../activities'
import { getApiBoss } from '../boss'
import {
  getAffectedParticipantIds,
  getExpenseChangeSummary,
  type ChangeContext,
} from '../expense-activity-diff'
import {
  buildRecurringTemplate,
  createSeriesForExpense,
  enqueueMaterialization,
  getApiBossForWrite,
  getExpenseRecurrence,
  rescheduleMaterialization,
  toRecurrenceConfig,
} from '../recurrence-series'
import {
  buildCatchUpSeedAfterReflow,
  computeNextMaterializationCursor,
  expectedOccurrenceDate,
  isOutsideTermination,
  isScheduleConfigEqual,
} from '../recurrence/reflow-series-from-anchor'
import { participantDisplayNameSelect } from '../selects/participant-display-name'
import { randomId } from '../shared'
import {
  futureRowAfterShape,
  futureRowBeforeShape,
  futureRowSnapshotSelect,
  sharedRecurrenceFromSeries,
} from './future-row-diff'
import {
  promoteExpenseDocuments,
  resolveCategory,
  toExpenseDomainShape,
} from './helpers'
import { getExpense } from './queries'

export async function updateExpense(
  groupId: string,
  expenseId: string,
  expense: Expense,
  actor: { accountId: string },
  options: {
    expectedVersion: number
    scope?: 'OCCURRENCE' | 'THIS_AND_FUTURE'
  },
) {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: { ledger: true },
  })
  if (!group || !group.ledgerId) throw new Error(`Invalid group ID: ${groupId}`)

  const existingExpense = await getExpense(groupId, expenseId)
  if (!existingExpense) throw new Error(`Invalid expense ID: ${expenseId}`)

  const preserveRecurringCalendarDates =
    options?.scope === 'THIS_AND_FUTURE' &&
    existingExpense.recurringSeriesId !== null &&
    existingExpense.recurrenceSequence !== null

  const incomingExpenseDate = new Date(expense.expenseDate)
  const incomingTimeZone = expense.expenseTimeZone
  const incomingWall = utcToWallTime(incomingExpenseDate, incomingTimeZone)
  const existingExpenseTimeZone = existingExpense.expenseTimeZone
  const existingWall = utcToWallTime(
    new Date(existingExpense.expenseDate),
    existingExpenseTimeZone,
  )
  const resolvedExpenseTimeZone = incomingTimeZone
  const resolvedWallDate = preserveRecurringCalendarDates
    ? new Date(
        `${utcToWallTime(new Date(existingExpense.expenseDate), existingExpenseTimeZone).dateIso}T00:00:00.000Z`,
      )
    : dateOnlyInTimeZone(incomingExpenseDate, incomingTimeZone)
  const resolvedWallIso = resolvedWallDate.toISOString().slice(0, 10)
  const resolvedExpenseDate = preserveRecurringCalendarDates
    ? wallTimeToUtc(
        resolvedWallIso,
        incomingWall.timeMinutes,
        resolvedExpenseTimeZone,
      )
    : incomingExpenseDate
  const timingChanged =
    incomingWall.timeMinutes !== existingWall.timeMinutes ||
    incomingTimeZone !== existingExpenseTimeZone

  // UTC convention: pass the instant Date so `toIsoDate` derives the UTC
  // date, matching create/CSV/group-import/web-preview. `resolvedWallIso`
  // stays wall-based for calendar dates below.
  const conversion = await resolveConversion(expense, {
    ledgerCurrency: group.ledger.currencyCode ?? null,
    expenseDate: resolvedExpenseDate,
  })

  const expenseAmount = conversion.ledgerAmountMinor

  const participants = await prisma.ledgerParticipant.findMany({
    where: {
      ledgerId: group.ledgerId,
      removedAt: null,
      OR: [
        { groupMemberId: { not: null } },
        { invitations: { some: { status: 'PENDING' } } },
        { kind: 'UNLINKED_PARTICIPANT' },
      ],
    },
    select: participantDisplayNameSelect({ pendingInvitationsOnly: true }),
  })
  const participantIds = new Set(participants.map((p) => p.id))
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

  // Build participant name map for change formatting.
  const participantNameMap = new Map<string, string>()
  for (const p of participants) {
    participantNameMap.set(p.id, resolveParticipantDisplayName(p))
  }

  const changeCtx: ChangeContext = {
    getParticipantName: (id: string) => participantNameMap.get(id) ?? id,
    getCategoryName: (id: string) => resolveCategory(id).name,
    formatCurrencyCents: (cents, currency) => {
      const code =
        currency ?? group.ledger.currencyCode ?? group.ledger.currency
      const currencyDef = code ? getCurrency(code) : undefined
      const digits = currencyDef?.decimal_digits ?? 2
      const sign = cents < 0 ? '-' : ''
      const abs = Math.abs(cents)
      const scale = 10 ** digits
      const whole = Math.floor(abs / scale)
      if (digits === 0) return `${sign}${code} ${whole}`
      const frac = abs % scale
      return `${sign}${code} ${whole}.${frac.toString().padStart(digits, '0')}`
    },
    ledgerCurrencyCode: group.ledger.currencyCode ?? group.ledger.currency,
  }

  const expenseDateStr = resolvedWallIso

  const documents = await promoteExpenseDocuments(expense.documents)
  // SAFETY: domain Expense recurrence subset
  const recurrence = getExpenseRecurrence(
    expense as unknown as { recurrence?: unknown; recurrenceRule?: string },
    resolvedWallDate,
  )
  const legacyRecurrenceRule = (
    recurrence?.frequency === 'DAILY' ||
    recurrence?.frequency === 'WEEKLY' ||
    recurrence?.frequency === 'MONTHLY' ||
    recurrence?.frequency === 'YEARLY'
      ? recurrence.frequency
      : 'NONE'
  ) as Expense['recurrenceRule']
  const queueBoss =
    recurrence && jobsEnv.JOBS_ENABLED ? await getApiBossForWrite() : undefined

  // Diff against the post-resolution shape so ledger `amount` and
  // conversion fields are compared in the same units as the stored row.
  const resolvedExpense = {
    ...expense,
    recurrenceRule: legacyRecurrenceRule,
    amount: expenseAmount,
    conversion: conversion.conversionSource
      ? conversion.conversionSource === 'CUSTOM'
        ? ({
            type: 'custom' as const,
            currency: conversion.originalCurrency ?? '',
            rate: conversion.conversionRate ?? 1,
          } as const)
        : ({
            type: 'exchange' as const,
            currency: conversion.originalCurrency ?? '',
          } as const)
      : undefined,
    originalAmount: conversion.originalAmount ?? undefined,
    originalCurrency: conversion.originalCurrency ?? undefined,
    conversionRate: conversion.conversionRate ?? undefined,
    conversionSource: conversion.conversionSource,
  }

  const changeSummary = getExpenseChangeSummary(
    toExpenseDomainShape(existingExpense),
    resolvedExpense,
    changeCtx,
  )

  // Union of old + new participant IDs so update emails reach everyone
  // who was on the expense, including those removed by the change.
  const affectedParticipantIds = [
    ...getAffectedParticipantIds({
      oldExpense: toExpenseDomainShape(existingExpense),
      newExpense: expense,
    }),
  ]

  const removedDocuments = existingExpense.documents.filter(
    (existingDoc) => !documents.some((doc) => doc.id === existingDoc.id),
  )
  // Populated during THIS_AND_FUTURE schedule reflow when future rows are dropped.
  const reflowDeletedDocumentUrls: string[] = []
  // S3 document deletions moved to post-transaction best-effort cleanup below

  // Handle items: delete stale, create/update incoming
  const incomingItems = expense.items ?? []
  const existingItems = existingExpense.items ?? []

  const isLeavingItemized =
    existingExpense.splitMode === 'ITEMIZED' &&
    expense.splitMode !== 'ITEMIZED' &&
    existingItems.some((i) => i.paidFor.length > 0)

  const incomingIds = new Set(
    incomingItems.filter((i) => i.id).map((i) => i.id!),
  )
  const existingItemIds = new Set(existingItems.map((i) => i.id))
  const itemsToDelete = existingItems.filter((i) => !incomingIds.has(i.id))

  const existingSeries = existingExpense.recurringSeries
  const detachRecurrence = existingSeries !== null && recurrence === null
  const isDeleteRecurrence =
    detachRecurrence && options?.scope === 'THIS_AND_FUTURE'
  const isUpdateRecurrence = existingSeries !== null && recurrence !== null
  const isCreateRecurrence = existingSeries === null && recurrence !== null

  const expensePaidFor =
    expense.splitMode === 'ITEMIZED'
      ? computePaidForFromItems(
          expense.items ?? [],
          [...participantIds],
          conversion.originalAmount ?? expenseAmount,
          expense.itemizedRemainder,
          expenseId,
        ).paidFor
      : expense.paidFor

  const recurrenceTemplate = recurrence
    ? buildRecurringTemplate({
        expense: { ...expense, paidForOverride: expensePaidFor },
        conversion,
      })
    : null

  // Exchange rates are date-sensitive. Resolve them before entering the
  // write transaction, then apply the resulting snapshots while the series
  // row is locked. Newly materialized rows will use the updated series
  // template after this transaction commits.
  const scheduleChanged =
    isUpdateRecurrence &&
    recurrence !== null &&
    existingSeries !== null &&
    !isScheduleConfigEqual(toRecurrenceConfig(existingSeries), recurrence)
  const reflowAnchorDate = resolvedWallDate
  const reflowAnchorSequence = existingExpense.recurrenceSequence ?? 1
  const materializedFutureRows =
    isUpdateRecurrence && options?.scope === 'THIS_AND_FUTURE'
      ? await prisma.expense.findMany({
          where: {
            recurringSeriesId: existingSeries!.id,
            recurrenceSequence: {
              gte: existingExpense.recurrenceSequence ?? 1,
            },
          },
          orderBy: { recurrenceSequence: 'asc' },
          select: {
            id: true,
            expenseDate: true,
            expenseTimeZone: true,
            recurrenceSequence: true,
            title: true,
            amount: true,
            originalCurrency: true,
            originalAmount: true,
            conversionRate: true,
            conversionSource: true,
            documents: { select: { url: true } },
            paidByList: { select: { ledgerParticipantId: true } },
            paidFor: { select: { ledgerParticipantId: true } },
            items: {
              select: {
                paidFor: { select: { ledgerParticipantId: true } },
              },
            },
            itemizedRemainder: {
              select: {
                paidFor: { select: { ledgerParticipantId: true } },
              },
            },
          },
        })
      : []
  const expectedDatesByRowId = new Map<string, Date>()
  const rowsToDeleteIds = new Set<string>()
  if (scheduleChanged && recurrence) {
    for (const row of materializedFutureRows) {
      if (row.id === expenseId) continue
      const seq = row.recurrenceSequence ?? reflowAnchorSequence
      const expected = expectedOccurrenceDate(
        reflowAnchorDate,
        recurrence,
        reflowAnchorSequence,
        seq,
      )
      if (isOutsideTermination(recurrence, seq, expected)) {
        rowsToDeleteIds.add(row.id)
      } else {
        expectedDatesByRowId.set(row.id, expected)
      }
    }
  }
  const materializedConversions = new Map<
    string,
    Awaited<ReturnType<typeof resolveConversion>>
  >()
  if (recurrenceTemplate) {
    const conversionInput =
      recurrenceTemplate.conversionSource === 'CUSTOM'
        ? {
            type: 'custom' as const,
            currency: recurrenceTemplate.originalCurrency ?? '',
            rate: recurrenceTemplate.conversionRate ?? 1,
          }
        : recurrenceTemplate.conversionSource === 'EXCHANGE'
          ? {
              type: 'exchange' as const,
              currency: recurrenceTemplate.originalCurrency ?? '',
            }
          : undefined
    // UTC convention (matching create/CSV/group-import): resolve FX from the
    // instant that will be persisted so `toIsoDate` derives the UTC date, not
    // the wall-midnight calendar date. Redated rows use the reanchored
    // occurrence instant; untouched rows use the stored instant.
    // `exchangeRateLookupDate` clamping to today still applies inside
    // `resolveConversion`. Terminal status is re-checked under lock below;
    // this pre-transaction snapshot only selects which instant to look up.
    const preTerminal =
      existingSeries?.status === 'CANCELLED' ||
      existingSeries?.status === 'COMPLETED'
    for (const row of materializedFutureRows) {
      if (rowsToDeleteIds.has(row.id)) continue
      const willRedate = (scheduleChanged && !preTerminal) || timingChanged
      const expenseDateForRate = willRedate
        ? wallTimeToUtc(
            (
              expectedDatesByRowId.get(row.id) ??
              dateOnlyInTimeZone(row.expenseDate, row.expenseTimeZone)
            )
              .toISOString()
              .slice(0, 10),
            incomingWall.timeMinutes,
            resolvedExpenseTimeZone,
          )
        : row.expenseDate
      materializedConversions.set(
        row.id,
        await resolveConversion(
          { amount: recurrenceTemplate.amount, conversion: conversionInput },
          {
            ledgerCurrency: group.ledger.currencyCode ?? null,
            expenseDate: expenseDateForRate,
          },
        ),
      )
    }
  }

  // Transaction: activity log + all DB writes are atomic
  const boss = await getApiBoss()
  const { updatedExpense } = await prisma.$transaction(async (tx) => {
    const claimed = await tx.expense.updateMany({
      where: {
        id: expenseId,
        ledgerId: group.ledgerId,
        version: options.expectedVersion,
      },
      data: { version: { increment: 1 } },
    })
    if (claimed.count === 0) {
      throw new ExpenseVersionConflictError()
    }

    if (existingExpense.recurringSeriesId) {
      await tx.$queryRaw`SELECT id FROM "RecurringExpenseSeries" WHERE id = ${existingExpense.recurringSeriesId} FOR UPDATE`
      if (options?.scope === 'THIS_AND_FUTURE' && existingSeries !== null) {
        const lockedSeries = await tx.recurringExpenseSeries.findUnique({
          where: { id: existingSeries.id },
          select: { version: true },
        })
        if (!lockedSeries || lockedSeries.version !== existingSeries.version) {
          throw new Error(
            'Recurring expense series changed while it was being updated; retry the update',
          )
        }
      }
    }
    type ChangedRow = {
      activity: Awaited<ReturnType<typeof logActivity>>
      expenseId: string
      scheduledDate: string
      participantIds: string[]
      data: ReturnType<typeof buildExpenseActivityData>
    }
    const changedRows: ChangedRow[] = []

    if (changeSummary) {
      const activity = await logActivity(
        groupId,
        {
          type: 'EXPENSE_UPDATED',
          actor: { type: 'ACCOUNT', id: actor.accountId },
          subject: { type: 'EXPENSE', id: expenseId },
          data: buildExpenseActivityData({
            summary: expense.title,
            title: expense.title,
            amount: expenseAmount,
            currencyCode: conversion.originalCurrency,
            date: expenseDateStr,
            changedFields: changeSummary.changedFields,
            changes: changeSummary.changes,
            affectedParticipants: affectedParticipantIds,
            originalAmount: conversion.originalAmount ?? undefined,
            conversionRate: conversion.conversionRate ?? undefined,
            conversionSource: conversion.conversionSource,
            ledgerCurrencyCode: group.ledger.currencyCode ?? null,
          }),
        },
        tx,
        group.ledgerId,
      )
      changedRows.push({
        activity,
        expenseId,
        scheduledDate: expenseDateStr,
        participantIds: affectedParticipantIds,
        data: activity.data as ReturnType<typeof buildExpenseActivityData>,
      })
    }

    if (isLeavingItemized) {
      await tx.expenseItemPaidFor.deleteMany({
        where: { expenseItem: { expenseId } },
      })
    }

    if (itemsToDelete.length > 0) {
      await tx.expenseItem.deleteMany({
        where: { id: { in: itemsToDelete.map((i) => i.id) } },
      })
    }

    for (const item of incomingItems) {
      if (item.id && existingItemIds.has(item.id)) {
        await tx.expenseItem.update({
          where: { id: item.id },
          data: {
            title: item.title,
            unitPrice: item.unitPrice,
            quantity: item.quantity,
            amount: item.amount,
            splitMode: item.splitMode,
          },
        })
        if (!isLeavingItemized) {
          await tx.expenseItemPaidFor.deleteMany({
            where: { expenseItemId: item.id },
          })
          if (item.paidFor.length > 0) {
            await tx.expenseItemPaidFor.createMany({
              data: item.paidFor.map((pf) => ({
                expenseItemId: item.id!,
                ledgerParticipantId: pf.participant,
                shares: pf.shares,
              })),
            })
          }
        }
      } else {
        const itemId = item.id ?? randomId()
        await tx.expenseItem.create({
          data: {
            id: itemId,
            expenseId,
            title: item.title,
            unitPrice: item.unitPrice,
            quantity: item.quantity,
            amount: item.amount,
            splitMode: item.splitMode,
            ...(!isLeavingItemized && item.paidFor.length > 0
              ? {
                  paidFor: {
                    createMany: {
                      data: item.paidFor.map((pf) => ({
                        ledgerParticipantId: pf.participant,
                        shares: pf.shares,
                      })),
                    },
                  },
                }
              : {}),
          },
        })
      }
    }

    // Only manage `ExpenseItemizedRemainder` rows for ITEMIZED expenses.
    // The remainder is semantically meaningless otherwise, and we
    // proactively delete any pre-existing rows so leftover artifacts from
    // past (buggy) edits are cleaned up the next time the expense is
    // updated.
    if (expense.splitMode === 'ITEMIZED') {
      await tx.expenseItemizedRemainder.deleteMany({
        where: { expenseId },
      })
      if (expense.itemizedRemainder) {
        await tx.expenseItemizedRemainder.create({
          data: {
            expenseId,
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
        })
      }
    }

    const updated = await tx.expense.update({
      where: { id: expenseId },
      data: {
        expenseDate: resolvedExpenseDate,
        expenseTimeZone: resolvedExpenseTimeZone,
        amount: expenseAmount,
        originalAmount: conversion.originalAmount,
        originalCurrency: conversion.originalCurrency,
        conversionRate: conversion.conversionRate,
        conversionSource: conversion.conversionSource,
        title: expense.title,
        categoryId: expense.category,
        paidBySplitMode: expense.paidBySplitMode,
        ...(expense.paidByList.length > 0
          ? {
              paidByList: {
                create: expense.paidByList
                  .filter(
                    (p) =>
                      !existingExpense.paidByList.some(
                        (pb) => pb.ledgerParticipantId === p.participant,
                      ),
                  )
                  .map((paidBy) => ({
                    ledgerParticipantId: paidBy.participant,
                    shares: paidBy.shares,
                  })),
                update: expense.paidByList.map((paidBy) => ({
                  where: {
                    expenseId_ledgerParticipantId: {
                      expenseId,
                      ledgerParticipantId: paidBy.participant,
                    },
                  },
                  data: {
                    shares: paidBy.shares,
                  },
                })),
                deleteMany: existingExpense.paidByList
                  .filter(
                    (paidBy) =>
                      !expense.paidByList.some(
                        (p) => p.participant === paidBy.ledgerParticipantId,
                      ),
                  )
                  .map(({ ledgerParticipantId, shares }) => ({
                    ledgerParticipantId,
                    shares,
                  })),
              },
            }
          : {}),
        splitMode: expense.splitMode,
        paidFor: {
          create: expensePaidFor
            .filter(
              (p) =>
                !existingExpense.paidFor.some(
                  (pp) => pp.ledgerParticipantId === p.participant,
                ),
            )
            .map((paidFor) => ({
              ledgerParticipantId: paidFor.participant,
              shares: paidFor.shares,
            })),
          update: expensePaidFor.map((paidFor) => ({
            where: {
              expenseId_ledgerParticipantId: {
                expenseId,
                ledgerParticipantId: paidFor.participant,
              },
            },
            data: {
              shares: paidFor.shares,
            },
          })),
          deleteMany: existingExpense.paidFor.filter(
            (paidFor) =>
              !expensePaidFor.some(
                (pf) => pf.participant === paidFor.ledgerParticipantId,
              ),
          ),
        },
        ...(detachRecurrence
          ? {
              recurringSeries: { disconnect: true },
              recurrenceSequence: null,
            }
          : {}),
        documents: {
          connectOrCreate: documents.map((doc) => ({
            create: { ...doc, ledgerId: group.ledgerId },
            where: { id: doc.id },
          })),
          deleteMany: existingExpense.documents
            .filter(
              (existingDoc) =>
                !documents.some((doc) => doc.id === existingDoc.id),
            )
            .map((doc) => ({
              id: doc.id,
            })),
        },
        notes: expense.notes,
      },
    })

    if (isDeleteRecurrence && existingSeries) {
      await tx.recurringExpenseSeries.update({
        where: { id: existingSeries.id },
        data: {
          status: 'CANCELLED',
          catchUpBatch: null,
          version: { increment: 1 },
        },
      })
    } else if ((isCreateRecurrence || isUpdateRecurrence) && recurrence) {
      const seriesId = existingSeries?.id ?? randomId()
      const template = recurrenceTemplate!
      if (!existingSeries) {
        const wallForAnchor = utcToWallTime(
          resolvedExpenseDate,
          resolvedExpenseTimeZone,
        )
        await createSeriesForExpense({
          tx,
          seriesId,
          ledgerId: group.ledgerId,
          // Converting an existing expense into a series must not transfer
          // ownership when an admin edits a member-created expense.
          creatorAccountId:
            existingExpense.createdByAccountId ?? actor.accountId,
          timeZone: resolvedExpenseTimeZone,
          anchorTimeMinutes: wallForAnchor.timeMinutes,
          anchorDate: resolvedWallDate,
          config: recurrence,
          template,
          boss: queueBoss,
        })
        await tx.expense.update({
          where: { id: expenseId },
          data: { recurringSeriesId: seriesId, recurrenceSequence: 1 },
        })
      } else if (options?.scope === 'THIS_AND_FUTURE') {
        const anchorSequence = reflowAnchorSequence
        const anchorDate = reflowAnchorDate
        // `occurrencesCreated` is authoritative and monotonic. Do not infer
        // progress from surviving expense rows: occurrence-only deletion can
        // leave sequence gaps, and this-and-future delete-only intentionally
        // removes later rows while keeping the series active.
        const seriesProgress = await tx.recurringExpenseSeries.findUnique({
          where: { id: existingSeries.id },
          select: { occurrencesCreated: true, status: true },
        })
        if (!seriesProgress) throw new Error('Recurring series not found')
        const maxSequence = Math.max(
          anchorSequence,
          seriesProgress.occurrencesCreated,
        )
        const { nextOrdinal, nextOccurrenceDate, completed } =
          computeNextMaterializationCursor({
            anchorDate,
            anchorSequence,
            maxSequence,
            config: recurrence,
          })
        const terminalStatus =
          seriesProgress.status === 'CANCELLED' ||
          seriesProgress.status === 'COMPLETED'
            ? seriesProgress.status
            : null
        // Preserve the original terminal status unconditionally.
        // A cancelled series must never become completed, and vice versa.
        const nextStatus = terminalStatus
          ? terminalStatus
          : completed
            ? ('COMPLETED' as const)
            : ('ACTIVE' as const)
        // When the series is already terminal, only update template
        // fields and version — scheduling metadata must not change.
        const terminal = terminalStatus !== null
        const catchUpBatch =
          !terminal && scheduleChanged
            ? buildCatchUpSeedAfterReflow({
                seriesId: existingSeries.id,
                anchorDate,
                nextOccurrenceDate,
                completed,
                config: recurrence,
                maxSequence,
                timeZone: timingChanged
                  ? resolvedExpenseTimeZone
                  : existingSeries.timeZone,
              })
            : null
        const reanchorMinutes = incomingWall.timeMinutes
        await tx.recurringExpenseSeries.update({
          where: { id: existingSeries.id },
          data: {
            ...(terminal
              ? {}
              : {
                  frequency: recurrence.frequency,
                  interval: recurrence.interval,
                  endType: recurrence.end.type,
                  occurrenceLimit:
                    recurrence.end.type === 'COUNT'
                      ? recurrence.end.count
                      : null,
                  endDate:
                    recurrence.end.type === 'DATE'
                      ? recurrence.end.endDate
                      : null,
                  anchorDate,
                  anchorSequence,
                  anchorTimeMinutes: reanchorMinutes,
                  timeZone: resolvedExpenseTimeZone,
                  occurrencesCreated: maxSequence,
                  nextOccurrenceDate,
                  nextOccurrenceOrdinal: nextOrdinal,
                }),
            status: nextStatus,
            version: { increment: 1 },
            template,
            catchUpBatch: catchUpBatch ?? null,
          },
        })

        // Schedule reflow: delete future rows outside the new termination.
        if (!terminal && scheduleChanged && rowsToDeleteIds.size > 0) {
          const toDelete = materializedFutureRows.filter((r) =>
            rowsToDeleteIds.has(r.id),
          )
          for (const row of toDelete) {
            const rowParticipants = new Set<string>()
            for (const pb of row.paidByList)
              rowParticipants.add(pb.ledgerParticipantId)
            for (const pf of row.paidFor)
              rowParticipants.add(pf.ledgerParticipantId)
            for (const item of row.items) {
              for (const ipf of item.paidFor)
                rowParticipants.add(ipf.ledgerParticipantId)
            }
            if (row.itemizedRemainder) {
              for (const rpf of row.itemizedRemainder.paidFor)
                rowParticipants.add(rpf.ledgerParticipantId)
            }
            const rowDateStr = utcToWallTime(
              row.expenseDate,
              row.expenseTimeZone,
            ).dateIso
            await logActivity(
              groupId,
              {
                type: 'EXPENSE_DELETED',
                actor: { type: 'ACCOUNT', id: actor.accountId },
                subject: { type: 'EXPENSE', id: row.id },
                data: buildExpenseActivityData({
                  summary: row.title,
                  title: row.title,
                  amount: row.amount,
                  currencyCode: row.originalCurrency ?? null,
                  date: rowDateStr,
                  affectedParticipants: [...rowParticipants],
                  originalAmount: row.originalAmount ?? undefined,
                  conversionRate: row.conversionRate
                    ? Number(row.conversionRate)
                    : undefined,
                  conversionSource: row.conversionSource as
                    | 'EXCHANGE'
                    | 'CUSTOM'
                    | null,
                  ledgerCurrencyCode: group.ledger.currencyCode ?? null,
                }),
              },
              tx,
              group.ledgerId,
            )
            for (const doc of row.documents) {
              reflowDeletedDocumentUrls.push(doc.url)
            }
          }
          await tx.expense.deleteMany({
            where: {
              id: { in: [...rowsToDeleteIds] },
              recurringSeriesId: existingSeries.id,
            },
          })
        }

        const survivingFutureRows = materializedFutureRows.filter(
          (r) => r.id !== expenseId && !rowsToDeleteIds.has(r.id),
        )
        const futureRowIds = survivingFutureRows.map((r) => r.id)
        const futureRowSnapshots =
          futureRowIds.length > 0
            ? await tx.expense.findMany({
                where: { id: { in: futureRowIds } },
                select: futureRowSnapshotSelect,
              })
            : []
        const futureRowSnapshotMap = new Map(
          futureRowSnapshots.map((r) => [r.id, r]),
        )
        // Series recurrence is identical on both sides of the per-row diff
        // for template-only edits. On schedule reflow, surface date changes
        // via expenseDate while keeping recurrence identity shared.
        const shared = sharedRecurrenceFromSeries(
          scheduleChanged
            ? {
                ...existingSeries,
                frequency: recurrence.frequency,
                interval: recurrence.interval,
                endType: recurrence.end.type,
                occurrenceLimit:
                  recurrence.end.type === 'COUNT' ? recurrence.end.count : null,
                endDate:
                  recurrence.end.type === 'DATE'
                    ? recurrence.end.endDate
                    : null,
              }
            : existingSeries,
        )
        for (const row of survivingFutureRows) {
          const rowConv = materializedConversions.get(row.id) ?? conversion
          const nextDate = expectedDatesByRowId.get(row.id)
          const occurrenceDate =
            scheduleChanged && !terminal && nextDate
              ? nextDate
              : dateOnlyInTimeZone(row.expenseDate, row.expenseTimeZone)
          const nextExpenseDate =
            (scheduleChanged && !terminal) || timingChanged
              ? wallTimeToUtc(
                  occurrenceDate.toISOString().slice(0, 10),
                  reanchorMinutes,
                  resolvedExpenseTimeZone,
                )
              : undefined
          await updateMaterializedOccurrence(
            tx,
            row,
            template,
            rowConv,
            nextExpenseDate,
            timingChanged ? resolvedExpenseTimeZone : undefined,
          )
          const before = futureRowSnapshotMap.get(row.id)
          if (!before) continue
          const beforeShape = futureRowBeforeShape(before, shared)
          const afterShape = futureRowAfterShape({
            row: before,
            template,
            rowConv,
            shared,
            expenseDate:
              scheduleChanged && !terminal ? nextExpenseDate : undefined,
            expenseTimeZone: timingChanged
              ? resolvedExpenseTimeZone
              : undefined,
          })
          const rowChangeSummary = getExpenseChangeSummary(
            beforeShape,
            afterShape,
            changeCtx,
          )
          if (!rowChangeSummary) continue
          const rowDateStr = nextExpenseDate
            ? utcToWallTime(
                nextExpenseDate,
                timingChanged ? resolvedExpenseTimeZone : row.expenseTimeZone,
              ).dateIso
            : utcToWallTime(row.expenseDate, row.expenseTimeZone).dateIso
          const rowParticipantIds = [
            ...getAffectedParticipantIds({
              oldExpense: beforeShape,
              newExpense: afterShape,
            }),
          ]
          const rowActivityData = buildExpenseActivityData({
            summary: template.title,
            title: template.title,
            amount: rowConv.ledgerAmountMinor,
            currencyCode: rowConv.originalCurrency,
            date: rowDateStr,
            changedFields: rowChangeSummary.changedFields,
            changes: rowChangeSummary.changes,
            affectedParticipants: rowParticipantIds,
            originalAmount: rowConv.originalAmount ?? undefined,
            conversionRate: rowConv.conversionRate ?? undefined,
            conversionSource: rowConv.conversionSource,
            ledgerCurrencyCode: group.ledger.currencyCode ?? null,
          })
          const rowAct = await logActivity(
            groupId,
            {
              type: 'EXPENSE_UPDATED',
              actor: { type: 'ACCOUNT', id: actor.accountId },
              subject: { type: 'EXPENSE', id: row.id },
              data: rowActivityData,
            },
            tx,
            group.ledgerId,
          )
          changedRows.push({
            activity: rowAct,
            expenseId: row.id,
            scheduledDate: rowDateStr,
            participantIds: rowParticipantIds,
            data: rowActivityData,
          })
        }
        if (!completed && !terminalStatus) {
          const nextPayload = {
            seriesId: existingSeries.id,
            sequence: maxSequence + 1,
            occurrenceDate: nextOccurrenceDate,
          }
          if (timingChanged && !scheduleChanged) {
            await rescheduleMaterialization(tx, nextPayload, queueBoss)
          } else {
            await enqueueMaterialization(tx, nextPayload, queueBoss)
          }
        }
      }
    }
    if (changedRows.length === 1) {
      await planNotificationForActivity(
        tx,
        changedRows[0]!.activity,
        {},
        { boss },
      )
    } else if (changedRows.length > 1) {
      const sortedDates = changedRows.map((row) => row.scheduledDate).sort()
      const unionParticipantIds: string[] = []
      for (const row of changedRows) {
        for (const participantId of row.participantIds) {
          if (!unionParticipantIds.includes(participantId)) {
            unionParticipantIds.push(participantId)
          }
        }
      }
      const series = existingExpense.recurringSeriesId
        ? await tx.recurringExpenseSeries.findUnique({
            where: { id: existingExpense.recurringSeriesId },
            select: {
              frequency: true,
              interval: true,
              endType: true,
              occurrenceLimit: true,
              endDate: true,
            },
          })
        : null
      await planNotificationForActivity(
        tx,
        changedRows[0]!.activity,
        {
          subject: { type: 'EXPENSE', id: expenseId },
          data: {
            kind: 'recurring_expense_summary',
            summary: `${changedRows.length} expenses updated`,
            title: updated.title,
            count: changedRows.length,
            startDate: sortedDates[0] ?? expenseDateStr,
            endDate: sortedDates.at(-1) ?? expenseDateStr,
            affectedParticipants: unionParticipantIds,
            seriesId: existingExpense.recurringSeriesId ?? undefined,
            frequency: series?.frequency ?? undefined,
            interval: series?.interval ?? undefined,
            endType: series?.endType ?? undefined,
            occurrenceLimit: series?.occurrenceLimit ?? undefined,
            seriesEndDate:
              series?.endDate?.toISOString().slice(0, 10) ?? undefined,
            operation: 'update',
            stopped: false,
          },
        },
        { boss },
      )
    }
    return { updatedExpense: updated, changedRows }
  })

  // Best-effort S3 cleanup — errors are logged but not propagated so they
  // don't corrupt the perceived mutation outcome.
  for (const doc of removedDocuments) {
    try {
      await deleteS3Object(doc.url)
    } catch (err) {
      console.warn(`[expenses] failed to delete S3 object ${doc.url}:`, err)
    }
  }
  for (const url of reflowDeletedDocumentUrls) {
    try {
      await deleteS3Object(url)
    } catch (err) {
      console.warn(`[expenses] failed to delete S3 object ${url}:`, err)
    }
  }

  return updatedExpense
}

export class ExpenseVersionConflictError extends Error {
  constructor() {
    super('This expense changed while you were editing it')
    this.name = 'ExpenseVersionConflictError'
  }
}
/**
 * Replace the mutable template fields on a materialized occurrence. Recurrence
 * identity and documents intentionally remain untouched. Pass `expenseDate` /
 * `expenseDate` when a schedule reflow moves the occurrence.
 */
async function updateMaterializedOccurrence(
  tx: Prisma.TransactionClient,
  row: { id: string; expenseTimeZone: string },
  template: ReturnType<typeof buildRecurringTemplate>,
  conversion: {
    ledgerAmountMinor: number
    originalAmount: number | null
    originalCurrency: string | null
    conversionRate: number | null
    conversionSource: 'EXCHANGE' | 'CUSTOM' | null
  },
  expenseDate?: Date,
  expenseTimeZone?: string,
) {
  await tx.expenseItemizedRemainder.deleteMany({ where: { expenseId: row.id } })
  await tx.expense.update({
    where: { id: row.id },
    data: {
      version: { increment: 1 },
      ...(expenseDate ? { expenseDate } : {}),
      ...(expenseTimeZone ? { expenseTimeZone } : {}),
      amount: conversion.ledgerAmountMinor,
      originalAmount: conversion.originalAmount,
      originalCurrency: conversion.originalCurrency,
      conversionRate: conversion.conversionRate,
      conversionSource: conversion.conversionSource,
      title: template.title,
      categoryId: template.categoryId,
      paidBySplitMode: template.paidBySplitMode as never,
      splitMode: template.splitMode as never,
      notes: template.notes,
      paidByList: {
        deleteMany: {},
        createMany: { data: template.paidByList },
      },
      paidFor: {
        deleteMany: {},
        createMany: { data: template.paidFor },
      },
      items: {
        deleteMany: {},
        create: template.items.map((item) => ({
          id: randomId(),
          title: item.title,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          amount: item.amount,
          splitMode: item.splitMode as never,
          paidFor: { createMany: { data: item.paidFor } },
        })),
      },
    },
  })
  if (template.itemizedRemainder) {
    await tx.expenseItemizedRemainder.create({
      data: {
        expenseId: row.id,
        splitMode: template.itemizedRemainder.splitMode as never,
        paidFor: {
          createMany: { data: template.itemizedRemainder.paidFor },
        },
      },
    })
  }
}
