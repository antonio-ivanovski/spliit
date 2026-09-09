import * as z from 'zod'

import { DEFAULT_CATEGORIES, SETTLEMENT_CATEGORY_ID } from '../categories'
import { sharesAsFixedUnits } from '../shares'
import { legacyRuleToRecurrence } from './recurrence'
import {
  recoverSpliitOriginalAmount,
  shouldRecoverSpliitOriginal,
} from './spliit-original-amount'
import type {
  ImportMessageParams,
  ImportParseResult,
  NormalizedSource,
  NormalizedSourceExpense,
} from './types'

/**
 * This parser accepts the original unversioned export and the upstream v3
 * extension. Keep current Spliit Cloud-only recurrence state out of this wire
 * schema; normalize only fields emitted by spliit.app.
 */
export const spliitExportSchema = z.object({
  exportVersion: z.literal(3).optional(),
  id: z.string().min(1),
  name: z.string().min(1),
  information: z.string().nullable().optional(),
  currency: z.string().min(1).max(5),
  // Legacy spliit.app exports use an empty string for custom currencies.
  // Normalize that representation to null at the parser boundary below.
  currencyCode: z
    .union([z.string().min(3).max(4), z.literal('')])
    .nullable()
    .optional(),
  participants: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
      }),
    )
    .min(1),
  expenses: z.array(
    z.object({
      id: z.string().min(1).optional(),
      createdAt: z.iso.datetime().optional(),
      title: z.string().min(1),
      amount: z.number().int().nonnegative(),
      paidById: z.string().min(1),
      paidFor: z
        .array(
          z.object({
            participantId: z.string().min(1),
            shares: z.number().int().nonnegative(),
          }),
        )
        .min(1),
      isReimbursement: z.boolean().default(false),
      splitMode: z
        .enum(['EVENLY', 'BY_SHARES', 'BY_PERCENTAGE', 'BY_AMOUNT'])
        .default('EVENLY'),
      recurrenceRule: z
        .enum(['NONE', 'DAILY', 'WEEKLY', 'MONTHLY'])
        .default('NONE'),
      expenseDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}/, 'expected an ISO date'),
      category: z
        .object({
          grouping: z.string(),
          name: z.string(),
        })
        .optional()
        .nullable(),
      originalAmount: z.coerce.number().int().nullable().optional(),
      originalCurrency: z.string().min(3).max(4).nullable().optional(),
      conversionRate: z.coerce.number().nullable().optional(),
      notes: z.string().nullable().optional(),
      documents: z
        .array(
          z.object({
            id: z.string().min(1),
            url: z.url(),
            width: z.number().int().positive(),
            height: z.number().int().positive(),
          }),
        )
        .optional(),
    }),
  ),
  activities: z
    .array(
      z.object({
        id: z.string().min(1),
        time: z.iso.datetime(),
        activityType: z.enum([
          'UPDATE_GROUP',
          'CREATE_EXPENSE',
          'UPDATE_EXPENSE',
          'DELETE_EXPENSE',
        ]),
        participantId: z.string().min(1).nullable(),
        expenseId: z.string().min(1).nullable(),
        data: z.string().nullable(),
      }),
    )
    .optional(),
})

export type SpliitExport = z.infer<typeof spliitExportSchema>

class ImportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly params: ImportMessageParams = {},
  ) {
    super(message)
  }
}

function resolveCategoryId(
  category: SpliitExport['expenses'][number]['category'],
): string {
  if (!category) return 'general'
  const match = DEFAULT_CATEGORIES.find(
    (c) =>
      c.grouping.toLowerCase() === category.grouping.toLowerCase() &&
      c.name.toLowerCase() === category.name.toLowerCase(),
  )
  if (match) return match.id
  const partial = DEFAULT_CATEGORIES.find(
    (c) => c.name.toLowerCase() === category.name.toLowerCase(),
  )
  return partial?.id ?? 'general'
}

function normalizeSpliitExport(parsed: SpliitExport): NormalizedSource {
  const upstreamIdToSourceId = new Map<string, string>()
  const seenUpstreamIds = new Set<string>()
  const participants: NormalizedSource['participants'] =
    parsed.participants.map((p, index) => {
      if (seenUpstreamIds.has(p.id)) {
        throw new ImportError(
          `The export contains duplicate participant ids (id "${p.id}").`,
          'SPLIIT_DUPLICATE_PARTICIPANT_IDS',
          { participantId: p.id },
        )
      }
      seenUpstreamIds.add(p.id)
      const sourceId = `spliit-participant-${index}`
      upstreamIdToSourceId.set(p.id, sourceId)
      return { sourceId, sourceName: p.name }
    })

  const mustGetSourceId = (upstreamId: string, title: string): string => {
    const sourceId = upstreamIdToSourceId.get(upstreamId)
    if (!sourceId) {
      throw new ImportError(
        `Expense "${title}" references an unknown participant.`,
        'SPLIIT_UNKNOWN_PARTICIPANT',
        { title },
      )
    }
    return sourceId
  }

  const seenExpenseIds = new Set<string>()
  const seenDocumentIds = new Set<string>()
  const expenses: NormalizedSourceExpense[] = parsed.expenses.map((e) => {
    if (e.id && seenExpenseIds.has(e.id)) {
      throw new ImportError(
        `The export contains duplicate expense ids (id "${e.id}").`,
        'SPLIIT_DUPLICATE_EXPENSE_IDS',
        { expenseId: e.id },
      )
    }
    if (e.id) seenExpenseIds.add(e.id)
    for (const document of e.documents ?? []) {
      if (seenDocumentIds.has(document.id)) {
        throw new ImportError(
          `The export contains duplicate document ids (id "${document.id}").`,
          'SPLIIT_DUPLICATE_DOCUMENT_IDS',
          { documentId: document.id },
        )
      }
      seenDocumentIds.add(document.id)
    }
    const paidBySourceId = mustGetSourceId(e.paidById, e.title)
    const paidFor: NormalizedSourceExpense['paidFor'] = []
    const seenInRow = new Set<string>()
    for (const row of e.paidFor) {
      const sourceId = mustGetSourceId(row.participantId, e.title)
      if (seenInRow.has(sourceId)) {
        throw new ImportError(
          `Expense "${e.title}" has duplicate paid-for participants.`,
          'SPLIIT_DUPLICATE_PAID_FOR',
          { title: e.title },
        )
      }
      seenInRow.add(sourceId)
      if (!Number.isInteger(row.shares) || row.shares <= 0) {
        throw new ImportError(
          `Expense "${e.title}" has a non-positive share.`,
          'SPLIIT_NON_POSITIVE_SHARE',
          { title: e.title },
        )
      }
      // Legacy whole-share weights from spliit.app's BY_SHARES export.
      // Spliit Cloud stores BY_SHARES as fixed units (`100 = 1 share`),
      // so multiply legacy whole numbers once to land in the new
      // internal representation. EVENLY/PERCENTAGE/AMOUNT modes pass
      // through unchanged because the same column carries the literal
      // mode-specific unit (basis points / minor units / even marker).
      const normalizedShares =
        e.splitMode === 'BY_SHARES'
          ? sharesAsFixedUnits(row.shares)
          : row.shares
      paidFor.push({ sourceId, shares: normalizedShares })
    }
    if (!Number.isInteger(e.amount) || e.amount < 0) {
      throw new ImportError(
        `Expense "${e.title}" has an invalid amount.`,
        'SPLIIT_INVALID_AMOUNT',
        { title: e.title },
      )
    }
    // Export `amount` is always the source-group ledger total (reliable).
    // Do not trust export `originalAmount` — recover from ledger ÷ rate
    // (upstream #513: originalAmount often drops cents). Once per parse only.
    const shouldRecover = shouldRecoverSpliitOriginal({
      originalCurrency: e.originalCurrency,
      conversionRate: e.conversionRate,
    })
    const expenseAmount = shouldRecover
      ? recoverSpliitOriginalAmount(e.amount, e.conversionRate!)
      : e.amount
    const expenseCurrency = shouldRecover
      ? e.originalCurrency!
      : parsed.currencyCode || null
    const recurrence = legacyRuleToRecurrence(e.recurrenceRule)

    return {
      sourceId: e.id ?? null,
      sourceCreatedAt: e.createdAt ?? null,
      title: e.title,
      expenseDate: e.expenseDate.slice(0, 10),
      category: e.isReimbursement
        ? SETTLEMENT_CATEGORY_ID
        : resolveCategoryId(e.category ?? null),
      amountCurrency: expenseCurrency,
      amount: expenseAmount,
      originalAmount: shouldRecover ? expenseAmount : null,
      originalCurrency: shouldRecover ? e.originalCurrency! : null,
      conversionRate: shouldRecover ? e.conversionRate! : null,
      paidBySourceId,
      paidBy: [{ sourceId: paidBySourceId, shares: expenseAmount }],
      paidFor,
      splitMode: e.splitMode,
      recurrenceRule: e.recurrenceRule,
      recurrence,
      notes: e.notes ?? null,
      ...(parsed.exportVersion === 3
        ? {
            sourceDocuments: (e.documents ?? []).map((document) => ({
              sourceId: document.id,
              sourceUrl: document.url,
              width: document.width,
              height: document.height,
            })),
          }
        : {}),
    }
  })

  const activities = parsed.activities?.map((activity) => ({
    time: activity.time,
    activityType: activity.activityType,
    participantSourceId: activity.participantId
      ? (upstreamIdToSourceId.get(activity.participantId) ?? null)
      : null,
    expenseSourceId: activity.expenseId,
    data: activity.data,
  }))

  return {
    provider: 'SPLIIT',
    exportVersion: parsed.exportVersion ?? null,
    sourceGroupId: parsed.id,
    sourceUrl: `https://spliit.app/groups/${parsed.id}`,
    name: parsed.name,
    information: parsed.information ?? null,
    currency: parsed.currency,
    currencyCode: parsed.currencyCode || null,
    participants,
    expenses,
    documentSource: parsed.exportVersion === 3 ? 'EMBEDDED' : 'DISCOVERY',
    ...(activities !== undefined ? { activities } : {}),
  }
}

export function parseSpliitExport(input: unknown): NormalizedSource {
  return normalizeSpliitExport(spliitExportSchema.parse(input))
}

export function tryParseSpliitExport(input: unknown): ImportParseResult {
  try {
    return { ok: true, source: parseSpliitExport(input) }
  } catch (err) {
    if (err instanceof ImportError)
      return {
        ok: false,
        error: err.message,
        code: err.code,
        params: err.params,
      }
    if (err instanceof z.ZodError) {
      return {
        ok: false,
        error: 'This file is not a supported spliit.app JSON export.',
        code: 'SPLIIT_UNSUPPORTED_SHAPE',
        params: {},
      }
    }
    // Fully dynamic upstream passthrough: no static source text to translate,
    // so no code — UI falls back to the raw English message.
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Invalid Spliit export',
    }
  }
}

export function buildSpliitGroupFetchUrl(
  groupId: string,
  base: string = 'https://spliit.app',
): string {
  const trimmed = groupId.replace(/^\/+|\/+$/g, '')
  return `${base.replace(/\/+$/, '')}/groups/${trimmed}/expenses/export/json`
}

export function extractSpliitGroupIdFromUrl(input: string): string | null {
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (!/^(www\.)?spliit\.app$/i.test(url.hostname)) return null
  const match = url.pathname.match(/^\/groups\/([^/?#]+)/)
  if (!match) return null
  const id = match[1].replace(/^\/+|\/+$/g, '')
  return id.length > 0 ? id : null
}
