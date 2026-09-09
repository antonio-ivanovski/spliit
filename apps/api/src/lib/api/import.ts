import {
  GroupMemberStatus,
  GroupRole,
  GroupType,
  LedgerParticipantKind,
  prisma,
  type Prisma,
} from '@spliit/db'
import type { Expense, GroupFormValues } from '@spliit/domain'
import {
  dateOnlyInTimeZone,
  exchangeRateLookupDate,
  isSettlementCategory,
  toSecondPrecision,
  utcToWallTime,
  type Expense as DomainExpense,
} from '@spliit/domain'
import { supportedCurrencyCodes } from '@spliit/domain/currency'
import {
  collapseExpenseFromApi,
  planLegacyRecurringImport,
} from '@spliit/domain/import'
import { env as jobsEnv } from '@spliit/jobs'

import {
  deleteS3Object,
  permanentDocumentUrl,
  verifyAndPromoteImportDocument,
} from '../../routes/upload'
import {
  CurrencyRateProviderError,
  UnsupportedCurrencyError,
} from '../currency-errors'
import {
  getCurrencyRates,
  type BatchRateRequest,
  type CurrencyRate,
} from '../currency-rates'
import {
  resolveConversion,
  type ConversionResolution,
} from '../expense-conversion'
import { openStagedDocumentClaims } from '../import-documents'
import { getPlaceholderEmailDisplayName } from '../invitations/display'
import {
  buildExpenseActivityData,
  buildGroupActivityData,
  buildImportSummaryActivityData,
  logActivity,
  planNotificationForActivity,
} from './activities'
import { getApiBoss } from './boss'
import { createManyInBatches } from './create-many-in-batches'
import { CREATE_OPERATIONS, deriveCreateToken } from './idempotency'
import {
  buildRecurringTemplate,
  createSeriesForExpense,
  getApiBossForWrite,
} from './recurrence-series'
import { randomId } from './shared'

export type ImportParticipantMapping =
  | {
      mode: 'LINK_ACCOUNT'
      sourceName: string
      linkedAccountId: string
      destLedgerParticipantId: string
    }
  | {
      mode: 'INVITE_BY_EMAIL'
      sourceName: string
      email: string
      destLedgerParticipantId: string
    }
  | {
      mode: 'INVITE_BY_LINK'
      sourceName: string
      destLedgerParticipantId: string
    }
  | {
      mode: 'UNLINKED_PARTICIPANT'
      sourceName: string
      destLedgerParticipantId: string
    }
  | {
      mode: 'LINK_EXISTING_PARTICIPANT'
      sourceName: string
      destLedgerParticipantId: string
    }
  | {
      mode: 'INVITE_CONTACT'
      sourceName: string
      email: string
      destLedgerParticipantId: string
    }

export type ImportSourceMeta = {
  provider: string
  sourceGroupId: string
  sourceUrl?: string
}

export type ImportInput = {
  targetGroupId?: string
  groupFormValues?: GroupFormValues
  participants: ImportParticipantMapping[]
  expenses: Expense[]
  sourceMeta?: ImportSourceMeta
  historicalActivities?: Array<{
    time: Date
    activityType:
      | 'UPDATE_GROUP'
      | 'CREATE_EXPENSE'
      | 'UPDATE_EXPENSE'
      | 'DELETE_EXPENSE'
    actorParticipantId: string | null
    expenseIndex: number | null
    data: string | null
  }>
  documentImport?: {
    sessionId: string
    stagedTokens: string[]
  }
}

export type ImportInviteResult = {
  sourceName: string
  kind: 'EMAIL' | 'LINK'
  invitationId: string
  inviteUrl?: string
  email?: string
}

export type ImportResult = {
  groupId: string
  ledgerId: string
  importedExpenses: number
  importedDocuments: number
  sourceGroupId: string | null
  invites: ImportInviteResult[]
  emailDispatches?: ImportEmailDispatch[]
}

export type ImportEmailDispatch = {
  invitationId: string
  groupId: string
  groupName: string
  inviterDisplayName: string
  inviterRole: GroupRole
  recipientEmail: string
  recipientIsExistingUser: boolean
  temporaryName?: string | null
  sourceProvider?: string
  expenseCount?: number
  totalAmount?: number
  currencyCode?: string | null
}

/** Resolve FX and queue clients before opening the import transaction. */
export async function prepareImportGroup(
  input: ImportInput,
  actor: {
    accountId: string
    idempotencyRequestId?: string
  },
) {
  let stagedClaims: Awaited<ReturnType<typeof openStagedDocumentClaims>>[] = []
  try {
    stagedClaims = input.documentImport
      ? await Promise.all(
          input.documentImport.stagedTokens.map((token) =>
            openStagedDocumentClaims(token),
          ),
        )
      : []
  } catch (cause) {
    throw new Error('Staged import document token is invalid or expired', {
      cause,
    })
  }
  const seenSourceDocuments = new Set<string>()
  for (const claims of stagedClaims) {
    if (
      claims.accountId !== actor.accountId ||
      claims.sessionId !== input.documentImport?.sessionId ||
      claims.expenseIndex >= input.expenses.length
    ) {
      throw new Error('Invalid staged import document')
    }
    const sourceKey = `${claims.expenseIndex}:${claims.sourceDocumentId}`
    if (seenSourceDocuments.has(sourceKey)) {
      throw new Error('Duplicate staged import document')
    }
    seenSourceDocuments.add(sourceKey)
  }
  const importedDocumentsByExpense = new Map<
    number,
    Array<{ url: string; width: number; height: number }>
  >()
  for (const claims of stagedClaims) {
    const rows = importedDocumentsByExpense.get(claims.expenseIndex) ?? []
    rows.push({
      url: permanentDocumentUrl(claims.fileUrl),
      width: claims.width,
      height: claims.height,
    })
    importedDocumentsByExpense.set(claims.expenseIndex, rows)
  }
  // Legacy spliit.app export only carries recurrenceRule. Matching historical
  // rows collapse into one destination series; Cloud series metadata is never
  // accepted on this transport.
  const recurringPlan = planLegacyRecurringImport(
    input.expenses.map((expense) => collapseExpenseFromApi(expense)),
  )
  const queueBoss =
    jobsEnv.JOBS_ENABLED && recurringPlan.series.length > 0
      ? await getApiBossForWrite()
      : undefined

  // ── Preflight: resolve ledger currency and conversions BEFORE the transaction ──
  let preflightLedgerCurrency: string | null
  let preflightSnapshot: {
    id: string
    ledgerId: string
    archived: boolean
    groupType: string
    currencyCode: string | null
  } | null = null

  if (input.targetGroupId) {
    const existing = await prisma.group.findUnique({
      where: { id: input.targetGroupId },
      select: {
        id: true,
        ledgerId: true,
        archived: true,
        groupType: true,
        ledger: { select: { currencyCode: true } },
      },
    })
    if (!existing) {
      throw new Error('Target group not found')
    }
    if (existing.archived) {
      throw new Error('Cannot import into an archived group')
    }
    if (existing.groupType === GroupType.FRIEND) {
      throw new Error('Cannot import into a friend ledger')
    }
    if (!existing.ledgerId) {
      throw new Error('Target group is missing its ledger')
    }
    preflightLedgerCurrency = existing.ledger?.currencyCode ?? null
    preflightSnapshot = {
      id: existing.id,
      ledgerId: existing.ledgerId,
      archived: existing.archived,
      groupType: existing.groupType,
      currencyCode: preflightLedgerCurrency,
    }
  } else {
    if (!input.groupFormValues) {
      throw new Error('Either targetGroupId or groupFormValues is required')
    }
    preflightLedgerCurrency = input.groupFormValues.currencyCode || null
  }

  // Batch every EXCHANGE-converted expense into one provider call. The
  // loop below would otherwise issue one upstream request per expense
  // (N × provider latency on cache misses) and pin this handler for the
  // duration of the slowest look-up. getCurrencyRates dedupes
  // (date, base, target) triples so the import latency is bounded by
  // the distinct currency pairs and dates in the input.
  const exchangeRequests: BatchRateRequest[] = []
  const expenseIsoDate = (expense: DomainExpense) =>
    `${expense.expenseDate.getUTCFullYear()}-${String(
      expense.expenseDate.getUTCMonth() + 1,
    ).padStart(2, '0')}-${String(expense.expenseDate.getUTCDate()).padStart(
      2,
      '0',
    )}`
  for (const expense of input.expenses) {
    const conversion = expense.conversion ?? undefined
    if (conversion?.type !== 'exchange') continue
    const expenseIso = conversion.currency?.toUpperCase()
    const ledgerIso = preflightLedgerCurrency?.toUpperCase()
    if (!expenseIso || !ledgerIso || expenseIso === ledgerIso) continue
    if (
      !(supportedCurrencyCodes as readonly string[]).includes(expenseIso) ||
      !(supportedCurrencyCodes as readonly string[]).includes(ledgerIso)
    ) {
      // Let resolveConversion throw the precise validation error below.
      continue
    }
    const lookupDate = exchangeRateLookupDate(expenseIsoDate(expense))
    exchangeRequests.push({
      date: lookupDate,
      base: expenseIso,
      target: ledgerIso,
    })
  }

  const batchResults =
    exchangeRequests.length > 0 ? await getCurrencyRates(exchangeRequests) : []
  const rateByKey = new Map<
    string,
    | { ok: true; rate: ReturnType<typeof Object> }
    | { ok: false; error: unknown }
  >()
  for (let i = 0; i < exchangeRequests.length; i++) {
    const req = exchangeRequests[i]!
    const result = batchResults[i]
    rateByKey.set(
      `${req.date}|${req.base}|${req.target}`,
      result ?? {
        ok: false,
        error: { code: 'PROVIDER_ERROR', message: 'Missing batch result' },
      },
    )
  }

  const cachedFetch = async (args: {
    date: string
    base: string
    target: string
  }): Promise<CurrencyRate> => {
    const key = `${args.date}|${args.base.toUpperCase()}|${args.target.toUpperCase()}`
    const entry = rateByKey.get(key)
    if (!entry || !entry.ok) {
      const err = (entry as { ok: false; error: unknown } | undefined)
        ?.error as
        | {
            code: string
            currency?: string
            message?: string
            target?: string
          }
        | undefined
      if (err?.code === 'UNSUPPORTED_CURRENCY') {
        throw new UnsupportedCurrencyError(err.currency ?? args.base)
      }
      const message =
        err?.message ??
        `Rate unavailable for ${args.base}→${args.target} on ${args.date}`
      throw new CurrencyRateProviderError(message)
    }
    return entry.rate as CurrencyRate
  }

  const resolvedConversions: ConversionResolution[] = []
  for (const expense of input.expenses) {
    resolvedConversions.push(
      await resolveConversion(
        expense,
        {
          ledgerCurrency: preflightLedgerCurrency,
          expenseDate: expense.expenseDate,
        },
        { fetchImpl: cachedFetch },
      ),
    )
  }

  const preparedExpenses = input.expenses.map((expense, expenseIndex) => {
    const conversion = resolvedConversions[expenseIndex]!
    const expenseId = randomId()
    return {
      expense,
      expenseId,
      conversion,
      activity: {
        id: randomId(),
        type: 'EXPENSE_CREATED' as const,
        actorType: 'ACCOUNT' as const,
        actorId: actor.accountId,
        subjectType: 'EXPENSE' as const,
        subjectId: expenseId,
        data: buildExpenseActivityData({
          summary: expense.title,
          title: expense.title,
          amount: conversion.ledgerAmountMinor,
          // Expense currency when converted; ledger currency for same-currency
          // (originalCurrency is null and amount is already ledger minor units).
          currencyCode:
            conversion.originalCurrency ?? preflightLedgerCurrency ?? null,
          date: utcToWallTime(expense.expenseDate, expense.expenseTimeZone)
            .dateIso,
          originalAmount: conversion.originalAmount ?? undefined,
          conversionRate: conversion.conversionRate ?? undefined,
          conversionSource: conversion.conversionSource,
          ledgerCurrencyCode: preflightLedgerCurrency ?? null,
        }),
      },
      documents: [
        ...expense.documents,
        ...(importedDocumentsByExpense.get(expenseIndex) ?? []),
      ].map((document) => ({
        id: randomId(),
        document,
      })),
    }
  })
  const seriesIdByKey = new Map(
    recurringPlan.series.map((plan) => [plan.seriesKey, randomId()] as const),
  )
  const membershipByExpenseIndex = new Map(
    recurringPlan.membership.map((row) => [row.expenseIndex, row] as const),
  )

  const boss = await getApiBoss()
  const promotionResults = input.documentImport
    ? await Promise.allSettled(
        input.documentImport.stagedTokens.map((token) =>
          verifyAndPromoteImportDocument({
            token,
            accountId: actor.accountId,
            sessionId: input.documentImport!.sessionId,
          }),
        ),
      )
    : []
  const importedDocuments = promotionResults.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  )
  const promotionFailure = promotionResults.find(
    (result) => result.status === 'rejected',
  )
  if (promotionFailure?.status === 'rejected') {
    await Promise.allSettled(
      importedDocuments.map((document) => deleteS3Object(document.url)),
    )
    throw promotionFailure.reason
  }

  return {
    boss,
    membershipByExpenseIndex,
    preflightLedgerCurrency,
    preflightSnapshot,
    preparedExpenses,
    queueBoss,
    recurringPlan,
    resolvedConversions,
    importedDocuments: importedDocuments.length,
    promotedDocumentUrls: importedDocuments.map((document) => document.url),
    stagedDocumentUrls: importedDocuments.map(
      (document) => document.temporaryUrl,
    ),
    seriesIdByKey,
  }
}

export async function importGroup(
  input: ImportInput,
  actor: {
    accountId: string
    idempotencyRequestId?: string
  },
  options?: {
    prepared?: Awaited<ReturnType<typeof prepareImportGroup>>
    tx?: Prisma.TransactionClient
  },
): Promise<ImportResult> {
  const client = options?.tx ?? prisma
  const prepared = options?.prepared ?? (await prepareImportGroup(input, actor))
  const {
    boss,
    membershipByExpenseIndex,
    preflightLedgerCurrency,
    preflightSnapshot,
    preparedExpenses,
    queueBoss,
    recurringPlan,
    resolvedConversions,
    importedDocuments,
    seriesIdByKey,
  } = prepared
  const run = async (tx: Prisma.TransactionClient) => {
    let groupId: string
    let ledgerId: string

    if (input.targetGroupId) {
      const locked = await tx.$queryRaw<
        Array<{
          id: string
          ledgerId: string | null
          archived: boolean
          groupType: string
          currencyCode: string | null
        }>
      >`
        SELECT g.id, g."ledgerId", g.archived, g."groupType"::text AS "groupType", l."currencyCode"
        FROM "Group" g
        INNER JOIN "Ledger" l ON l.id = g."ledgerId"
        WHERE g.id = ${input.targetGroupId}
        FOR UPDATE OF g, l
      `
      const existing = locked[0]
      if (!existing) {
        throw new Error('Target group not found')
      }
      if (existing.archived) {
        throw new Error('Cannot import into an archived group')
      }
      if (existing.groupType === GroupType.FRIEND) {
        throw new Error('Cannot import into a friend ledger')
      }
      if (!existing.ledgerId) {
        throw new Error('Target group is missing its ledger')
      }
      const currentCurrency = existing.currencyCode ?? null
      if (
        preflightSnapshot &&
        (existing.ledgerId !== preflightSnapshot.ledgerId ||
          currentCurrency !== preflightSnapshot.currencyCode)
      ) {
        throw new Error(
          'Target group ledger changed between preflight and import; retry the import',
        )
      }
      groupId = existing.id
      ledgerId = existing.ledgerId
    } else {
      if (!input.groupFormValues) {
        throw new Error('Either targetGroupId or groupFormValues is required')
      }
      const ledger = await tx.ledger.create({
        data: {
          id: randomId(),
          currency: input.groupFormValues.currency,
          currencyCode: input.groupFormValues.currencyCode || null,
        },
      })
      const group = await tx.group.create({
        data: {
          id: randomId(),
          name: input.groupFormValues.name,
          information: input.groupFormValues.information,
          ledgerId: ledger.id,
        },
      })
      const adminMember = await tx.groupMember.create({
        data: {
          id: randomId(),
          groupId: group.id,
          accountId: actor.accountId,
          role: GroupRole.ADMIN,
          status: GroupMemberStatus.ACTIVE,
          joinedAt: new Date(),
        },
      })
      groupId = group.id
      ledgerId = ledger.id
      void adminMember
    }

    const destIdByClientKey = new Map<string, string>()
    const inviteMappings: Array<{
      mode: 'INVITE_BY_EMAIL' | 'INVITE_BY_LINK'
      sourceName: string
      destLedgerParticipantId: string
      email?: string
    }> = []

    const existingLpIds = input.targetGroupId
      ? new Set(
          (
            await tx.ledgerParticipant.findMany({
              where: { ledgerId },
              select: { id: true },
            })
          ).map((p) => p.id),
        )
      : null

    for (const mapping of input.participants) {
      const destId = mapping.destLedgerParticipantId
      if (mapping.mode === 'UNLINKED_PARTICIPANT') {
        await tx.ledgerParticipant.create({
          data: {
            id: destId,
            ledgerId,
            kind: LedgerParticipantKind.UNLINKED_PARTICIPANT,
            displayName: mapping.sourceName,
          },
        })
        destIdByClientKey.set(destId, destId)
        continue
      }
      if (
        mapping.mode === 'INVITE_BY_EMAIL' ||
        mapping.mode === 'INVITE_BY_LINK' ||
        mapping.mode === 'INVITE_CONTACT'
      ) {
        await tx.ledgerParticipant.create({
          data: {
            id: destId,
            ledgerId,
            kind: LedgerParticipantKind.UNLINKED_PARTICIPANT,
            displayName: mapping.sourceName,
          },
        })
        destIdByClientKey.set(destId, destId)
        inviteMappings.push({
          mode:
            mapping.mode === 'INVITE_CONTACT'
              ? 'INVITE_BY_EMAIL'
              : mapping.mode,
          sourceName: mapping.sourceName,
          destLedgerParticipantId: destId,
          email:
            mapping.mode === 'INVITE_BY_EMAIL' ||
            mapping.mode === 'INVITE_CONTACT'
              ? mapping.email
              : undefined,
        })
        continue
      }
      if (mapping.mode === 'LINK_EXISTING_PARTICIPANT') {
        if (!existingLpIds) {
          throw new Error(
            `Cannot map to an existing participant when creating a new group: ${mapping.sourceName}.`,
          )
        }
        if (!existingLpIds.has(destId)) {
          throw new Error(
            `Destination LedgerParticipant "${destId}" not found in target group for source participant "${mapping.sourceName}.`,
          )
        }
        destIdByClientKey.set(destId, destId)
        continue
      }

      const account = await tx.account.findUnique({
        where: { id: mapping.linkedAccountId },
        select: { id: true },
      })
      if (!account) {
        throw new Error(`Linked account not found: ${mapping.linkedAccountId}`)
      }
      const existingMember = await tx.groupMember.findUnique({
        where: {
          groupId_accountId: {
            groupId,
            accountId: mapping.linkedAccountId,
          },
        },
        include: { ledgerParticipant: true },
      })
      let memberId: string
      if (existingMember) {
        memberId = existingMember.id
      } else {
        const created = await tx.groupMember.create({
          data: {
            id: randomId(),
            groupId,
            accountId: mapping.linkedAccountId,
            role: GroupRole.MEMBER,
            status: GroupMemberStatus.ACTIVE,
            joinedAt: new Date(),
          },
        })
        memberId = created.id
      }
      if (existingMember?.ledgerParticipant) {
        destIdByClientKey.set(destId, existingMember.ledgerParticipant.id)
        continue
      }
      await tx.ledgerParticipant.create({
        data: {
          id: destId,
          ledgerId,
          groupMemberId: memberId,
        },
      })
      destIdByClientKey.set(destId, destId)
    }

    const ledgerCurrency = preflightLedgerCurrency
    // Union of LedgerParticipant IDs touched by any imported expense
    // (paidBy ∪ paidFor). The post-commit notification dispatcher
    // filters this down to active group members with a real email so
    // one summary email fans out to everyone affected.
    const affectedParticipantIds = new Set<string>()
    let totalAmount = 0

    const resolvePaidParticipants = (expense: Expense) => {
      const resolvedPaidByList = expense.paidByList
        .map((paidBy) => {
          const resolved = destIdByClientKey.get(paidBy.participant)
          if (!resolved) return null
          return {
            ledgerParticipantId: resolved,
            shares: paidBy.shares,
          }
        })
        .filter(
          (row): row is { ledgerParticipantId: string; shares: number } =>
            row !== null,
        )
      if (resolvedPaidByList.length === 0) {
        throw new Error(
          `Expense "${expense.title}" has no remaining paidBy participants after import resolution`,
        )
      }
      const seenPaidByIds = new Set<string>()
      for (const row of resolvedPaidByList) {
        if (seenPaidByIds.has(row.ledgerParticipantId)) {
          throw new Error(
            `Expense "${expense.title}" has two paidBy entries for the same LedgerParticipant (${row.ledgerParticipantId}). Each source participant must map to a unique destination.`,
          )
        }
        seenPaidByIds.add(row.ledgerParticipantId)
      }
      const resolvedPaidFor: Array<{
        ledgerParticipantId: string
        shares: number
      }> = []
      const seenPaidForIds = new Set<string>()
      for (const paidFor of expense.paidFor) {
        const resolved = destIdByClientKey.get(paidFor.participant)
        if (!resolved) continue
        if (seenPaidForIds.has(resolved)) {
          throw new Error(
            `Expense "${expense.title}" has two paidFor entries for the same LedgerParticipant (${resolved}). Each source participant must map to a unique destination.`,
          )
        }
        seenPaidForIds.add(resolved)
        resolvedPaidFor.push({
          ledgerParticipantId: resolved,
          shares: paidFor.shares,
        })
      }
      if (resolvedPaidFor.length === 0) {
        throw new Error(
          `Expense "${expense.title}" has no remaining paidFor participants after import resolution`,
        )
      }
      return { resolvedPaidByList, resolvedPaidFor }
    }

    const expenseRows: Prisma.ExpenseCreateManyInput[] = []
    const paidByRows: Prisma.ExpensePaidByCreateManyInput[] = []
    const paidForRows: Prisma.ExpensePaidForCreateManyInput[] = []
    const documentRows: Prisma.ExpenseDocumentCreateManyInput[] = []
    const activityRows: Prisma.ActivityCreateManyInput[] = []
    const resolvedParticipantsByExpenseIndex: Array<
      ReturnType<typeof resolvePaidParticipants>
    > = []

    for (const [expenseIndex, prepared] of preparedExpenses.entries()) {
      const { expense, expenseId, conversion } = prepared
      const resolvedParticipants = resolvePaidParticipants(expense)
      resolvedParticipantsByExpenseIndex.push(resolvedParticipants)

      if (!isSettlementCategory(expense.category)) {
        totalAmount += conversion.ledgerAmountMinor
      }
      for (const row of resolvedParticipants.resolvedPaidByList) {
        affectedParticipantIds.add(row.ledgerParticipantId)
        paidByRows.push({ expenseId, ...row })
      }
      for (const row of resolvedParticipants.resolvedPaidFor) {
        affectedParticipantIds.add(row.ledgerParticipantId)
        paidForRows.push({ expenseId, ...row })
      }

      const membership = membershipByExpenseIndex.get(expenseIndex)
      const recurringSeriesId = membership
        ? seriesIdByKey.get(membership.seriesKey)
        : undefined
      expenseRows.push({
        id: expenseId,
        ledgerId,
        createdByAccountId: actor.accountId,
        expenseDate: toSecondPrecision(expense.expenseDate),
        expenseTimeZone: expense.expenseTimeZone,
        title: expense.title,
        categoryId: expense.category,
        amount: conversion.ledgerAmountMinor,
        originalAmount: conversion.originalAmount,
        originalCurrency: conversion.originalCurrency,
        conversionRate: conversion.conversionRate,
        conversionSource: conversion.conversionSource,
        paidBySplitMode: expense.paidBySplitMode,
        splitMode: expense.splitMode,
        recurringSeriesId,
        recurrenceSequence: membership?.sequence,
        notes: expense.notes,
      })
      for (const { id, document } of prepared.documents) {
        documentRows.push({
          id,
          expenseId,
          ledgerId,
          url: document.url,
          width: document.width,
          height: document.height,
        })
      }
      if (input.historicalActivities === undefined) {
        activityRows.push({
          ...prepared.activity,
          ledgerId,
          data: prepared.activity.data,
        })
      }
    }

    const historicalType = {
      UPDATE_GROUP: 'GROUP_UPDATED',
      CREATE_EXPENSE: 'EXPENSE_CREATED',
      UPDATE_EXPENSE: 'EXPENSE_UPDATED',
      DELETE_EXPENSE: 'EXPENSE_DELETED',
    } as const
    for (const historical of input.historicalActivities ?? []) {
      const preparedExpense =
        historical.expenseIndex === null
          ? null
          : (preparedExpenses[historical.expenseIndex] ?? null)
      const actorId = historical.actorParticipantId
        ? (destIdByClientKey.get(historical.actorParticipantId) ?? null)
        : null
      const isGroupActivity = historical.activityType === 'UPDATE_GROUP'
      const title =
        historical.data ?? preparedExpense?.expense.title ?? 'Imported expense'
      activityRows.push({
        id: randomId(),
        ledgerId,
        time: historical.time,
        type: historicalType[historical.activityType],
        actorType: actorId ? 'LEDGER_PARTICIPANT' : null,
        actorId,
        subjectType: isGroupActivity
          ? 'GROUP'
          : preparedExpense
            ? 'EXPENSE'
            : null,
        subjectId: isGroupActivity
          ? groupId
          : (preparedExpense?.expenseId ?? null),
        data: isGroupActivity
          ? buildGroupActivityData({
              summary: historical.data ?? undefined,
            })
          : buildExpenseActivityData({ summary: title, title }),
      })
    }

    for (const plan of recurringPlan.series) {
      const seriesId = seriesIdByKey.get(plan.seriesKey)
      if (!seriesId) continue
      const anchorExpense = input.expenses[plan.anchorIndex]!
      const conversion = resolvedConversions[plan.anchorIndex]!
      const { resolvedPaidByList, resolvedPaidFor } =
        resolvedParticipantsByExpenseIndex[plan.anchorIndex]!
      const template = buildRecurringTemplate({
        expense: {
          ...anchorExpense,
          paidByList: resolvedPaidByList.map((row) => ({
            participant: row.ledgerParticipantId,
            shares: row.shares,
          })),
          paidFor: resolvedPaidFor.map((row) => ({
            participant: row.ledgerParticipantId,
            shares: row.shares,
          })),
          items: (anchorExpense.items ?? []).map((item) => ({
            ...item,
            paidFor: item.paidFor
              .map((row) => {
                const resolved = destIdByClientKey.get(row.participant)
                return resolved
                  ? { participant: resolved, shares: row.shares }
                  : null
              })
              .filter(
                (row): row is { participant: string; shares: number } =>
                  row !== null,
              ),
          })),
          itemizedRemainder: anchorExpense.itemizedRemainder
            ? {
                ...anchorExpense.itemizedRemainder,
                paidFor: anchorExpense.itemizedRemainder.paidFor
                  .map((row) => {
                    const resolved = destIdByClientKey.get(row.participant)
                    return resolved
                      ? { participant: resolved, shares: row.shares }
                      : null
                  })
                  .filter(
                    (row): row is { participant: string; shares: number } =>
                      row !== null,
                  ),
              }
            : undefined,
        },
        conversion,
      })
      await createSeriesForExpense({
        tx,
        seriesId,
        ledgerId,
        creatorAccountId: actor.accountId,
        anchorDate: dateOnlyInTimeZone(
          anchorExpense.expenseDate,
          anchorExpense.expenseTimeZone,
        ),
        timeZone: anchorExpense.expenseTimeZone,
        anchorTimeMinutes: utcToWallTime(
          anchorExpense.expenseDate,
          anchorExpense.expenseTimeZone,
        ).timeMinutes,
        config: plan.config,
        template,
        boss: queueBoss,
        occurrencesCreated: plan.occurrenceCount,
        nextOccurrenceDate: plan.nextOccurrenceDate,
        nextOccurrenceOrdinal: plan.nextOccurrenceOrdinal,
      })
    }

    await createManyInBatches(expenseRows, (data) =>
      tx.expense.createMany({ data }),
    )
    await createManyInBatches(paidByRows, (data) =>
      tx.expensePaidBy.createMany({ data }),
    )
    await createManyInBatches(paidForRows, (data) =>
      tx.expensePaidFor.createMany({ data }),
    )
    await createManyInBatches(documentRows, (data) =>
      tx.expenseDocument.createMany({ data }),
    )
    await createManyInBatches(activityRows, (data) =>
      tx.activity.createMany({ data }),
    )

    // Single current-time summary for the import. Sources without historical
    // activity also retain the synthetic per-expense create rows above.
    const summaryActivity = await logActivity(
      groupId,
      {
        type: 'EXPENSES_IMPORTED',
        actor: { type: 'ACCOUNT', id: actor.accountId },
        subject: { type: 'GROUP', id: groupId },
        data: buildImportSummaryActivityData({
          summary: input.sourceMeta
            ? `Imported from ${input.sourceMeta.provider}`
            : 'Imported expenses',
          count: input.expenses.length,
          totalAmount,
          currencyCode: ledgerCurrency ?? null,
          sourceProvider: input.sourceMeta?.provider,
          affectedParticipants: [...affectedParticipantIds],
        }),
      },
      tx,
      ledgerId,
    )

    if (affectedParticipantIds.size > 0) {
      await planNotificationForActivity(
        tx,
        summaryActivity,
        { groupId },
        { boss },
      )
    }

    return {
      groupId,
      ledgerId,
      importedExpenses: input.expenses.length,
      importedDocuments,
      sourceGroupId: input.sourceMeta?.sourceGroupId ?? null,
      inviteMappings,
      summaryActivity: {
        activityId: summaryActivity.id,
        actorAccountId: actor.accountId,
        time: summaryActivity.time,
        count: input.expenses.length,
        totalAmount,
        currencyCode: ledgerCurrency ?? null,
        sourceProvider: input.sourceMeta?.provider,
        affectedParticipants: [...affectedParticipantIds],
      },
    }
  }
  const baseResult = options?.tx
    ? await run(options.tx)
    : await prisma.$transaction(run)

  const { createEmailInvitation, createLinkInvitation } =
    await import('../invitations')
  const group = await client.group.findUnique({
    where: { id: baseResult.groupId },
    select: { name: true },
  })
  if (!group) {
    throw new Error('Group not found after import commit')
  }
  const inviter = await client.account.findUnique({
    where: { id: actor.accountId },
    select: { name: true, email: true },
  })
  const inviterDisplayName =
    inviter?.name ||
    getPlaceholderEmailDisplayName(inviter?.email) ||
    inviter?.email ||
    'Someone'

  const inviteResults: ImportInviteResult[] = []
  const emailDispatches: ImportEmailDispatch[] = []
  for (const invite of baseResult.inviteMappings) {
    if (invite.mode === 'INVITE_BY_EMAIL') {
      const email = invite.email!
      const invitation = await createEmailInvitation({
        groupId: baseResult.groupId,
        email,
        role: GroupRole.MEMBER,
        inviterAccountId: actor.accountId,
        temporaryName: invite.sourceName,
        ledgerParticipantId: invite.destLedgerParticipantId,
        notificationBoss: boss,
        tx: options?.tx,
      })
      const existingAccount = await client.account.findFirst({
        where: { email: { equals: email.toLowerCase(), mode: 'insensitive' } },
        select: { id: true },
      })
      if (!existingAccount) {
        emailDispatches.push({
          invitationId: invitation.id,
          groupId: baseResult.groupId,
          groupName: group.name,
          inviterDisplayName,
          inviterRole: GroupRole.ADMIN,
          recipientEmail: invitation.email,
          recipientIsExistingUser: false,
          temporaryName: invite.sourceName,
          sourceProvider: input.sourceMeta?.provider,
          expenseCount: input.expenses.length,
          totalAmount: baseResult.summaryActivity.totalAmount,
          currencyCode: baseResult.summaryActivity.currencyCode,
        })
      }
      inviteResults.push({
        sourceName: invite.sourceName,
        kind: 'EMAIL',
        invitationId: invitation.id,
        email,
      })
    } else {
      const link = await createLinkInvitation({
        groupId: baseResult.groupId,
        role: GroupRole.MEMBER,
        inviterAccountId: actor.accountId,
        temporaryName: invite.sourceName,
        ledgerParticipantId: invite.destLedgerParticipantId,
        notificationBoss: boss,
        tx: options?.tx,
        ...(actor.idempotencyRequestId
          ? {
              token: deriveCreateToken({
                accountId: actor.accountId,
                operation: CREATE_OPERATIONS.import,
                requestId: actor.idempotencyRequestId,
                discriminator: `import-link:${invite.sourceName}`,
              }),
            }
          : {}),
      })
      inviteResults.push({
        sourceName: invite.sourceName,
        kind: 'LINK',
        invitationId: link.invitation.id,
        inviteUrl: link.inviteUrl,
      })
    }
  }

  return {
    groupId: baseResult.groupId,
    ledgerId: baseResult.ledgerId,
    importedExpenses: baseResult.importedExpenses,
    importedDocuments: baseResult.importedDocuments,
    sourceGroupId: baseResult.sourceGroupId,
    invites: inviteResults,
    emailDispatches,
  }
}
