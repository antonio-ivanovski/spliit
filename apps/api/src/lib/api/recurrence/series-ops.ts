import { prisma, RecurringExpenseSeriesStatus, type Prisma } from '@spliit/db'
import {
  calculateRecurrenceDate,
  wallTimeToUtc,
  type RecurrenceConfig,
  type RecurringExpenseTemplate,
} from '@spliit/domain'
import {
  bossTransactionDb,
  hasDeadLetteredMaterialization,
  JOB_NAMES,
  env as jobsEnv,
  materializationSingletonKey,
  sendJob,
  type SpliitBoss,
} from '@spliit/jobs'

import { getApiBossForWrite } from '../boss'
import { groupLedgerIdArchivedSelect } from '../selects/group-ledger-id-archived'
import {
  initialSeriesCompleted,
  recurrenceJobStartAfter,
  toSeriesFields,
} from './template'

/** Enqueue through a transaction-bound pg-boss adapter, preserving atomicity. */
export async function enqueueMaterialization(
  tx: Prisma.TransactionClient,
  payload: { seriesId: string; sequence: number; occurrenceDate: Date },
  existingBoss?: SpliitBoss,
) {
  if (!jobsEnv.JOBS_ENABLED) return null
  const scheduling = await tx.recurringExpenseSeries.findUnique({
    where: { id: payload.seriesId },
    select: { timeZone: true, anchorTimeMinutes: true },
  })
  if (!scheduling) return null
  const boss = existingBoss ?? (await getApiBossForWrite())
  const jobPayload = {
    seriesId: payload.seriesId,
    sequence: payload.sequence,
    occurrenceDate: payload.occurrenceDate.toISOString().slice(0, 10),
  }
  return sendJob(boss, JOB_NAMES.MATERIALIZE_RECURRING_EXPENSE, jobPayload, {
    deadLetter: `${JOB_NAMES.MATERIALIZE_RECURRING_EXPENSE}.dead-letter`,
    startAfter: recurrenceJobStartAfter(
      payload.occurrenceDate,
      scheduling.timeZone,
      scheduling.anchorTimeMinutes,
    ),
    singletonKey: materializationSingletonKey(jobPayload),
    db: bossTransactionDb(tx),
  })
}

/** Move the one pending occurrence when its wall-clock schedule changes. */
export async function rescheduleMaterialization(
  tx: Prisma.TransactionClient,
  payload: { seriesId: string; sequence: number; occurrenceDate: Date },
  existingBoss?: SpliitBoss,
) {
  if (!jobsEnv.JOBS_ENABLED) return null
  const scheduling = await tx.recurringExpenseSeries.findUnique({
    where: { id: payload.seriesId },
    select: { timeZone: true, anchorTimeMinutes: true },
  })
  if (!scheduling) return null
  const boss = existingBoss ?? (await getApiBossForWrite())
  const jobPayload = {
    seriesId: payload.seriesId,
    sequence: payload.sequence,
    occurrenceDate: payload.occurrenceDate.toISOString().slice(0, 10),
  }
  const singletonKey = materializationSingletonKey(jobPayload)
  const startAfter =
    recurrenceJobStartAfter(
      payload.occurrenceDate,
      scheduling.timeZone,
      scheduling.anchorTimeMinutes,
    ) ?? new Date()
  const result = await boss.upsert(
    JOB_NAMES.MATERIALIZE_RECURRING_EXPENSE,
    jobPayload,
    {
      singletonKey,
      startAfter,
      deadLetter: `${JOB_NAMES.MATERIALIZE_RECURRING_EXPENSE}.dead-letter`,
      db: bossTransactionDb(tx),
    },
  )
  return result.jobs[0] ?? null
}

export async function createSeriesForExpense(args: {
  tx: Prisma.TransactionClient
  seriesId: string
  ledgerId: string
  creatorAccountId: string
  timeZone: string
  anchorTimeMinutes: number
  anchorDate: Date
  config: RecurrenceConfig
  template: RecurringExpenseTemplate
  boss?: SpliitBoss
  /**
   * Seed a catch-up batch when past-dated creation makes multiple occurrences
   * immediately due. The worker appends later occurrences and emits one
   * combined summary instead of per-occurrence fan-out.
   */
  catchUpBatch?: {
    id: string
    startDate: string
    count: number
    mode: 'INITIAL_CREATION'
    dueThrough?: string
  }
  /** Import / backfill: how many historical occurrences already exist. */
  occurrencesCreated?: number
  /** Import / backfill: explicit next cursor (e.g. first date after today). */
  nextOccurrenceDate?: Date | null
  nextOccurrenceOrdinal?: number | null
}) {
  const timeZone = args.timeZone
  const nextOrdinal = args.nextOccurrenceOrdinal ?? 2
  const nextDate =
    args.nextOccurrenceDate ??
    calculateRecurrenceDate(
      args.anchorDate,
      args.config.frequency,
      args.config.interval,
      nextOrdinal,
    )
  const occurrencesCreated = args.occurrencesCreated ?? 1
  const fields = toSeriesFields(args.config)
  const completed =
    args.nextOccurrenceDate === null ||
    initialSeriesCompleted(fields, args.anchorDate, nextDate)
  const anchorTimeMinutes = args.anchorTimeMinutes
  const series = await args.tx.recurringExpenseSeries.create({
    data: {
      id: args.seriesId,
      ledgerId: args.ledgerId,
      creatorAccountId: args.creatorAccountId,
      timeZone,
      anchorTimeMinutes,
      frequency: fields.frequency,
      interval: fields.interval,
      anchorDate: args.anchorDate,
      nextOccurrenceDate: nextDate,
      nextOccurrenceOrdinal: nextOrdinal,
      endType: fields.endType,
      occurrenceLimit: fields.occurrenceLimit,
      endDate: fields.endDate,
      occurrencesCreated,
      status: completed
        ? RecurringExpenseSeriesStatus.COMPLETED
        : RecurringExpenseSeriesStatus.ACTIVE,
      template: args.template,
      ...(args.catchUpBatch
        ? {
            catchUpBatch: args.catchUpBatch as unknown as Prisma.InputJsonValue,
          }
        : {}),
    },
  })
  if (!completed) {
    await enqueueMaterialization(
      args.tx,
      {
        seriesId: series.id,
        sequence: occurrencesCreated + 1,
        occurrenceDate: nextDate,
      },
      args.boss,
    )
  }
  return series
}
export async function reconcileDueRecurringExpenses(
  boss: SpliitBoss,
  options: { cursor?: string } = {},
) {
  const pageSize = 250
  const enqueueBatchSize = 25
  const pausedGroups = await prisma.recurringExpenseSeries.findMany({
    where: {
      status: RecurringExpenseSeriesStatus.PAUSED,
      ledger: { group: { archived: false } },
    },
    select: { ledger: { select: { group: { select: { id: true } } } } },
  })
  const pausedGroupIds = new Set<string>()
  for (const row of Array.isArray(pausedGroups) ? pausedGroups : []) {
    if (row.ledger.group) pausedGroupIds.add(row.ledger.group.id)
  }
  for (const groupId of pausedGroupIds) {
    // Resume uses a transactional send that can hit a benign singleton collision;
    // skip this group so the rest of the reconcile still runs.
    try {
      await resumeRecurringExpenseSeries(groupId, boss)
    } catch (error) {
      console.warn(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'warning',
          component: 'recurring-reconcile',
          message: 'skipped paused-group resume, enqueue failed',
          groupId,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      continue
    }
  }
  const now = new Date()
  // DATE cursors are stored at UTC midnight. Querying through the next UTC
  // midnight covers dates already due in positive-offset timezones; each row
  // is then filtered by its actual zoned 15:00 execution instant.
  const safeDateHorizon = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  )
  const due = await prisma.recurringExpenseSeries.findMany({
    where: {
      status: RecurringExpenseSeriesStatus.ACTIVE,
      nextOccurrenceDate: { lte: safeDateHorizon },
      ledger: { group: { archived: false } },
    },
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    take: pageSize,
    orderBy: { id: 'asc' },
    select: {
      id: true,
      occurrencesCreated: true,
      nextOccurrenceDate: true,
      timeZone: true,
      anchorTimeMinutes: true,
    },
  })
  for (let index = 0; index < due.length; index += enqueueBatchSize) {
    const batch = due.slice(index, index + enqueueBatchSize)
    await Promise.all(
      batch.map(async (series) => {
        if (
          recurrenceJobStartAfter(
            series.nextOccurrenceDate,
            series.timeZone,
            series.anchorTimeMinutes,
            now,
          )
        )
          return
        const sequence = series.occurrencesCreated + 1
        const payload = {
          seriesId: series.id,
          sequence,
          occurrenceDate: series.nextOccurrenceDate.toISOString().slice(0, 10),
        }
        // A singleton collision means the job is already queued/retrying/active
        // and the handler is idempotent; skip this series so the rest of the batch still runs.
        try {
          if (await hasDeadLetteredMaterialization(boss, payload)) return
          await sendJob(
            boss,
            JOB_NAMES.MATERIALIZE_RECURRING_EXPENSE,
            payload,
            {
              singletonKey: materializationSingletonKey(payload),
              startAfter: recurrenceJobStartAfter(
                series.nextOccurrenceDate,
                series.timeZone,
                series.anchorTimeMinutes,
              ),
            },
          )
        } catch (error) {
          console.warn(
            JSON.stringify({
              timestamp: new Date().toISOString(),
              level: 'warning',
              component: 'recurring-reconcile',
              message: 'skipped due series, materialization enqueue failed',
              seriesId: series.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          )
          return
        }
      }),
    )
  }
  if (due.length === pageSize) {
    const cursor = due[due.length - 1]?.id
    if (cursor) {
      // A collision here means another reconcile is already handling this cursor page.
      try {
        await sendJob(
          boss,
          JOB_NAMES.RECONCILE_RECURRING_EXPENSES,
          { cursor },
          { singletonKey: `recurring-expense-reconciliation:${cursor}` },
        )
      } catch (error) {
        console.warn(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            level: 'warning',
            component: 'recurring-reconcile',
            message: 'skipped reconcile continuation, enqueue failed',
            cursor,
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      }
    }
  }
  return due.length
}

/**
 * Pause/resume hooks used by group archive mutations. Skipped archive dates are
 * not counted as occurrences; the anchor is moved to the resumed date so the
 * next created row remains the next sequence number.
 */
export async function pauseRecurringExpenseSeries(groupId: string) {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    select: groupLedgerIdArchivedSelect,
  })
  if (!group?.ledgerId || !group.archived) return 0
  return prisma.recurringExpenseSeries.updateMany({
    where: {
      ledgerId: group.ledgerId,
      status: RecurringExpenseSeriesStatus.ACTIVE,
    },
    data: {
      status: RecurringExpenseSeriesStatus.PAUSED,
      version: { increment: 1 },
    },
  })
}

export async function resumeRecurringExpenseSeries(
  groupId: string,
  existingBoss?: SpliitBoss,
) {
  // Resolve the enqueue client before opening the transaction. When jobs are
  // disabled, keep the database state authoritative and let reconciliation
  // enqueue the occurrence once workers are enabled again.
  const boss = jobsEnv.JOBS_ENABLED
    ? (existingBoss ?? (await getApiBossForWrite()))
    : undefined

  return prisma.$transaction(async (tx) => {
    // Archive and resume use the same Group -> Series lock order. The group
    // is re-read under the lock so a concurrent re-archive cannot leave an
    // ACTIVE series behind.
    await tx.$queryRaw`SELECT "id" FROM "Group" WHERE "id" = ${groupId} FOR UPDATE`
    const group = await tx.group.findUnique({
      where: { id: groupId },
      select: {
        ledgerId: true,
        archived: true,
      },
    })
    if (!group?.ledgerId || group.archived) return 0

    const pausedResult = await tx.recurringExpenseSeries.findMany({
      where: {
        ledgerId: group.ledgerId,
        status: RecurringExpenseSeriesStatus.PAUSED,
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    })
    const paused = Array.isArray(pausedResult) ? pausedResult : []
    let resumed = 0
    for (const candidate of paused) {
      await tx.$queryRaw`SELECT "id" FROM "RecurringExpenseSeries" WHERE "id" = ${candidate.id} FOR UPDATE`
      const series = await tx.recurringExpenseSeries.findUnique({
        where: { id: candidate.id },
      })
      if (!series || series.status !== RecurringExpenseSeriesStatus.PAUSED)
        continue
      const now = new Date()

      let ordinal = Math.max(1, series.nextOccurrenceOrdinal)
      let next = calculateRecurrenceDate(
        series.anchorDate,
        series.frequency,
        series.interval,
        ordinal,
      )
      while (
        wallTimeToUtc(
          next.toISOString().slice(0, 10),
          series.anchorTimeMinutes,
          series.timeZone,
        ) <= now
      ) {
        ordinal += 1
        next = calculateRecurrenceDate(
          series.anchorDate,
          series.frequency,
          series.interval,
          ordinal,
        )
      }
      if (
        series.endType === 'DATE' &&
        series.endDate &&
        next > series.endDate
      ) {
        await tx.recurringExpenseSeries.update({
          where: { id: series.id },
          data: {
            status: RecurringExpenseSeriesStatus.COMPLETED,
            version: { increment: 1 },
          },
        })
        continue
      }
      if (
        series.endType === 'COUNT' &&
        series.occurrenceLimit !== null &&
        series.occurrencesCreated >= series.occurrenceLimit
      ) {
        await tx.recurringExpenseSeries.update({
          where: { id: series.id },
          data: {
            status: RecurringExpenseSeriesStatus.COMPLETED,
            version: { increment: 1 },
          },
        })
        continue
      }
      if (
        wallTimeToUtc(
          next.toISOString().slice(0, 10),
          series.anchorTimeMinutes,
          series.timeZone,
        ) > now
      ) {
        const sequence = series.occurrencesCreated + 1
        await tx.recurringExpenseSeries.update({
          where: { id: series.id },
          data: {
            status: RecurringExpenseSeriesStatus.ACTIVE,
            nextOccurrenceDate: next,
            nextOccurrenceOrdinal: ordinal,
            version: { increment: 1 },
          },
        })
        await enqueueMaterialization(
          tx,
          {
            seriesId: series.id,
            sequence,
            occurrenceDate: next,
          },
          boss,
        )
        resumed++
      }
    }
    return resumed
  })
}
