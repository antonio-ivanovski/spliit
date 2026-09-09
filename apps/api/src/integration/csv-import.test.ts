import { createHash } from 'node:crypto'

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { prisma } from '@spliit/db'
import { env as jobsEnv } from '@spliit/jobs'

import type * as CreateManyInBatches from '../lib/api/create-many-in-batches'
import {
  importExpenseFile,
  compensateImportAttempt,
  externalIdentityHash,
  prepareExpenseFileImport,
  type ExpenseFileImportRow,
} from '../lib/api/expenses/csv-import'
import type * as ExpensesHelpers from '../lib/api/expenses/helpers'
import { getApiBossForWrite } from '../lib/api/recurrence-series'
import type * as RecurrenceSeries from '../lib/api/recurrence-series'
import { enqueueBudgetEvaluation } from '../lib/budgets/enqueue'
import type * as CurrencyRates from '../lib/currency-rates'
import { keyFromFileUrl } from '../lib/storage'
import type * as Storage from '../lib/storage'
import { groupsRouter } from '../trpc/routers/groups'
import {
  checkDbConnection,
  initializeTestAccountTimeZone,
  testRunId,
} from './setup'

vi.mock('../lib/budgets/enqueue', () => ({
  enqueueBudgetEvaluation: vi.fn().mockResolvedValue(undefined),
}))

// Spy through to the real implementation: lets the promotion-ordering test
// below assert that preparation promotes staged documents before the
// transaction validates rows (in-test uploads are unconfigured, so the
// call-through is a no-op for every other test).
vi.mock('../lib/api/expenses/helpers', async (importOriginal) => {
  const actual = await importOriginal<ExpensesHelpers>()
  return {
    ...actual,
    promoteExpenseDocuments: vi.fn(actual.promoteExpenseDocuments),
    promoteExpenseDocumentsDetailed: vi.fn(
      actual.promoteExpenseDocumentsDetailed,
    ),
  }
})

// Fail every rate lookup: no existing test needs real FX (plain-amount
// expenses never call fetchImpl), so this only affects the tests below that
// exercise exchange conversions.
// Spy the recurrence-series module so the dependency-ordering test can fail
// boss acquisition on demand; every other test calls through.
vi.mock('../lib/api/recurrence-series', async (importOriginal) => {
  const actual = await importOriginal<RecurrenceSeries>()
  return {
    ...actual,
    getApiBossForWrite: vi.fn(actual.getApiBossForWrite),
  }
})

vi.mock('../lib/currency-rates', async (importOriginal) => {
  const actual = await importOriginal<CurrencyRates>()
  return {
    ...actual,
    getCurrencyRates: vi
      .fn()
      .mockResolvedValue([
        { ok: false as const, error: { message: 'provider down' } },
      ]),
  }
})

// Spy through to the real batcher: the later-chunk rollback test below fails
// exactly the second chunk on demand; every other test calls through
// untouched (default implementation preserved).
vi.mock('../lib/api/create-many-in-batches', async (importOriginal) => {
  const actual = await importOriginal<CreateManyInBatches>()
  return {
    ...actual,
    createManyInBatches: vi.fn(actual.createManyInBatches),
  }
})

// In-memory object store for the document-ownership suite below. Tests flip
// `storageOverrides` to simulate a configured uploader; every other suite
// keeps the real default (unconfigured uploads, promotion is a passthrough).
const storageOverrides: {
  uploadsConfigured?: boolean
  failCopyKeys?: Set<string>
  failDeleteKeys?: Set<string>
} = {}
const fakeBucket = new Map<string, true>()
const fakeDeleteCalls: string[] = []
const fakeCopyCalls: string[] = []
function fakeBucketKey(url: string) {
  // The real key parser: test env sets S3_UPLOAD_PUBLIC_URL with a path
  // prefix, so naive pathname slicing diverges from the keys the importer
  // actually copies and deletes.
  return keyFromFileUrl(url)
}
vi.mock('../lib/storage', async (importOriginal) => {
  const actual = await importOriginal<Storage>()
  return {
    // Explicit passthrough (no namespace spread: spreading the module
    // namespace trips no-misused-spread).
    keyFromFileUrl: actual.keyFromFileUrl,
    publicUrlForKey: actual.publicUrlForKey,
    getS3Object: actual.getS3Object,
    uploadsConfigured: () =>
      storageOverrides.uploadsConfigured ?? actual.uploadsConfigured(),
    getS3Client: () => {
      if (storageOverrides.uploadsConfigured !== true)
        return actual.getS3Client()
      return {
        send: async (command: unknown) => {
          if (command instanceof HeadObjectCommand) {
            if (!fakeBucket.has(command.input.Key!)) {
              const missing = new Error('NotFound') as Error & {
                $metadata: { httpStatusCode: number }
              }
              missing.$metadata = { httpStatusCode: 404 }
              throw missing
            }
            return {}
          }
          if (command instanceof CopyObjectCommand) {
            const sourceKey = decodeURIComponent(
              String(command.input.CopySource).split('/').slice(1).join('/'),
            )
            if (!fakeBucket.has(sourceKey)) {
              throw new Error(`NoSuchKey: ${sourceKey}`)
            }
            fakeCopyCalls.push(command.input.Key!)
            if (command.input.Key!.includes('shared-doc.pdf')) {
              // Deferred promotion: hold the first copy briefly so a second
              // worker referencing the same staged URL is guaranteed
              // in flight before it resolves.
              await new Promise((resolve) => setTimeout(resolve, 50))
            }
            if (
              [...(storageOverrides.failCopyKeys ?? [])].some((part) =>
                command.input.Key!.includes(part),
              )
            ) {
              throw new Error(`CopyFailed: ${command.input.Key}`)
            }
            fakeBucket.set(command.input.Key!, true)
            return {}
          }
          if (command instanceof DeleteObjectCommand) {
            fakeDeleteCalls.push(command.input.Key!)
            if (
              [...(storageOverrides.failDeleteKeys ?? [])].some((part) =>
                command.input.Key!.includes(part),
              )
            ) {
              throw new Error(`DeleteFailed: ${command.input.Key}`)
            }
            fakeBucket.delete(command.input.Key!)
            return {}
          }
          throw new Error(
            `unsupported fake S3 command: ${command?.constructor?.name}`,
          )
        },
      }
    },
  }
})

await checkDbConnection()

describe('expense file import', () => {
  const runId = testRunId()
  const accountId = `csv-import-${runId}`
  const email = `${accountId}@test.example`
  const ledgerIds: string[] = []

  let groupId: string
  let ledgerId: string
  let participantId: string

  function caller() {
    return groupsRouter.createCaller({
      auth: {
        session: { id: `session-${runId}` },
        user: {
          id: accountId,
          email,
          emailVerified: true,
          name: 'CSV Importer',
        },
      },
    } as never)
  }

  beforeAll(async () => {
    await prisma.account.create({
      data: {
        id: accountId,
        email,
        emailVerified: true,
        name: 'CSV Importer',
      },
    })
    // Recurring imports resolve recurrence configs, which require the
    // bootstrapped account timezone that browser flows establish.
    await initializeTestAccountTimeZone(accountId)
    const created = await caller().create({
      requestId: crypto.randomUUID(),
      groupFormValues: {
        name: `CSV Import ${runId}`,
        currency: '$',
        currencyCode: 'USD',
        participants: [{ name: 'CSV Importer' }],
      },
    })
    groupId = created.groupId
    const group = await prisma.group.findUniqueOrThrow({
      where: { id: groupId },
      include: {
        ledger: true,
        members: { include: { ledgerParticipant: true } },
      },
    })
    ledgerId = group.ledger.id
    ledgerIds.push(ledgerId)
    participantId = group.members[0]!.ledgerParticipant!.id
  })

  afterAll(async () => {
    for (const id of ledgerIds) {
      await prisma.ledger.delete({ where: { id } }).catch(() => {})
    }
    await prisma.account.delete({ where: { id: accountId } }).catch(() => {})
  })

  it('previews duplicates, imports complete drafts atomically, and replays safely', async () => {
    const requestId = crypto.randomUUID()
    const rows = [
      {
        rowId: 'row-2',
        rowNumber: 2,
        source: {
          baseFingerprint: 'a'.repeat(64),
          originFingerprint: 'b'.repeat(64),
        },
        expense: {
          expenseDate: new Date('2026-02-15T12:00:00.000Z'),
          expenseTimeZone: 'UTC',
          title: 'Coffee shop',
          category: 'general',
          amount: 1250,
          paidBySplitMode: 'BY_AMOUNT',
          paidByList: [{ participant: participantId, shares: 1250 }],
          isMultiPayer: false,
          splitMode: 'EVENLY',
          paidFor: [{ participant: participantId, shares: 1 }],
          documents: [],
          notes: 'Imported from a statement',
          items: [
            {
              title: 'Coffee',
              unitPrice: 1250,
              quantity: 1,
              amount: 1250,
              splitMode: 'EVENLY',
              paidFor: [{ participant: participantId, shares: 1 }],
            },
          ],
          recurrenceRule: 'NONE',
        },
      },
    ]

    const currentFilePreview = await caller().expenses.previewImportDuplicates({
      groupId,
      rows: [
        rows[0]!,
        {
          ...rows[0]!,
          rowId: 'row-3',
          rowNumber: 3,
          source: {
            baseFingerprint: 'a'.repeat(64),
            originFingerprint: 'c'.repeat(64),
          },
        },
      ],
    })
    expect(currentFilePreview.rows[1]?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'CURRENT_FILE:row-2',
          kind: 'CURRENT_FILE',
          sourceRowId: 'row-2',
        }),
      ]),
    )

    const imported = await caller().expenses.importFile({
      requestId,
      groupId,
      rows,
    })
    expect(imported.importedCount).toBe(1)
    expect(imported.expenseIds).toHaveLength(1)

    const replayed = await caller().expenses.importFile({
      requestId,
      groupId,
      rows,
    })
    expect(replayed).toEqual(imported)

    const expense = await prisma.expense.findUniqueOrThrow({
      where: { id: imported.expenseIds[0] },
      include: { fileImportSource: true },
    })
    expect(expense.fileImportSource?.provider).toBe('GENERIC_CSV')
    expect(expense.fileImportSource?.importKey).toMatch(/^[0-9a-f]{64}$/)
    expect(expense.fileImportSource?.ledgerId).toBe(ledgerId)
    expect(expense.fileImportSource?.externalIdentityHash).toBeNull()

    const duplicatePreview = await caller().expenses.previewImportDuplicates({
      groupId,
      rows,
    })
    expect(duplicatePreview.rows[0]?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'EXACT_IMPORT',
          expenseId: expense.id,
        }),
      ]),
    )

    const stored = await prisma.expense.findUniqueOrThrow({
      where: { id: expense.id },
      include: { items: true },
    })
    expect(stored.notes).toBe('Imported from a statement')
    expect(stored.items).toEqual([
      expect.objectContaining({ title: 'Coffee', amount: 1250 }),
    ])

    const historyPreview = await caller().expenses.previewImportDuplicates({
      groupId,
      rows: [
        {
          ...rows[0]!,
          rowId: 'history-row',
          source: {
            baseFingerprint: 'd'.repeat(64),
            originFingerprint: 'e'.repeat(64),
          },
          expense: { ...rows[0]!.expense, title: 'Coffee—shop' },
        },
      ],
    })
    expect(historyPreview.rows[0]?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: `EXISTING_EXPENSE:${expense.id}`,
          kind: 'EXISTING_EXPENSE',
        }),
      ]),
    )

    const activities = await prisma.activity.findMany({
      where: { ledgerId },
      orderBy: { time: 'asc' },
    })
    expect(
      activities.some(
        (activity) =>
          activity.type === 'EXPENSES_IMPORTED' && activity.visibleInGroupFeed,
      ),
    ).toBe(true)
    expect(
      activities.some(
        (activity) =>
          activity.type === 'EXPENSE_CREATED' &&
          activity.subjectId === expense.id &&
          !activity.visibleInGroupFeed,
      ),
    ).toBe(true)
  })

  it('imports a large ordinary batch through bulk relation writes', async () => {
    const rows = Array.from({ length: 300 }, (_, index) => {
      const fingerprint = index.toString(16).padStart(64, '0')
      return {
        rowId: `bulk-row-${index}`,
        rowNumber: index + 2,
        source: {
          baseFingerprint: fingerprint,
          originFingerprint: fingerprint,
        },
        expense: {
          expenseDate: new Date(
            `2026-03-${String((index % 9) + 1).padStart(2, '0')}T12:00:00.000Z`,
          ),
          expenseTimeZone: 'UTC',
          title: `Bulk expense ${index}`,
          category: 'general',
          amount: 1000 + index,
          paidBySplitMode: 'BY_AMOUNT',
          paidByList: [{ participant: participantId, shares: 1000 + index }],
          isMultiPayer: false,
          splitMode: 'EVENLY',
          paidFor: [{ participant: participantId, shares: 1 }],
          documents: [],
          recurrenceRule: 'NONE',
        },
      }
    })

    const countImported = () =>
      Promise.all([
        prisma.expense.count({
          where: { ledgerId, fileImportSource: { isNot: null } },
        }),
        prisma.expensePaidBy.count({
          where: {
            expense: { ledgerId, fileImportSource: { isNot: null } },
          },
        }),
        prisma.expensePaidFor.count({
          where: {
            expense: { ledgerId, fileImportSource: { isNot: null } },
          },
        }),
        prisma.activity.count({
          where: {
            ledgerId,
            type: 'EXPENSE_CREATED',
            visibleInGroupFeed: false,
          },
        }),
      ])
    // Scoped deltas, not absolute ledger counts: earlier tests in this file
    // share the ledger, so asserting totals would couple this test to their
    // row counts and order.
    const [expensesBefore, paidByBefore, paidForBefore, activitiesBefore] =
      await countImported()

    const imported = await caller().expenses.importFile({
      requestId: crypto.randomUUID(),
      groupId,
      rows,
    })
    expect(imported.importedCount).toBe(300)

    const [expenses, paidBy, paidFor, activities] = await countImported()
    expect(expenses - expensesBefore).toBe(300)
    expect(paidBy - paidByBefore).toBe(300)
    expect(paidFor - paidForBefore).toBe(300)
    expect(activities - activitiesBefore).toBe(300)

    // Every bulk row writes immutable provenance, and origin fingerprints
    // are unique per row, so stored import keys must be unique as well —
    // scoped to this import's expenses, not the shared ledger.
    const sources = await prisma.expenseFileImportSource.findMany({
      where: { expenseId: { in: imported.expenseIds } },
      select: { importKey: true },
    })
    expect(sources.length).toBe(300)
    expect(new Set(sources.map((source) => source.importKey)).size).toBe(
      sources.length,
    )
  })

  it('imports a batch crossing the 1,000-row chunk boundary', async () => {
    // 1,050 plain rows: every bulk table writes two chunks. Scoped deltas
    // (not absolute counts) keep this independent of the shared ledger.
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:chunk:${seed}`).digest('hex')
    const rows = Array.from({ length: 1050 }, (_, index) => ({
      rowId: `chunk-row-${index}`,
      rowNumber: 5000 + index,
      source: {
        baseFingerprint: fp(`base-${index}`),
        originFingerprint: fp(`origin-${index}`),
      },
      expense: {
        expenseDate: new Date('2026-09-15T12:00:00.000Z'),
        expenseTimeZone: 'UTC',
        title: `Chunk expense ${index}`,
        category: 'general',
        // Distinctive range (other tests share this ledger): fuzzy matching
        // needs date+amount+title, so no probe can collide with these.
        amount: 90000 + index,
        paidBySplitMode: 'BY_AMOUNT',
        paidByList: [{ participant: participantId, shares: 90000 + index }],
        isMultiPayer: false,
        splitMode: 'EVENLY',
        paidFor: [{ participant: participantId, shares: 1 }],
        documents: [],
        recurrenceRule: 'NONE',
      },
    }))
    const countImported = () =>
      Promise.all([
        prisma.expense.count({
          where: { ledgerId, fileImportSource: { isNot: null } },
        }),
        prisma.expenseFileImportSource.count({ where: { ledgerId } }),
        prisma.activity.count({
          where: {
            ledgerId,
            type: 'EXPENSE_CREATED',
            visibleInGroupFeed: false,
          },
        }),
      ])
    const [expensesBefore, sourcesBefore, activitiesBefore] =
      await countImported()

    const imported = await caller().expenses.importFile({
      requestId: crypto.randomUUID(),
      groupId,
      rows,
    })
    expect(imported.importedCount).toBe(1050)
    expect(imported.expenseIds).toHaveLength(1050)

    const [expenses, sources, activities] = await countImported()
    expect(expenses - expensesBefore).toBe(1050)
    expect(sources - sourcesBefore).toBe(1050)
    expect(activities - activitiesBefore).toBe(1050)
  })

  it('rolls back committed chunks when a later chunk fails', async () => {
    const { createManyInBatches } =
      await import('../lib/api/create-many-in-batches')
    const batcher = vi.mocked(createManyInBatches)
    const through = batcher.getMockImplementation()
    expect(through).toBeDefined()
    // 1,005 plain rows: the first expense chunk (1,000) commits inside the
    // transaction, the second chunk (5) throws. Pre-write validation runs
    // before any write by design, so it cannot catch this class of failure —
    // only the transaction boundary saves the batch.
    batcher.mockImplementationOnce(through!)
    batcher.mockImplementationOnce(async () => {
      throw new Error('boom-chunk-2')
    })
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:rollback:${seed}`).digest('hex')
    const rows = Array.from({ length: 1005 }, (_, index) => ({
      rowId: `rollback-row-${index}`,
      rowNumber: 7000 + index,
      source: {
        baseFingerprint: fp(`base-${index}`),
        originFingerprint: fp(`origin-${index}`),
      },
      expense: {
        expenseDate: new Date('2026-09-16T12:00:00.000Z'),
        expenseTimeZone: 'UTC',
        title: `Rollback probe ${index}`,
        category: 'general',
        amount: 95000 + index,
        paidBySplitMode: 'BY_AMOUNT',
        paidByList: [{ participant: participantId, shares: 95000 + index }],
        isMultiPayer: false,
        splitMode: 'EVENLY',
        paidFor: [{ participant: participantId, shares: 1 }],
        documents: [],
        recurrenceRule: 'NONE',
      },
    }))
    const countImported = () =>
      Promise.all([
        prisma.expense.count({
          where: { ledgerId, fileImportSource: { isNot: null } },
        }),
        prisma.expenseFileImportSource.count({ where: { ledgerId } }),
      ])
    const before = await countImported()
    // The thrown chunk message must stay out of the logs: the failure
    // outcome carries only the allowlisted error kind.
    const warnLines: string[] = []
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation((...args: unknown[]) => {
        warnLines.push(args.map(String).join(' '))
      })
    let failure: { message?: unknown }
    try {
      failure = await importExpenseFile({ groupId, accountId, rows }, {}).then(
        () => {
          throw new Error('expected a chunk failure')
        },
        (cause) => cause as { message?: unknown },
      )
    } finally {
      warnSpy.mockRestore()
    }
    expect(String(failure.message)).toContain('boom-chunk-2')
    // The first chunk's rows were written, then the whole transaction rolled
    // back: zero imports, zero provenance, zero orphaned documents.
    expect(await countImported()).toEqual(before)
    const failed = warnLines.find((line) => line.includes('"phase":"failed"'))
    expect(failed).toContain('"errorCode":"Error"')
    expect(warnLines.map(String).join('\n')).not.toContain('boom-chunk-2')
    // Incremental timings: the failure interrupted the writes phase, so the
    // log carries every completed phase plus the failed phase — but no
    // `writesMs`/`recurringMs` that would imply those phases finished.
    expect(failed).toContain('"lockWaitMs"')
    expect(failed).toContain('"duplicatesMs"')
    expect(failed).toContain('"validationMs"')
    expect(failed).toContain('"failedPhase":"writes"')
    expect(failed).toContain('"failedPhaseElapsedMs"')
    expect(failed).not.toContain('"writesMs"')
    expect(failed).not.toContain('"recurringMs"')
  })

  it('attributes summary work to its own phase when the summary write fails', async () => {
    // Boundary regression for the timing tracker: `recurringMs` must cover
    // recurrence only, and a failure during summary activity/notification
    // planning must retain the completed phases with
    // `failedPhase: 'summary'` — never an empty timing breakdown, and never
    // summary work folded into recurrence.
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:summary:${seed}`).digest('hex')
    const rows = [
      {
        rowId: 'summary-row',
        rowNumber: 8301,
        source: {
          baseFingerprint: fp('base'),
          originFingerprint: fp('origin'),
        },
        expense: {
          expenseDate: new Date('2026-10-02T12:00:00.000Z'),
          expenseTimeZone: 'UTC',
          title: 'Summary probe',
          category: 'general',
          amount: 66002,
          paidBySplitMode: 'BY_AMOUNT',
          paidByList: [{ participant: participantId, shares: 66002 }],
          isMultiPayer: false,
          splitMode: 'EVENLY',
          paidFor: [{ participant: participantId, shares: 1 }],
          documents: [],
          recurrenceRule: 'NONE',
        },
      },
    ]
    const countImported = () =>
      Promise.all([
        prisma.expense.count({
          where: { ledgerId, fileImportSource: { isNot: null } },
        }),
        prisma.expenseFileImportSource.count({ where: { ledgerId } }),
      ])
    const before = await countImported()
    // Collide with the prepared summary activity id: the in-transaction
    // summary write then hits a primary-key conflict and the whole attempt
    // rolls back — after every write phase completed.
    const prepared = await prepareExpenseFileImport(groupId, accountId, rows)
    await prisma.activity.create({
      data: {
        id: prepared.summaryActivityId,
        ledgerId,
        type: 'EXPENSES_IMPORTED',
      },
    })
    const warnLines: string[] = []
    const warnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation((...args: unknown[]) => {
        warnLines.push(args.map(String).join(' '))
      })
    try {
      const failure = await importExpenseFile(
        { groupId, accountId, rows },
        { prepared },
      ).then(
        () => {
          throw new Error('expected a summary failure')
        },
        (cause) => cause as { message?: unknown },
      )
      expect(failure).toBeDefined()
      // Nothing persisted: the summary write is inside the same transaction
      // as the bulk writes.
      expect(await countImported()).toEqual(before)
      const failed = warnLines.find((line) => line.includes('"phase":"failed"'))
      expect(failed).toContain('"failedPhase":"summary"')
      expect(failed).toContain('"failedPhaseElapsedMs"')
      // Every write phase completed first: durations retained, including the
      // recurrence-only `recurringMs` (no recurring rows, no summary work).
      expect(failed).toContain('"lockWaitMs"')
      expect(failed).toContain('"duplicatesMs"')
      expect(failed).toContain('"validationMs"')
      expect(failed).toContain('"writesMs"')
      expect(failed).toContain('"recurringMs"')
      expect(failed).not.toContain('"summaryMs"')
      // The conflict detail (ids, constraint text) stays out of the logs:
      // only the allowlisted error kind crosses over.
      expect(failed).toContain('"errorCode":"PrismaClientKnownRequestError"')
      const allWarn = warnLines.map(String).join('\n')
      expect(allWarn).not.toContain(prepared.summaryActivityId)
    } finally {
      warnSpy.mockRestore()
      await prisma.activity
        .delete({ where: { id: prepared.summaryActivityId } })
        .catch(() => {})
    }
  })

  it('logs write outcomes from the transaction owner', async () => {
    // Outcome phases emit from the owner, never from inside the write
    // transaction: `writes-complete` in-tx, then `committed` after the
    // database commit or `failed` when the attempt cannot commit. No line
    // may claim `commit` before the commit is known.
    const lines: string[] = []
    const infoSpy = vi
      .spyOn(console, 'info')
      .mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '))
      })
    try {
      const fp = (seed: string) =>
        createHash('sha256').update(`${runId}:outcome:${seed}`).digest('hex')
      const outcomeRow = (name: string, rowNumber: number) => ({
        rowId: `outcome-${name}`,
        rowNumber,
        source: {
          baseFingerprint: fp('base'),
          originFingerprint: fp('origin'),
        },
        expense: {
          expenseDate: new Date('2026-10-01T12:00:00.000Z'),
          expenseTimeZone: 'UTC',
          title: 'Outcome probe',
          category: 'general',
          amount: 66001,
          paidBySplitMode: 'BY_AMOUNT',
          paidByList: [{ participant: participantId, shares: 66001 }],
          isMultiPayer: false,
          splitMode: 'EVENLY',
          paidFor: [{ participant: participantId, shares: 1 }],
          documents: [],
          recurrenceRule: 'NONE',
        },
      })
      const ok = await caller().expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: [outcomeRow('ok', 8201)],
      })
      expect(ok.importedCount).toBe(1)

      // Same fingerprints, unapproved: exact re-import conflict.
      const failure = await caller()
        .expenses.importFile({
          requestId: crypto.randomUUID(),
          groupId,
          rows: [outcomeRow('conflict', 8202)],
        })
        .then(
          () => {
            throw new Error('expected a CONFLICT rejection')
          },
          (cause) => cause as { code?: unknown },
        )
      expect(failure).toMatchObject({ code: 'CONFLICT' })
    } finally {
      infoSpy.mockRestore()
    }
    const phases = lines.flatMap((line) => {
      const match = /"phase":"([a-z-]+)"/.exec(line)
      return match?.[1] ? [match[1]] : []
    })
    expect(phases).toContain('prepare')
    expect(phases).toContain('writes-complete')
    expect(phases).toContain('committed')
    expect(phases).toContain('failed')
    expect(phases).not.toContain('commit')
    const failed = lines.find((line) => line.includes('"phase":"failed"'))
    expect(failed).toContain('"errorCode":"CONFLICT"')
    // Incremental timings: the duplicate conflict rejected after the scan,
    // so the failure carries the completed phases — but no validation/writes
    // timings and no `failedPhase` (no measured phase was interrupted).
    expect(failed).toContain('"lockWaitMs"')
    expect(failed).toContain('"duplicatesMs"')
    expect(failed).not.toContain('"validationMs"')
    expect(failed).not.toContain('"failedPhase"')
    const committed = lines.find((line) => line.includes('"phase":"committed"'))
    expect(committed).toContain('"rows":1')
    expect(committed).toContain('"validationMs"')
    expect(committed).toContain('"writesMs"')
    expect(committed).toContain('"recurringMs"')
    expect(committed).toContain('"summaryMs"')
    expect(committed).not.toContain('"failedPhase"')
  })

  it('finds duplicates across distant date windows', async () => {
    // Two history expenses months apart: a single broad range would scan
    // everything between them; narrow windows must still find both.
    const seed = (
      name: string,
      date: string,
      title: string,
      amount: number,
    ) => ({
      rowId: `window-seed-${name}`,
      rowNumber: name === 'june' ? 8101 : 8102,
      source: {
        baseFingerprint: createHash('sha256')
          .update(`${runId}:window:seed-base:${name}`)
          .digest('hex'),
        originFingerprint: createHash('sha256')
          .update(`${runId}:window:seed-origin:${name}`)
          .digest('hex'),
      },
      expense: {
        expenseDate: new Date(`${date}T12:00:00.000Z`),
        expenseTimeZone: 'UTC',
        title,
        category: 'general',
        amount,
        paidBySplitMode: 'BY_AMOUNT',
        paidByList: [{ participant: participantId, shares: amount }],
        isMultiPayer: false,
        splitMode: 'EVENLY',
        paidFor: [{ participant: participantId, shares: 1 }],
        documents: [],
        recurrenceRule: 'NONE',
      },
    })
    const seeded = await caller().expenses.importFile({
      requestId: crypto.randomUUID(),
      groupId,
      rows: [
        seed('june', '2025-06-15', 'Window probe june', 77771),
        seed('august', '2025-08-20', 'Window probe august', 77772),
      ],
    })
    expect(seeded.importedCount).toBe(2)
    const [juneId, augustId] = seeded.expenseIds

    const probe = (
      name: string,
      date: string,
      title: string,
      amount: number,
      rowNumber: number,
    ) => ({
      rowId: `window-probe-${name}`,
      rowNumber,
      source: {
        baseFingerprint: createHash('sha256')
          .update(`${runId}:window:probe-base:${name}`)
          .digest('hex'),
        originFingerprint: createHash('sha256')
          .update(`${runId}:window:probe-origin:${name}`)
          .digest('hex'),
      },
      expense: {
        expenseDate: new Date(`${date}T12:00:00.000Z`),
        expenseTimeZone: 'UTC',
        title,
        category: 'general',
        amount,
        paidBySplitMode: 'BY_AMOUNT',
        paidByList: [{ participant: participantId, shares: amount }],
        isMultiPayer: false,
        splitMode: 'EVENLY',
        paidFor: [{ participant: participantId, shares: 1 }],
        documents: [],
        recurrenceRule: 'NONE',
      },
    })
    const preview = await caller().expenses.previewImportDuplicates({
      groupId,
      rows: [
        // Same date+amount+title as a seed: fuzzy match, not exact (fresh
        // fingerprints carry no provenance).
        probe('june', '2025-06-15', 'Window probe june', 77771, 8111),
        probe('august', '2025-08-20', 'Window probe august', 77772, 8112),
        // Same date+title, different amount: the SQL amount filter skips it
        // and the in-memory check must not flag it either.
        probe('june-amount', '2025-06-15', 'Window probe june', 77779, 8113),
        // Mid-range date, unknown amount: clean.
        probe('july', '2025-07-10', 'Window probe july', 77773, 8114),
      ],
    })
    const matchesFor = (rowId: string) =>
      preview.rows.find((row) => row.rowId === rowId)?.matches ?? []
    expect(matchesFor('window-probe-june')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'EXISTING_EXPENSE',
          expenseId: juneId,
        }),
      ]),
    )
    expect(matchesFor('window-probe-august')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'EXISTING_EXPENSE',
          expenseId: augustId,
        }),
      ]),
    )
    expect(matchesFor('window-probe-june-amount')).toEqual([])
    expect(matchesFor('window-probe-july')).toEqual([])
  })

  it('matches by bank transaction id even when the row fingerprint changes', async () => {
    const base = {
      rowNumber: 2,
      source: {
        baseFingerprint: 'e'.repeat(64),
        originFingerprint: 'f'.repeat(64),
      },
      externalId: 'bank-txn-001',
      sourceAccount: 'checking-42',
      expense: {
        expenseDate: new Date('2026-04-10T12:00:00.000Z'),
        expenseTimeZone: 'UTC',
        title: 'Grocery run',
        category: 'general',
        amount: 4200,
        paidBySplitMode: 'BY_AMOUNT',
        paidByList: [{ participant: participantId, shares: 4200 }],
        isMultiPayer: false,
        splitMode: 'EVENLY',
        paidFor: [{ participant: participantId, shares: 1 }],
        documents: [],
        recurrenceRule: 'NONE',
      },
    }
    const imported = await caller().expenses.importFile({
      requestId: crypto.randomUUID(),
      groupId,
      rows: [{ ...base, rowId: 'ext-row-1' }],
    })
    expect(imported.importedCount).toBe(1)

    const source = await prisma.expenseFileImportSource.findUniqueOrThrow({
      where: { expenseId: imported.expenseIds[0] },
    })
    expect(source.externalIdentityHash).toBe(
      externalIdentityHash('bank-txn-001', 'checking-42'),
    )

    // Same bank transaction re-exported with a different fingerprint and an
    // edited title still resolves to the previously imported expense.
    const preview = await caller().expenses.previewImportDuplicates({
      groupId,
      rows: [
        {
          ...base,
          rowId: 'ext-row-2',
          source: {
            baseFingerprint: '1'.repeat(64),
            originFingerprint: '2'.repeat(64),
          },
          expense: { ...base.expense, title: 'GROCERY RUN #12' },
        },
      ],
    })
    expect(preview.rows[0]?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'EXACT_IMPORT',
          expenseId: imported.expenseIds[0],
        }),
      ]),
    )
  })

  it('rejects duplicate-flagged rows without approval and persists zero expenses', async () => {
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:nack:${seed}`).digest('hex')
    const externalId = `dup-nack-${runId}`
    const sourceAccount = 'dup-acct-nack'
    const baseExpense = {
      expenseDate: new Date('2026-05-10T12:00:00.000Z'),
      expenseTimeZone: 'UTC',
      title: 'Duplicate seed nack',
      category: 'general',
      amount: 5000,
      paidBySplitMode: 'BY_AMOUNT',
      paidByList: [{ participant: participantId, shares: 5000 }],
      isMultiPayer: false,
      splitMode: 'EVENLY',
      paidFor: [{ participant: participantId, shares: 1 }],
      documents: [],
      recurrenceRule: 'NONE',
    }
    const seed = await caller().expenses.importFile({
      requestId: crypto.randomUUID(),
      groupId,
      rows: [
        {
          rowId: 'dup-seed-nack',
          rowNumber: 111,
          source: {
            baseFingerprint: fp('seed-base'),
            originFingerprint: fp('seed-origin'),
          },
          externalId,
          sourceAccount,
          expense: baseExpense,
        },
      ],
    })
    expect(seed.importedCount).toBe(1)

    const candidate = {
      rowId: 'dup-candidate-nack',
      rowNumber: 112,
      source: {
        baseFingerprint: fp('cand-base'),
        originFingerprint: fp('cand-origin'),
      },
      externalId,
      sourceAccount,
      expense: {
        ...baseExpense,
        title: 'Duplicate seed nack re-export',
        documents: [
          { id: 'doc-nack-1', url: 'https://example.com/nack-doc.pdf' },
        ],
      },
    }
    const preview = await caller().expenses.previewImportDuplicates({
      groupId,
      rows: [candidate],
    })
    expect(preview.rows[0]?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'EXACT_IMPORT',
          expenseId: seed.expenseIds[0],
        }),
      ]),
    )

    const before = await prisma.expense.count({ where: { ledgerId } })
    const documentsBefore = await prisma.expenseDocument.count({
      where: { ledgerId },
    })
    const failure = await caller()
      .expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: [candidate],
      })
      .then(
        () => {
          throw new Error('expected a CONFLICT rejection')
        },
        (cause) => cause as { code?: unknown; cause?: unknown },
      )
    expect(failure).toMatchObject({ code: 'CONFLICT' })
    // The client-visible error carries the actionable match keys so the
    // caller can approve exactly these without re-running the preview.
    const conflicts = (
      failure as {
        cause?: { conflicts?: Array<{ rowId: string; matchKeys: string[] }> }
      }
    ).cause?.conflicts
    expect(conflicts).toHaveLength(1)
    expect(conflicts?.[0]).toMatchObject({
      rowId: 'dup-candidate-nack',
      rowNumber: 112,
    })
    expect(conflicts?.[0]?.matchKeys).toEqual(
      expect.arrayContaining([`EXACT_IMPORT:${seed.expenseIds[0]}`]),
    )
    const after = await prisma.expense.count({ where: { ledgerId } })
    expect(after).toBe(before)
    // The rejected import promoted no documents either: document promotion
    // runs after the duplicate check, so the 0-approval path leaves neither
    // document rows nor orphaned stored objects behind.
    const documentsAfter = await prisma.expenseDocument.count({
      where: { ledgerId },
    })
    expect(documentsAfter).toBe(documentsBefore)
  })

  it('imports duplicate-flagged rows when every match key is approved', async () => {
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:ack:${seed}`).digest('hex')
    const externalId = `dup-ack-${runId}`
    const sourceAccount = 'dup-acct-ack'
    const baseExpense = {
      expenseDate: new Date('2026-05-11T12:00:00.000Z'),
      expenseTimeZone: 'UTC',
      title: 'Duplicate seed ack',
      category: 'general',
      amount: 6100,
      paidBySplitMode: 'BY_AMOUNT',
      paidByList: [{ participant: participantId, shares: 6100 }],
      isMultiPayer: false,
      splitMode: 'EVENLY',
      paidFor: [{ participant: participantId, shares: 1 }],
      documents: [],
      recurrenceRule: 'NONE',
    }
    const seed = await caller().expenses.importFile({
      requestId: crypto.randomUUID(),
      groupId,
      rows: [
        {
          rowId: 'dup-seed-ack',
          rowNumber: 121,
          source: {
            baseFingerprint: fp('seed-base'),
            originFingerprint: fp('seed-origin'),
          },
          externalId,
          sourceAccount,
          expense: baseExpense,
        },
      ],
    })
    expect(seed.importedCount).toBe(1)

    const candidate = {
      rowId: 'dup-candidate-ack',
      rowNumber: 122,
      source: {
        baseFingerprint: fp('cand-base'),
        originFingerprint: fp('cand-origin'),
      },
      externalId,
      sourceAccount,
      expense: { ...baseExpense, title: 'Duplicate seed ack re-export' },
    }
    const preview = await caller().expenses.previewImportDuplicates({
      groupId,
      rows: [candidate],
    })
    const matchKeys = (preview.rows[0]?.matches ?? []).map((match) => match.key)
    expect(matchKeys.length).toBeGreaterThan(0)

    const before = await prisma.expense.count({ where: { ledgerId } })
    const imported = await caller().expenses.importFile({
      requestId: crypto.randomUUID(),
      groupId,
      rows: [{ ...candidate, approvedDuplicateKeys: matchKeys }],
    })
    expect(imported.importedCount).toBe(1)
    expect(imported.expenseIds).toHaveLength(1)
    const after = await prisma.expense.count({ where: { ledgerId } })
    expect(after).toBe(before + 1)
  })

  it('stores only the bank identity hash, never raw bank ids', async () => {
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:hashonly:${seed}`).digest('hex')
    const externalId = `hash-only-${runId}`
    const sourceAccount = 'hash-acct'
    const row = {
      rowId: 'hash-only-row',
      rowNumber: 913,
      source: {
        baseFingerprint: fp('base'),
        originFingerprint: fp('origin'),
      },
      externalId,
      sourceAccount,
      expense: {
        expenseDate: new Date('2026-08-20T12:00:00.000Z'),
        expenseTimeZone: 'UTC',
        title: 'Hash-only identity probe',
        category: 'general',
        amount: 3300,
        paidBySplitMode: 'BY_AMOUNT',
        paidByList: [{ participant: participantId, shares: 3300 }],
        isMultiPayer: false,
        splitMode: 'EVENLY',
        paidFor: [{ participant: participantId, shares: 1 }],
        documents: [],
        recurrenceRule: 'NONE',
      },
    }
    const imported = await caller().expenses.importFile({
      requestId: crypto.randomUUID(),
      groupId,
      rows: [row],
    })
    expect(imported.importedCount).toBe(1)
    const stored = await prisma.expenseFileImportSource.findUniqueOrThrow({
      where: { expenseId: imported.expenseIds[0]! },
    })
    expect(stored.externalIdentityHash).toBe(
      externalIdentityHash(externalId, sourceAccount),
    )
    // Raw bank ids exist only on the request payload, never in storage.
    expect('externalTransactionId' in stored).toBe(false)
    expect('sourceAccount' in stored).toBe(false)

    // Normalization runs before hashing: a padded/whitespace variant of the
    // same bank id resolves to the same stored identity.
    const paddedPreview = await caller().expenses.previewImportDuplicates({
      groupId,
      rows: [
        {
          ...row,
          rowId: 'hash-only-padded',
          rowNumber: 914,
          source: {
            baseFingerprint: fp('padded-base'),
            originFingerprint: fp('padded-origin'),
          },
          externalId: `  ${externalId} `,
          sourceAccount,
        },
      ],
    })
    expect(paddedPreview.rows[0]?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'EXACT_IMPORT',
          expenseId: imported.expenseIds[0],
        }),
      ]),
    )
  })

  it('rejects partial approval with conflicts for only the unapproved rows', async () => {
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:partial:${seed}`).digest('hex')
    const externalId = `dup-partial-${runId}`
    const sourceAccount = 'dup-acct-partial'
    const baseExpense = {
      expenseDate: new Date('2026-05-14T12:00:00.000Z'),
      expenseTimeZone: 'UTC',
      title: 'Duplicate seed partial',
      category: 'general',
      amount: 7200,
      paidBySplitMode: 'BY_AMOUNT',
      paidByList: [{ participant: participantId, shares: 7200 }],
      isMultiPayer: false,
      splitMode: 'EVENLY',
      paidFor: [{ participant: participantId, shares: 1 }],
      documents: [],
      recurrenceRule: 'NONE',
    }
    const seed = await caller().expenses.importFile({
      requestId: crypto.randomUUID(),
      groupId,
      rows: [
        {
          rowId: 'dup-seed-partial',
          rowNumber: 151,
          source: {
            baseFingerprint: fp('seed-base'),
            originFingerprint: fp('seed-origin'),
          },
          externalId,
          sourceAccount,
          expense: baseExpense,
        },
      ],
    })
    expect(seed.importedCount).toBe(1)

    // Both candidates re-export the same bank transaction, so both match the
    // seed; only the first row's keys are approved.
    const approvedRow = {
      rowId: 'dup-partial-approved',
      rowNumber: 152,
      source: {
        baseFingerprint: fp('approved-base'),
        originFingerprint: fp('approved-origin'),
      },
      externalId,
      sourceAccount,
      expense: { ...baseExpense, title: 'Duplicate seed partial re-export' },
    }
    const unapprovedRow = {
      rowId: 'dup-partial-unapproved',
      rowNumber: 153,
      source: {
        baseFingerprint: fp('unapproved-base'),
        originFingerprint: fp('unapproved-origin'),
      },
      externalId,
      sourceAccount,
      expense: { ...baseExpense, title: 'Duplicate seed partial re-export' },
    }
    const preview = await caller().expenses.previewImportDuplicates({
      groupId,
      rows: [approvedRow, unapprovedRow],
    })
    const approvedKeys = (preview.rows[0]?.matches ?? []).map(
      (match) => match.key,
    )
    expect(approvedKeys).toEqual(
      expect.arrayContaining([`EXACT_IMPORT:${seed.expenseIds[0]}`]),
    )

    const before = await prisma.expense.count({ where: { ledgerId } })
    const failure = await caller()
      .expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: [
          { ...approvedRow, approvedDuplicateKeys: approvedKeys },
          unapprovedRow,
        ],
      })
      .then(
        () => {
          throw new Error('expected a CONFLICT rejection')
        },
        (cause) => cause as { code?: unknown },
      )
    expect(failure).toMatchObject({ code: 'CONFLICT' })
    const conflicts = (
      failure as {
        cause?: { conflicts?: Array<{ rowId: string; rowNumber: number }> }
      }
    ).cause?.conflicts
    expect(conflicts).toHaveLength(1)
    expect(conflicts?.[0]).toMatchObject({
      rowId: 'dup-partial-unapproved',
      rowNumber: 153,
    })
    const after = await prisma.expense.count({ where: { ledgerId } })
    expect(after).toBe(before)
  })

  it('maps import validation failures to BAD_REQUEST or NOT_FOUND', async () => {
    const row = {
      rowId: 'code-row',
      rowNumber: 161,
      source: {
        baseFingerprint: '3'.repeat(64),
        originFingerprint: '4'.repeat(64),
      },
      expense: {
        expenseDate: new Date('2026-05-15T12:00:00.000Z'),
        expenseTimeZone: 'UTC',
        title: 'Code mapping probe',
        category: 'general',
        amount: 1800,
        paidBySplitMode: 'BY_AMOUNT',
        paidByList: [{ participant: participantId, shares: 1800 }],
        isMultiPayer: false,
        splitMode: 'EVENLY',
        paidFor: [{ participant: participantId, shares: 1 }],
        documents: [],
        recurrenceRule: 'NONE',
      },
    } as unknown as ExpenseFileImportRow

    // Missing group surfaces as NOT_FOUND through the shared loader path.
    await expect(
      prepareExpenseFileImport('group-does-not-exist', accountId, [row]),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    // Empty row selection is a client error, reachable here past the
    // procedure-level zod `.min(1)` guard.
    await expect(
      prepareExpenseFileImport(groupId, accountId, []),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Select at least one expense row',
    })

    // Archived groups reject before any rates, documents, or writes happen —
    // FORBIDDEN, matching the in-transaction check and the procedure guard.
    await prisma.group.update({
      where: { id: groupId },
      data: { archived: true },
    })
    try {
      await expect(
        prepareExpenseFileImport(groupId, accountId, [row]),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'This group is archived',
      })
    } finally {
      await prisma.group.update({
        where: { id: groupId },
        data: { archived: false },
      })
    }
  })

  it('rejects unknown participant ids as BAD_REQUEST', async () => {
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:participant:${seed}`).digest('hex')
    await expect(
      caller().expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: [
          {
            rowId: 'bad-participant-row',
            rowNumber: 171,
            source: {
              baseFingerprint: fp('base'),
              originFingerprint: fp('origin'),
            },
            expense: {
              expenseDate: new Date('2026-05-16T12:00:00.000Z'),
              expenseTimeZone: 'UTC',
              title: 'Bad participant probe',
              category: 'general',
              amount: 1900,
              paidBySplitMode: 'BY_AMOUNT',
              paidByList: [{ participant: 'lp-does-not-exist', shares: 1900 }],
              isMultiPayer: false,
              splitMode: 'EVENLY',
              paidFor: [{ participant: participantId, shares: 1 }],
              documents: [],
              recurrenceRule: 'NONE',
            },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('Invalid participant ID'),
    })
  })

  it('rejects over-cap and duplicate-identity payloads', async () => {
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:caps:${seed}`).digest('hex')
    const validExpense = {
      expenseDate: new Date('2026-05-17T12:00:00.000Z'),
      expenseTimeZone: 'UTC',
      title: 'Cap probe row',
      category: 'general',
      amount: 2100,
      paidBySplitMode: 'BY_AMOUNT',
      paidByList: [{ participant: participantId, shares: 2100 }],
      isMultiPayer: false,
      splitMode: 'EVENLY',
      paidFor: [{ participant: participantId, shares: 1 }],
      documents: [],
      recurrenceRule: 'NONE',
    }

    // Duplicate origin fingerprint within one payload.
    await expect(
      caller().expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: [181, 182].map((rowNumber, index) => ({
          rowId: `dup-origin-${index}`,
          rowNumber,
          source: {
            baseFingerprint: fp(`dup-origin-base-${index}`),
            originFingerprint: fp('shared-origin'),
          },
          expense: validExpense,
        })),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    // More rows than the 10_000 cap (shares one expense object; every row
    // identity stays unique so the row-count cap is what trips).
    const sharedExpense = { ...validExpense }
    const overRows = Array.from({ length: 10_001 }, (_, index) => {
      const fingerprint = index.toString(16).padStart(64, '0')
      return {
        rowId: `cap-row-${index}`,
        rowNumber: index + 2,
        source: {
          baseFingerprint: fingerprint,
          originFingerprint: fingerprint,
        },
        expense: sharedExpense,
      }
    })
    await expect(
      caller().expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: overRows,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    // Total nested items above the 20_000 budget (201 rows × 100 items).
    const sharedItems = Array.from({ length: 100 }, (_, index) => ({
      title: `Cap item ${index}`,
      unitPrice: 100,
      quantity: 1,
      amount: 100,
      splitMode: 'EVENLY' as const,
      paidFor: [{ participant: participantId, shares: 1 }],
    }))
    const itemHeavyRows = Array.from({ length: 201 }, (_, index) => ({
      rowId: `cap-items-${index}`,
      rowNumber: index + 2,
      source: {
        baseFingerprint: fp(`items-base-${index}`),
        originFingerprint: fp(`items-origin-${index}`),
      },
      expense: {
        ...validExpense,
        title: `Cap items row ${index}`,
        amount: 10000,
        paidByList: [{ participant: participantId, shares: 10000 }],
        items: sharedItems,
      },
    }))
    await expect(
      caller().expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: itemHeavyRows,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('routes recurring rows through the single-create fallback', async () => {
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:recurring:${seed}`).digest('hex')
    const plainExpense = {
      expenseDate: new Date('2026-05-18T12:00:00.000Z'),
      expenseTimeZone: 'UTC',
      title: 'Bulk-path probe',
      category: 'general',
      amount: 2400,
      paidBySplitMode: 'BY_AMOUNT',
      paidByList: [{ participant: participantId, shares: 2400 }],
      isMultiPayer: false,
      splitMode: 'EVENLY',
      paidFor: [{ participant: participantId, shares: 1 }],
      documents: [],
      recurrenceRule: 'NONE',
    }
    const imported = await caller().expenses.importFile({
      requestId: crypto.randomUUID(),
      groupId,
      rows: [
        {
          rowId: 'recurring-plain',
          rowNumber: 191,
          source: {
            baseFingerprint: fp('plain-base'),
            originFingerprint: fp('plain-origin'),
          },
          expense: plainExpense,
        },
        {
          rowId: 'recurring-weekly',
          rowNumber: 192,
          source: {
            baseFingerprint: fp('weekly-base'),
            originFingerprint: fp('weekly-origin'),
          },
          expense: {
            ...plainExpense,
            title: 'Single-path weekly probe',
            recurrenceRule: 'WEEKLY',
          },
        },
      ],
    })
    expect(imported.importedCount).toBe(2)
    expect(imported.expenseIds).toHaveLength(2)

    const [plain, weekly] = await Promise.all(
      imported.expenseIds.map((id) =>
        prisma.expense.findUniqueOrThrow({
          where: { id },
          select: { id: true, recurringSeriesId: true, fileImportSource: true },
        }),
      ),
    )
    // Bulk-eligible rows skip series creation; the recurring row goes
    // through the canonical single-create fallback instead.
    expect(plain?.recurringSeriesId).toBeNull()
    expect(weekly?.recurringSeriesId).not.toBeNull()
    expect(plain?.fileImportSource?.provider).toBe('GENERIC_CSV')
    expect(weekly?.fileImportSource?.provider).toBe('GENERIC_CSV')
  })

  it('still imports against a ledger crowded with same-amount expenses', async () => {
    // Seed a crowded same-amount, same-window ledger carrying different
    // titles so no row matches, then assert the import itself stays correct
    // (candidate paging scans the window exhaustively instead of truncating).
    const seedDate = new Date('2026-06-15T12:00:00.000Z')
    const seedIds = Array.from(
      { length: 600 },
      (_, index) => `cap-seed-${runId}-${index}`,
    )
    await prisma.$transaction([
      prisma.expense.createMany({
        data: seedIds.map((id, index) => ({
          id,
          ledgerId,
          createdByAccountId: accountId,
          expenseDate: seedDate,
          expenseTimeZone: 'UTC',
          title: `Cap crowd seed ${index}`,
          amount: 7777,
        })),
      }),
      prisma.expensePaidBy.createMany({
        data: seedIds.map((id) => ({
          expenseId: id,
          ledgerParticipantId: participantId,
          shares: 7777,
        })),
      }),
      prisma.expensePaidFor.createMany({
        data: seedIds.map((id) => ({
          expenseId: id,
          ledgerParticipantId: participantId,
          shares: 1,
        })),
      }),
    ])

    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:crowd:${seed}`).digest('hex')
    const imported = await caller().expenses.importFile({
      requestId: crypto.randomUUID(),
      groupId,
      rows: [
        {
          rowId: 'crowd-probe',
          rowNumber: 201,
          source: {
            baseFingerprint: fp('base'),
            originFingerprint: fp('origin'),
          },
          expense: {
            expenseDate: seedDate,
            expenseTimeZone: 'UTC',
            title: 'Cap crowd probe with a unique title',
            category: 'general',
            amount: 7777,
            paidBySplitMode: 'BY_AMOUNT',
            paidByList: [{ participant: participantId, shares: 7777 }],
            isMultiPayer: false,
            splitMode: 'EVENLY',
            paidFor: [{ participant: participantId, shares: 1 }],
            documents: [],
            recurrenceRule: 'NONE',
          },
        },
      ],
    })
    expect(imported.importedCount).toBe(1)
    expect(imported.expenseIds).toHaveLength(1)
  })

  it('rejects malformed import payloads', async () => {
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:invalid:${seed}`).digest('hex')
    const validExpense = {
      expenseDate: new Date('2026-05-12T12:00:00.000Z'),
      expenseTimeZone: 'UTC',
      title: 'Valid payload row',
      category: 'general',
      amount: 2200,
      paidBySplitMode: 'BY_AMOUNT',
      paidByList: [{ participant: participantId, shares: 2200 }],
      isMultiPayer: false,
      splitMode: 'EVENLY',
      paidFor: [{ participant: participantId, shares: 1 }],
      documents: [],
      recurrenceRule: 'NONE',
    }
    const validRow = (suffix: string, rowNumber: number) => ({
      rowId: `valid-${suffix}`,
      rowNumber,
      source: {
        baseFingerprint: fp(`${suffix}-base`),
        originFingerprint: fp(`${suffix}-origin`),
      },
      expense: validExpense,
    })

    // Duplicate rowId within one payload.
    await expect(
      caller().expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: [
          validRow('dup-id', 131),
          { ...validRow('dup-id-2', 132), rowId: 'valid-dup-id' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    // Duplicate rowNumber within one payload.
    await expect(
      caller().expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: [
          validRow('dup-num', 133),
          { ...validRow('dup-num-2', 133), rowId: 'valid-dup-num-2' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    // Malformed origin fingerprint (must be 64 lowercase hex chars).
    await expect(
      caller().expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: [
          {
            ...validRow('bad-hex', 134),
            source: {
              baseFingerprint: fp('bad-hex-base'),
              originFingerprint: 'not-hex',
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    // Empty rows array is covered by the group-guard test above, which
    // asserts the same BAD_REQUEST alongside missing-group/archived cases.

    // Per-expense items array over the cap (100).
    const manyItems = Array.from({ length: 101 }, (_, index) => ({
      title: `Item ${index}`,
      unitPrice: 100,
      quantity: 1,
      amount: 100,
      splitMode: 'EVENLY' as const,
      paidFor: [{ participant: participantId, shares: 1 }],
    }))
    await expect(
      caller().expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: [
          {
            ...validRow('too-many-items', 135),
            expense: {
              ...validExpense,
              title: 'Too many items',
              amount: 10100,
              paidByList: [{ participant: participantId, shares: 10100 }],
              items: manyItems,
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('replays the stored result and still triggers budget evaluation', async () => {
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:replay:${seed}`).digest('hex')
    const requestId = crypto.randomUUID()
    const rows = [
      {
        rowId: 'replay-row',
        rowNumber: 141,
        source: {
          baseFingerprint: fp('base'),
          originFingerprint: fp('origin'),
        },
        expense: {
          expenseDate: new Date('2026-05-13T12:00:00.000Z'),
          expenseTimeZone: 'UTC',
          title: 'Replay budget probe',
          category: 'general',
          amount: 3300,
          paidBySplitMode: 'BY_AMOUNT',
          paidByList: [{ participant: participantId, shares: 3300 }],
          isMultiPayer: false,
          splitMode: 'EVENLY',
          paidFor: [{ participant: participantId, shares: 1 }],
          documents: [],
          recurrenceRule: 'NONE',
        },
      },
    ]

    vi.mocked(enqueueBudgetEvaluation).mockClear()
    const imported = await caller().expenses.importFile({
      requestId,
      groupId,
      rows,
    })
    expect(imported.importedCount).toBe(1)
    expect(vi.mocked(enqueueBudgetEvaluation)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(enqueueBudgetEvaluation)).toHaveBeenCalledWith(groupId)

    const before = await prisma.expense.count({ where: { ledgerId } })
    const replayed = await caller().expenses.importFile({
      requestId,
      groupId,
      rows,
    })
    expect(replayed).toEqual(imported)
    expect(vi.mocked(enqueueBudgetEvaluation)).toHaveBeenCalledTimes(2)
    const after = await prisma.expense.count({ where: { ledgerId } })
    expect(after).toBe(before)
  })

  it('still reports an exact-title duplicate crowded out of the fuzzy cap', async () => {
    // The fuzzy-candidate query is capped, but the exact-title prefilter is
    // not: seed past the cap with same-amount, same-window expenses, then
    // import a row whose title exactly (case-insensitively) matches one
    // seed. Detection must be deterministic, not subject to which 500 rows
    // the capped query happens to return.
    const seedDate = new Date('2026-07-15T12:00:00.000Z')
    const seedIds = Array.from(
      { length: 600 },
      (_, index) => `exact-seed-${runId}-${index}`,
    )
    await prisma.$transaction([
      prisma.expense.createMany({
        data: seedIds.map((id, index) => ({
          id,
          ledgerId,
          createdByAccountId: accountId,
          expenseDate: seedDate,
          expenseTimeZone: 'UTC',
          title: `Exact crowd seed ${index}`,
          amount: 8888,
        })),
      }),
      prisma.expensePaidBy.createMany({
        data: seedIds.map((id) => ({
          expenseId: id,
          ledgerParticipantId: participantId,
          shares: 8888,
        })),
      }),
      prisma.expensePaidFor.createMany({
        data: seedIds.map((id) => ({
          expenseId: id,
          ledgerParticipantId: participantId,
          shares: 1,
        })),
      }),
    ])

    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:exact:${seed}`).digest('hex')
    const row = {
      rowId: 'exact-probe',
      rowNumber: 211,
      source: {
        baseFingerprint: fp('base'),
        originFingerprint: fp('origin'),
      },
      expense: {
        expenseDate: seedDate,
        expenseTimeZone: 'UTC',
        // Case-differing but normalized-equal to seed #42.
        title: 'exact crowd seed 42',
        category: 'general',
        amount: 8888,
        paidBySplitMode: 'BY_AMOUNT',
        paidByList: [{ participant: participantId, shares: 8888 }],
        isMultiPayer: false,
        splitMode: 'EVENLY',
        paidFor: [{ participant: participantId, shares: 1 }],
        documents: [],
        recurrenceRule: 'NONE',
      },
    }
    const preview = await caller().expenses.previewImportDuplicates({
      groupId,
      rows: [row],
    })
    expect(preview.rows[0]?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'EXISTING_EXPENSE',
          expenseId: seedIds[42],
        }),
      ]),
    )

    const failure = await caller()
      .expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: [row],
      })
      .then(
        () => {
          throw new Error('expected a CONFLICT rejection')
        },
        (cause) => cause as { code?: unknown },
      )
    expect(failure).toMatchObject({ code: 'CONFLICT' })
  })

  it('maps an FX provider outage to BAD_GATEWAY instead of INTERNAL', async () => {
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:fx:${seed}`).digest('hex')
    const failure = await caller()
      .expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: [
          {
            rowId: 'fx-probe',
            rowNumber: 221,
            source: {
              baseFingerprint: fp('base'),
              originFingerprint: fp('origin'),
            },
            expense: {
              expenseDate: new Date('2026-07-20T12:00:00.000Z'),
              expenseTimeZone: 'UTC',
              title: 'FX outage probe',
              category: 'general',
              amount: 1000,
              conversion: { type: 'exchange', currency: 'EUR' },
              paidBySplitMode: 'BY_AMOUNT',
              paidByList: [{ participant: participantId, shares: 1000 }],
              isMultiPayer: false,
              splitMode: 'EVENLY',
              paidFor: [{ participant: participantId, shares: 1 }],
              documents: [],
              recurrenceRule: 'NONE',
            },
          },
        ],
      })
      .then(
        () => {
          throw new Error('expected a BAD_GATEWAY rejection')
        },
        (cause) => cause as { code?: unknown; message?: unknown },
      )
    expect(failure).toMatchObject({ code: 'BAD_GATEWAY' })
    expect(String(failure.message)).toContain('provider down')
    expect(String(failure.message)).toContain('EUR→USD')
    expect(String(failure.message)).toContain('2026-07-20')
    expect(String(failure.message)).toContain('Nothing was imported')
    expect(String(failure.message)).toContain('retry')
  })

  it('keys FX batch requests by UTC date so near-midnight non-UTC rows resolve', async () => {
    // 2026-07-20T00:30Z is still 2026-07-19 on the wall in New York, but
    // resolveConversion looks rates up by UTC date — the batch builder must
    // use the same convention or the cached lookup misses and the import
    // fails with a bogus gateway/invariant error.
    const { getCurrencyRates } = await import('../lib/currency-rates')
    const mock = vi.mocked(getCurrencyRates)
    mock.mockClear()
    mock.mockResolvedValueOnce([
      {
        ok: true as const,
        rate: {
          rate: 1.2,
          requestedDate: '2026-07-20',
          asOfDate: '2026-07-20',
          base: 'EUR',
          target: 'USD',
          sources: [],
        },
      },
    ])
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:fxdate:${seed}`).digest('hex')
    const prepared = await prepareExpenseFileImport(groupId, accountId, [
      {
        rowId: 'fx-date-probe',
        rowNumber: 226,
        source: {
          baseFingerprint: fp('base'),
          originFingerprint: fp('origin'),
        },
        expense: {
          expenseDate: new Date('2026-07-20T00:30:00.000Z'),
          expenseTimeZone: 'America/New_York',
          title: 'FX wall-date probe',
          category: 'general',
          amount: 1000,
          conversion: { type: 'exchange', currency: 'EUR' },
          paidBySplitMode: 'BY_AMOUNT',
          paidByList: [{ participant: participantId, shares: 1000 }],
          isMultiPayer: false,
          splitMode: 'EVENLY',
          paidFor: [{ participant: participantId, shares: 1 }],
          documents: [],
          recurrenceRule: 'NONE',
        },
      },
    ])
    expect(mock).toHaveBeenCalledWith([
      { date: '2026-07-20', base: 'EUR', target: 'USD' },
    ])
    expect(prepared.rows[0]?.conversion.ledgerAmountMinor).toBe(1200)
  })

  it('promotes documents during preparation and compensates on validation failure', async () => {
    // Promotion runs before the transaction (never under the group lock), so
    // a row failing participant validation still promotes first — and the
    // transaction owner's compensation then removes the created copies. The
    // promote spy (call-through module mock above) observes the ordering
    // directly. (In-test uploads are unconfigured, so promotion is a
    // passthrough here; the ownership suite below asserts real copies with
    // a fake object store.)
    const { promoteExpenseDocumentsDetailed } =
      await import('../lib/api/expenses/helpers')
    vi.mocked(promoteExpenseDocumentsDetailed).mockClear()
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:promote:${seed}`).digest('hex')
    const failure = await caller()
      .expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: [
          {
            rowId: 'promote-probe',
            rowNumber: 228,
            source: {
              baseFingerprint: fp('base'),
              originFingerprint: fp('origin'),
            },
            expense: {
              expenseDate: new Date('2026-07-23T12:00:00.000Z'),
              expenseTimeZone: 'UTC',
              title: 'Promotion order probe',
              category: 'general',
              amount: 1000,
              paidBySplitMode: 'BY_AMOUNT',
              paidByList: [{ participant: participantId, shares: 1000 }],
              isMultiPayer: false,
              splitMode: 'EVENLY',
              // Unknown participant: fails validation inside the transaction.
              paidFor: [{ participant: 'lp-does-not-exist', shares: 1 }],
              documents: [
                {
                  id: 'doc-promote-1',
                  url: 'https://example.com/staged/promote-probe.pdf',
                },
              ],
              recurrenceRule: 'NONE',
            },
          },
        ],
      })
      .then(
        () => {
          throw new Error('expected a BAD_REQUEST rejection')
        },
        (cause) => cause as { code?: unknown },
      )
    expect(failure).toMatchObject({ code: 'BAD_REQUEST' })
    // Promotion precedes validation now: preparation promoted the staged
    // document before the transaction rejected the unknown participant, and
    // the owner's compensation cleaned the (here passthrough) copy.
    expect(vi.mocked(promoteExpenseDocumentsDetailed)).toHaveBeenCalledTimes(1)

    // Positive control: a valid import with a document does promote, proving
    // the spy above observes real promotion calls (not a dead mock).
    const ok = await caller().expenses.importFile({
      requestId: crypto.randomUUID(),
      groupId,
      rows: [
        {
          rowId: 'promote-control',
          rowNumber: 229,
          source: {
            baseFingerprint: fp('control-base'),
            originFingerprint: fp('control-origin'),
          },
          expense: {
            expenseDate: new Date('2026-07-23T12:00:00.000Z'),
            expenseTimeZone: 'UTC',
            title: 'Promotion control',
            category: 'general',
            amount: 1000,
            paidBySplitMode: 'BY_AMOUNT',
            paidByList: [{ participant: participantId, shares: 1000 }],
            isMultiPayer: false,
            splitMode: 'EVENLY',
            paidFor: [{ participant: participantId, shares: 1 }],
            documents: [
              {
                id: 'doc-promote-2',
                url: 'https://example.com/staged/promote-control.pdf',
              },
            ],
            recurrenceRule: 'NONE',
          },
        },
      ],
    })
    expect(ok.importedCount).toBe(1)
    expect(vi.mocked(promoteExpenseDocumentsDetailed)).toHaveBeenCalled()
  })

  it('initializes fallible dependencies before copying any document', async () => {
    // A rejected boss acquisition must surface before a single copy exists:
    // preparation runs outside the transaction wrapper, so anything copied
    // first would strand without compensation. (Integration env disables
    // jobs; enable for this test so the boss path executes.)
    const wasJobsEnabled = jobsEnv.JOBS_ENABLED
    jobsEnv.JOBS_ENABLED = true
    storageOverrides.uploadsConfigured = true
    try {
      fakeBucket.set(`tmp/${runId}/early-main.pdf`, true)
      vi.mocked(getApiBossForWrite).mockRejectedValueOnce(
        new Error('queue unavailable'),
      )
      const fp = (seed: string) =>
        createHash('sha256').update(`${runId}:early:${seed}`).digest('hex')
      await expect(
        prepareExpenseFileImport(groupId, accountId, [
          {
            rowId: 'early-dep-row',
            rowNumber: 916,
            source: {
              baseFingerprint: fp('base'),
              originFingerprint: fp('origin'),
            },
            expense: {
              expenseDate: new Date('2026-08-22T12:00:00.000Z'),
              expenseTimeZone: 'UTC',
              title: 'Early dependency probe',
              category: 'general',
              amount: 3500,
              paidBySplitMode: 'BY_AMOUNT',
              paidByList: [{ participant: participantId, shares: 3500 }],
              isMultiPayer: false,
              splitMode: 'EVENLY',
              paidFor: [{ participant: participantId, shares: 1 }],
              documents: [
                {
                  id: 'doc-early-1',
                  url: `https://s3.test/tmp/${runId}/early-main.pdf`,
                },
              ],
              recurrenceRule: 'WEEKLY',
            },
          } as unknown as ExpenseFileImportRow,
        ]),
      ).rejects.toThrow('queue unavailable')
      expect(
        [...fakeBucket.keys()].filter((key) => key.startsWith('documents/')),
      ).toEqual([])
      expect(fakeBucket.has(`tmp/${runId}/early-main.pdf`)).toBe(true)
    } finally {
      jobsEnv.JOBS_ENABLED = wasJobsEnabled
      storageOverrides.uploadsConfigured = false
    }
  })

  it('accepts more approved keys on one row than the old per-row cap', async () => {
    // Detection is exhaustive, and "Import anyway" approves every match a
    // row reports: with 51+ matches the offered action must validate. Only
    // the 50_000 total budget still bounds approvals.
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:manykeys:${seed}`).digest('hex')
    const imported = await caller().expenses.importFile({
      requestId: crypto.randomUUID(),
      groupId,
      rows: [
        {
          rowId: 'many-keys-row',
          rowNumber: 915,
          source: {
            baseFingerprint: fp('base'),
            originFingerprint: fp('origin'),
          },
          approvedDuplicateKeys: Array.from(
            { length: 60 },
            (_, index) => `EXISTING_EXPENSE:fake-expense-${index}`,
          ),
          expense: {
            expenseDate: new Date('2026-08-21T12:00:00.000Z'),
            expenseTimeZone: 'UTC',
            title: 'Many approval keys probe',
            category: 'general',
            amount: 3400,
            paidBySplitMode: 'BY_AMOUNT',
            paidByList: [{ participant: participantId, shares: 3400 }],
            isMultiPayer: false,
            splitMode: 'EVENLY',
            paidFor: [{ participant: participantId, shares: 1 }],
            documents: [],
            recurrenceRule: 'NONE',
          },
        },
      ],
    })
    expect(imported.importedCount).toBe(1)
  })

  it('finds normalized duplicates beyond the first candidate page', async () => {
    // Exhaustive candidate paging (no silent take:500 truncation): 1,100
    // same-window decoys sort ahead of the target in scan order while 600
    // newer decoys push it out of any capped recent-first window, and the
    // stored title is a fullwidth/punctuation/case variant that only matches
    // after NFKC folding. Preview must match, commit must reject without
    // approval, and commit must succeed with approval.
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:paging:${seed}`).digest('hex')
    const targetDate = new Date('2026-06-16T12:00:00.000Z')
    const targetId = `paging-target-${runId}`
    const decoys: Array<{
      id: string
      ledgerId: string
      expenseDate: Date
      expenseTimeZone: string
      title: string
      amount: number
    }> = []
    for (let index = 0; index < 1100; index++) {
      decoys.push({
        id: `paging-decoy-old-${runId}-${index}`,
        ledgerId,
        expenseDate: new Date(
          new Date('2026-06-15T00:01:00.000Z').getTime() + index * 60_000,
        ),
        expenseTimeZone: 'UTC',
        title: `Paging bulk old ${index}`,
        amount: 500,
      })
    }
    decoys.push({
      id: targetId,
      ledgerId,
      expenseDate: targetDate,
      expenseTimeZone: 'UTC',
      // Fullwidth + punctuation + case variant of the import title below.
      title: 'ＳＥＥＤ-４２　ＴＯＫＹＯ　ＤＩＮＥＲ',
      amount: 500,
    })
    for (let index = 0; index < 600; index++) {
      decoys.push({
        id: `paging-decoy-new-${runId}-${index}`,
        ledgerId,
        expenseDate: new Date(targetDate.getTime() + (index + 1) * 60_000),
        expenseTimeZone: 'UTC',
        title: `Paging bulk new ${index}`,
        amount: 500,
      })
    }
    for (let offset = 0; offset < decoys.length; offset += 500) {
      await prisma.expense.createMany({
        data: decoys.slice(offset, offset + 500),
      })
    }

    const candidate = {
      rowId: 'paging-candidate',
      rowNumber: 900,
      source: {
        baseFingerprint: fp('base'),
        originFingerprint: fp('origin'),
      },
      expense: {
        expenseDate: targetDate,
        expenseTimeZone: 'UTC',
        title: 'seed 42, tokyo diner',
        category: 'general',
        amount: 500,
        paidBySplitMode: 'BY_AMOUNT',
        paidByList: [{ participant: participantId, shares: 500 }],
        isMultiPayer: false,
        splitMode: 'EVENLY',
        paidFor: [{ participant: participantId, shares: 1 }],
        documents: [],
        recurrenceRule: 'NONE',
      },
    }
    const preview = await caller().expenses.previewImportDuplicates({
      groupId,
      rows: [candidate],
    })
    expect(preview.rows[0]?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'EXISTING_EXPENSE',
          expenseId: targetId,
        }),
      ]),
    )

    const conflict = await caller()
      .expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: [candidate],
      })
      .then(
        () => {
          throw new Error('expected a CONFLICT rejection')
        },
        (cause) => cause as { code?: unknown; cause?: unknown },
      )
    expect(conflict).toMatchObject({ code: 'CONFLICT' })
    const conflicts = (
      conflict as {
        cause?: { conflicts?: Array<{ rowId: string; matchKeys: string[] }> }
      }
    ).cause?.conflicts
    expect(conflicts?.[0]?.matchKeys).toEqual(
      expect.arrayContaining([`EXISTING_EXPENSE:${targetId}`]),
    )

    const approved = await caller().expenses.importFile({
      requestId: crypto.randomUUID(),
      groupId,
      rows: [
        {
          ...candidate,
          approvedDuplicateKeys: [`EXISTING_EXPENSE:${targetId}`],
        },
      ],
    })
    expect(approved.importedCount).toBe(1)
  })

  it('matches duplicates across a multi-year batch', async () => {
    // One candidate scan covers the whole import date range: rows years
    // apart must each match their seed, proving the bounds wrap every row
    // instead of scoping pages per row.
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:multiyear:${seed}`).digest('hex')
    const oldSeedId = `multiyear-old-${runId}`
    const newSeedId = `multiyear-new-${runId}`
    await prisma.expense.createMany({
      data: [
        {
          id: oldSeedId,
          ledgerId,
          expenseDate: new Date('2023-03-10T12:00:00.000Z'),
          expenseTimeZone: 'UTC',
          title: 'Old annual fee',
          amount: 9900,
        },
        {
          id: newSeedId,
          ledgerId,
          expenseDate: new Date('2026-08-10T12:00:00.000Z'),
          expenseTimeZone: 'UTC',
          title: 'New annual fee',
          amount: 9900,
        },
      ],
    })
    const buildRow = (
      name: string,
      rowNumber: number,
      title: string,
      date: Date,
    ) => ({
      rowId: `multiyear-${name}`,
      rowNumber,
      source: {
        baseFingerprint: fp(`${name}-base`),
        originFingerprint: fp(`${name}-origin`),
      },
      expense: {
        expenseDate: date,
        expenseTimeZone: 'UTC',
        title,
        category: 'general',
        amount: 9900,
        paidBySplitMode: 'BY_AMOUNT',
        paidByList: [{ participant: participantId, shares: 9900 }],
        isMultiPayer: false,
        splitMode: 'EVENLY',
        paidFor: [{ participant: participantId, shares: 1 }],
        documents: [],
        recurrenceRule: 'NONE',
      },
    })
    const preview = await caller().expenses.previewImportDuplicates({
      groupId,
      rows: [
        buildRow(
          'old',
          910,
          'old annual fee',
          new Date('2023-03-10T12:00:00.000Z'),
        ),
        buildRow(
          'new',
          911,
          'NEW annual fee',
          new Date('2026-08-10T12:00:00.000Z'),
        ),
      ],
    })
    expect(preview.rows[0]?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'EXISTING_EXPENSE',
          expenseId: oldSeedId,
        }),
      ]),
    )
    expect(preview.rows[1]?.matches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'EXISTING_EXPENSE',
          expenseId: newSeedId,
        }),
      ]),
    )
  })

  it('rejects payloads whose split entries exceed the total budget', async () => {
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:budget:${seed}`).digest('hex')
    const paidFor = Array.from({ length: 500 }, () => ({
      participant: participantId,
      shares: 1,
    }))
    const failure = await caller()
      .expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: Array.from({ length: 500 }, (_, index) => ({
          rowId: `budget-probe-${index}`,
          rowNumber: 1000 + index,
          source: {
            baseFingerprint: fp(`base-${index}`),
            originFingerprint: fp(`origin-${index}`),
          },
          expense: {
            expenseDate: new Date('2026-07-24T12:00:00.000Z'),
            expenseTimeZone: 'UTC',
            title: `Budget probe ${index}`,
            category: 'general',
            amount: 1000,
            paidBySplitMode: 'BY_AMOUNT',
            paidByList: [{ participant: participantId, shares: 1000 }],
            isMultiPayer: false,
            splitMode: 'EVENLY',
            paidFor,
            documents: [],
            recurrenceRule: 'NONE',
          },
        })),
      })
      .then(
        () => {
          throw new Error('expected a BAD_REQUEST rejection')
        },
        (cause) => cause as { code?: unknown; message?: unknown },
      )
    expect(failure).toMatchObject({ code: 'BAD_REQUEST' })
    expect(String(failure.message)).toContain('split entries')
  })

  it('rejects itemized rows whose items exceed the total as BAD_REQUEST', async () => {
    // The router input schema already rejects this with its own amountSum
    // issue; this exercises the in-transaction translation for direct lib
    // callers (prepare/importExpenseFile bypass the router schema), where a
    // raw ITEMS_EXCEED_AMOUNT Error would otherwise surface as INTERNAL.
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:items:${seed}`).digest('hex')
    const row = {
      rowId: 'items-probe',
      rowNumber: 227,
      source: {
        baseFingerprint: fp('base'),
        originFingerprint: fp('origin'),
      },
      expense: {
        expenseDate: new Date('2026-07-22T12:00:00.000Z'),
        expenseTimeZone: 'UTC',
        title: 'Items exceed probe',
        category: 'general',
        amount: 1000,
        paidBySplitMode: 'BY_AMOUNT',
        paidByList: [{ participant: participantId, shares: 1000 }],
        isMultiPayer: false,
        splitMode: 'ITEMIZED',
        paidFor: [{ participant: participantId, shares: 1 }],
        items: [
          {
            title: 'Over budget item',
            unitPrice: 9999,
            quantity: 1,
            amount: 9999,
            splitMode: 'EVENLY' as const,
            paidFor: [{ participant: participantId, shares: 1 }],
          },
        ],
        documents: [],
        recurrenceRule: 'NONE',
      },
    } as unknown as ExpenseFileImportRow
    const failure = await importExpenseFile(
      { groupId, accountId, rows: [row] },
      {},
    ).then(
      () => {
        throw new Error('expected a BAD_REQUEST rejection')
      },
      (cause) => cause as { code?: unknown; message?: unknown },
    )
    expect(failure).toMatchObject({ code: 'BAD_REQUEST' })
    expect(String(failure.message)).toContain('exceed the expense total')
  })

  it('rejects a stale prepared import when the group currency changed', async () => {
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:stale:${seed}`).digest('hex')
    const rows = [
      {
        rowId: 'stale-probe',
        rowNumber: 231,
        source: {
          baseFingerprint: fp('base'),
          originFingerprint: fp('origin'),
        },
        expense: {
          expenseDate: new Date('2026-07-21T12:00:00.000Z'),
          expenseTimeZone: 'UTC',
          title: 'Stale prepared probe',
          category: 'general',
          amount: 1100,
          paidBySplitMode: 'BY_AMOUNT',
          paidByList: [{ participant: participantId, shares: 1100 }],
          isMultiPayer: false,
          splitMode: 'EVENLY',
          paidFor: [{ participant: participantId, shares: 1 }],
          documents: [],
          recurrenceRule: 'NONE',
        },
      },
    ] satisfies ExpenseFileImportRow[]
    const prepared = await prepareExpenseFileImport(groupId, accountId, rows)
    const failure = await importExpenseFile(
      { groupId, accountId, rows },
      { prepared: { ...prepared, ledgerCurrencyCode: 'EUR' } },
    ).then(
      () => {
        throw new Error('expected a BAD_REQUEST rejection')
      },
      (cause) => cause as { code?: unknown; message?: unknown },
    )
    expect(failure).toMatchObject({ code: 'BAD_REQUEST' })
    expect(String(failure.message)).toMatch(/currency changed/i)
  })

  it('rejects rows with more than 10 documents per row', async () => {
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:docs:${seed}`).digest('hex')
    const failure = await caller()
      .expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: [
          {
            rowId: 'docs-probe',
            rowNumber: 240,
            source: {
              baseFingerprint: fp('base'),
              originFingerprint: fp('origin'),
            },
            expense: {
              expenseDate: new Date('2026-07-25T12:00:00.000Z'),
              expenseTimeZone: 'UTC',
              title: 'Documents cap probe',
              category: 'general',
              amount: 1000,
              paidBySplitMode: 'BY_AMOUNT',
              paidByList: [{ participant: participantId, shares: 1000 }],
              isMultiPayer: false,
              splitMode: 'EVENLY',
              paidFor: [{ participant: participantId, shares: 1 }],
              documents: Array.from({ length: 11 }, (_, index) => ({
                id: `doc-cap-${index}`,
                url: `https://example.com/staged/docs-cap-${index}.pdf`,
              })),
              recurrenceRule: 'NONE',
            },
          },
        ],
      })
      .then(
        () => {
          throw new Error('expected a BAD_REQUEST rejection')
        },
        (cause) => cause as { code?: unknown; message?: unknown },
      )
    expect(failure).toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('rejects ITEMIZED imports whose resolved splits exceed the budget', async () => {
    // Filler (`computePaidForFromItems`) expands ITEMIZED paidFor to every
    // active participant AFTER the procedure-level raw budget check, so the
    // pre-write resolved check must catch the breach before any write
    // (copies made during preparation are removed by compensation).
    const extraCount = 150
    const extraIds = Array.from({ length: extraCount }, () =>
      crypto.randomUUID(),
    )
    await prisma.ledgerParticipant.createMany({
      data: extraIds.map((id, index) => ({
        id,
        ledgerId,
        kind: 'UNLINKED_PARTICIPANT',
        displayName: `Filler ${runId}-${index}`,
      })),
    })
    try {
      const fp = (seed: string) =>
        createHash('sha256').update(`${runId}:filler:${seed}`).digest('hex')
      const rowCount = 2000
      const failure = await caller()
        .expenses.importFile({
          requestId: crypto.randomUUID(),
          groupId,
          rows: Array.from({ length: rowCount }, (_, index) => ({
            rowId: `filler-probe-${index}`,
            rowNumber: 5000 + index,
            source: {
              baseFingerprint: fp(`base-${index}`),
              originFingerprint: fp(`origin-${index}`),
            },
            expense: {
              expenseDate: new Date('2026-07-26T12:00:00.000Z'),
              expenseTimeZone: 'UTC',
              title: `Filler probe ${index}`,
              category: 'general',
              amount: 1000,
              paidBySplitMode: 'BY_AMOUNT',
              paidByList: [{ participant: participantId, shares: 1000 }],
              isMultiPayer: false,
              splitMode: 'ITEMIZED',
              paidFor: [{ participant: participantId, shares: 1 }],
              // Items cover only 600 of 1000: the 400 filler expands to every
              // active participant (151 here), bypassing the raw budget check.
              items: [
                {
                  title: 'Filler item',
                  unitPrice: 600,
                  quantity: 1,
                  amount: 600,
                  splitMode: 'EVENLY' as const,
                  paidFor: [{ participant: participantId, shares: 1 }],
                },
              ],
              documents: [],
              recurrenceRule: 'NONE',
            },
          })),
        })
        .then(
          () => {
            throw new Error('expected a BAD_REQUEST rejection')
          },
          (cause) => cause as { code?: unknown; message?: unknown },
        )
      expect(failure).toMatchObject({ code: 'BAD_REQUEST' })
      expect(String(failure.message)).toContain('split entries')
    } finally {
      await prisma.ledgerParticipant
        .deleteMany({ where: { id: { in: extraIds } } })
        .catch(() => {})
    }
  }, 30_000)

  it('allows same-currency imports into custom-currency ledgers', async () => {
    const custom = await caller().create({
      requestId: crypto.randomUUID(),
      groupFormValues: {
        name: `CSV Custom ${runId}`,
        currency: '$',
        currencyCode: '',
        participants: [{ name: 'CSV Importer' }],
      },
    })
    const customGroup = await prisma.group.findUniqueOrThrow({
      where: { id: custom.groupId },
      include: {
        ledger: true,
        members: { include: { ledgerParticipant: true } },
      },
    })
    ledgerIds.push(customGroup.ledger.id)
    const customParticipantId = customGroup.members[0]!.ledgerParticipant!.id
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:custom:${seed}`).digest('hex')
    const imported = await caller().expenses.importFile({
      requestId: crypto.randomUUID(),
      groupId: custom.groupId,
      rows: [
        {
          rowId: 'custom-probe',
          rowNumber: 241,
          source: {
            baseFingerprint: fp('base'),
            originFingerprint: fp('origin'),
          },
          expense: {
            expenseDate: new Date('2026-07-27T12:00:00.000Z'),
            expenseTimeZone: 'UTC',
            title: 'Custom ledger probe',
            category: 'general',
            amount: 1000,
            paidBySplitMode: 'BY_AMOUNT',
            paidByList: [{ participant: customParticipantId, shares: 1000 }],
            isMultiPayer: false,
            splitMode: 'EVENLY',
            paidFor: [{ participant: customParticipantId, shares: 1 }],
            documents: [],
            recurrenceRule: 'NONE',
          },
        },
      ],
    })
    expect(imported.importedCount).toBe(1)
  })
})

describe('expense file import document ownership', () => {
  const runId = testRunId()
  const accountId = `csv-own-${runId}`
  const email = `${accountId}@test.example`
  const ledgerIds: string[] = []

  let groupId: string
  let ledgerId: string
  let participantId: string
  let rowCounter = 400

  function caller() {
    return groupsRouter.createCaller({
      auth: {
        session: { id: `session-${runId}` },
        user: {
          id: accountId,
          email,
          emailVerified: true,
          name: 'CSV Ownership',
        },
      },
    } as never)
  }

  const tmpUrl = (name: string) => `https://s3.test/tmp/${runId}/${name}`
  const permanentKey = (name: string) => `documents/${runId}/${name}`

  function ownershipRow(
    name: string,
    documents: Array<{ id: string; url: string }>,
    expenseOverrides: Record<string, unknown> = {},
  ) {
    rowCounter += 1
    const fp = (seed: string) =>
      createHash('sha256').update(`${runId}:own:${name}:${seed}`).digest('hex')
    return {
      rowId: `own-${name}`,
      rowNumber: rowCounter,
      source: {
        baseFingerprint: fp('base'),
        originFingerprint: fp('origin'),
      },
      expense: {
        expenseDate: new Date('2026-08-10T12:00:00.000Z'),
        expenseTimeZone: 'UTC',
        title: `Ownership probe ${name}`,
        category: 'general',
        amount: 1000,
        paidBySplitMode: 'BY_AMOUNT',
        paidByList: [{ participant: participantId, shares: 1000 }],
        isMultiPayer: false,
        splitMode: 'EVENLY',
        paidFor: [{ participant: participantId, shares: 1 }],
        documents,
        recurrenceRule: 'NONE',
        ...expenseOverrides,
      },
    }
  }

  beforeAll(async () => {
    storageOverrides.uploadsConfigured = true
    await prisma.account.create({
      data: {
        id: accountId,
        email,
        emailVerified: true,
        name: 'CSV Ownership',
      },
    })
    await initializeTestAccountTimeZone(accountId)
    const created = await caller().create({
      requestId: crypto.randomUUID(),
      groupFormValues: {
        name: `CSV Ownership ${runId}`,
        currency: '$',
        currencyCode: 'USD',
        participants: [{ name: 'CSV Ownership' }],
      },
    })
    groupId = created.groupId
    const group = await prisma.group.findUniqueOrThrow({
      where: { id: groupId },
      include: {
        ledger: true,
        members: { include: { ledgerParticipant: true } },
      },
    })
    ledgerId = group.ledger.id
    ledgerIds.push(ledgerId)
    participantId = group.members[0]!.ledgerParticipant!.id
  })

  beforeEach(() => {
    fakeBucket.clear()
    fakeDeleteCalls.length = 0
    fakeCopyCalls.length = 0
    storageOverrides.failCopyKeys = undefined
    storageOverrides.failDeleteKeys = undefined
  })

  afterAll(async () => {
    storageOverrides.uploadsConfigured = false
    for (const id of ledgerIds) {
      await prisma.ledger.delete({ where: { id } }).catch(() => {})
    }
    await prisma.account.delete({ where: { id: accountId } }).catch(() => {})
  })

  it('promotes staged documents during preparation, before any transaction', async () => {
    fakeBucket.set(`tmp/${runId}/pre.pdf`, true)
    const prepared = await prepareExpenseFileImport(groupId, accountId, [
      ownershipRow('pre', [
        { id: 'doc-pre-1', url: tmpUrl('pre.pdf') },
      ]) as unknown as ExpenseFileImportRow,
    ])
    const promoted = prepared.rows[0]?.documents[0]
    expect(promoted?.url).not.toBe(tmpUrl('pre.pdf'))
    // Attempt-scoped destination: structurally unshared with any concurrent
    // attempt, so no other attempt's cleanup can ever address this object.
    expect(fakeBucketKey(promoted?.url ?? '')).toMatch(
      /^documents\/imports\/[^/]+\/int-.*\/pre\.pdf$/,
    )
    expect(fakeBucket.has(fakeBucketKey(promoted?.url ?? ''))).toBe(true)
    // Staged sources are retained until commit so a failed import (or a
    // duplicate-conflict retry) can promote the same payload again.
    expect(fakeBucket.has(`tmp/${runId}/pre.pdf`)).toBe(true)
  })

  it('cleans a created sibling copy when another document in the row fails', async () => {
    fakeBucket.set(`tmp/${runId}/ok.pdf`, true)
    fakeBucket.set(`tmp/${runId}/boom.pdf`, true)
    storageOverrides.failCopyKeys = new Set(['boom'])
    const failure = await caller()
      .expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: [
          ownershipRow('sibling', [
            { id: 'doc-sib-ok', url: tmpUrl('ok.pdf') },
            { id: 'doc-sib-boom', url: tmpUrl('boom.pdf') },
          ]),
        ],
      })
      .then(
        () => {
          throw new Error('expected a copy rejection')
        },
        (cause) => cause as Error,
      )
    expect(failure.message).toContain('CopyFailed')
    // The successfully copied sibling must not leak even though its own row
    // failed: preparation settles every in-flight promotion first, tracks
    // the created copies, and removes them.
    expect(
      [...fakeBucket.keys()].filter((key) => key.startsWith('documents/')),
    ).toEqual([])
    // Staged sources survive the failure so the corrected payload retries
    // without re-uploading.
    expect(fakeBucket.has(`tmp/${runId}/ok.pdf`)).toBe(true)
    expect(fakeBucket.has(`tmp/${runId}/boom.pdf`)).toBe(true)
    expect(await prisma.expense.count({ where: { ledgerId } })).toBe(0)
  })

  it('surfaces the original copy failure when cleanup itself fails', async () => {
    fakeBucket.set(`tmp/${runId}/ok2.pdf`, true)
    fakeBucket.set(`tmp/${runId}/boom2.pdf`, true)
    storageOverrides.failCopyKeys = new Set(['boom2'])
    storageOverrides.failDeleteKeys = new Set(['ok2'])
    const failure = await caller()
      .expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: [
          ownershipRow('masking', [
            { id: 'doc-mask-ok', url: tmpUrl('ok2.pdf') },
            { id: 'doc-mask-boom', url: tmpUrl('boom2.pdf') },
          ]),
        ],
      })
      .then(
        () => {
          throw new Error('expected a copy rejection')
        },
        (cause) => cause as Error,
      )
    expect(failure.message).toContain('CopyFailed')
    expect(failure.message).not.toContain('DeleteFailed')
  })

  it('cleans created copies when in-transaction validation fails', async () => {
    fakeBucket.set(`tmp/${runId}/late.pdf`, true)
    const failure = await caller()
      .expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: [
          ownershipRow(
            'late-fail',
            [{ id: 'doc-late-1', url: tmpUrl('late.pdf') }],
            { paidFor: [{ participant: 'lp-does-not-exist', shares: 1 }] },
          ),
        ],
      })
      .then(
        () => {
          throw new Error('expected a BAD_REQUEST rejection')
        },
        (cause) => cause as { code?: unknown },
      )
    expect(failure).toMatchObject({ code: 'BAD_REQUEST' })
    expect(
      [...fakeBucket.keys()].filter((key) => key.startsWith('documents/')),
    ).toEqual([])
    expect(fakeBucket.has(`tmp/${runId}/late.pdf`)).toBe(true)
    expect(await prisma.expense.count({ where: { ledgerId } })).toBe(0)
  })

  it('keeps created copies when references cannot be verified', async () => {
    // Fail-closed compensation: if the reference query itself fails
    // (database outage or ambiguous commit), cleanup must delete nothing —
    // substituting "no references" would destroy possibly committed
    // attachments.
    fakeBucket.set(`tmp/${runId}/unverifiable.pdf`, true)
    const findManySpy = vi
      .spyOn(prisma.expenseDocument, 'findMany')
      .mockRejectedValueOnce(new Error('database unavailable'))
    try {
      const failure = await caller()
        .expenses.importFile({
          requestId: crypto.randomUUID(),
          groupId,
          rows: [
            ownershipRow(
              'unverifiable',
              [{ id: 'doc-unver-1', url: tmpUrl('unverifiable.pdf') }],
              { paidFor: [{ participant: 'lp-does-not-exist', shares: 1 }] },
            ),
          ],
        })
        .then(
          () => {
            throw new Error('expected a BAD_REQUEST rejection')
          },
          (cause) => cause as { code?: unknown },
        )
      expect(failure).toMatchObject({ code: 'BAD_REQUEST' })
    } finally {
      findManySpy.mockRestore()
    }
    expect(
      [...fakeBucket.keys()].filter((key) => key.startsWith('documents/')),
    ).toHaveLength(1)
    expect(fakeBucket.has(`tmp/${runId}/unverifiable.pdf`)).toBe(true)
  })
  it('copies a shared staged URL once per attempt', async () => {
    // Within-attempt deduplication shares the in-flight promotion promise:
    // two documents referencing one staged URL must trigger exactly one
    // storage copy (a populate-after-await cache misses under concurrency
    // and copies twice, failing the batch when a redundant copy fails).
    fakeBucket.set(`tmp/${runId}/shared-doc.pdf`, true)
    const prepared = await prepareExpenseFileImport(groupId, accountId, [
      ownershipRow('dedupe', [
        {
          id: 'doc-dedupe-1',
          url: tmpUrl('shared-doc.pdf'),
          fileName: 'first.pdf',
        },
        {
          id: 'doc-dedupe-2',
          url: tmpUrl('shared-doc.pdf'),
          fileName: 'second.pdf',
        },
      ]) as unknown as ExpenseFileImportRow,
    ])
    const [first, second] = prepared.rows[0]?.documents ?? []
    expect(
      fakeCopyCalls.filter((key) => key.includes('shared-doc.pdf')),
    ).toHaveLength(1)
    // One shared permanent URL, with each document's identity preserved.
    expect(second?.url).toBe(first?.url)
    expect(first?.created).toBe(true)
    expect(second?.created).toBe(true)
    expect(first?.id).toBe('doc-dedupe-1')
    expect(second?.id).toBe('doc-dedupe-2')
    expect(first?.fileName).toBe('first.pdf')
    expect(second?.fileName).toBe('second.pdf')
  })

  it('adopts a previously stored object when the staged source is gone', async () => {
    // Upgrade-transition path: an object stored at the legacy deterministic
    // destination (pre-attempt-keys era) is adopted — not copied, and never
    // owned — when its staged source no longer exists. A later failure must
    // retain it without issuing any delete.
    fakeBucket.set(permanentKey('legacy.pdf'), true)
    const failure = await caller()
      .expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows: [
          ownershipRow(
            'legacy',
            [{ id: 'doc-legacy-1', url: tmpUrl('legacy.pdf') }],
            { paidFor: [{ participant: 'lp-does-not-exist', shares: 1 }] },
          ),
        ],
      })
      .then(
        () => {
          throw new Error('expected a BAD_REQUEST rejection')
        },
        (cause) => cause as { code?: unknown },
      )
    expect(failure).toMatchObject({ code: 'BAD_REQUEST' })
    expect(fakeBucket.has(permanentKey('legacy.pdf'))).toBe(true)
    expect(fakeDeleteCalls).toEqual([])
  })

  it('isolates concurrent attempts by attempt-scoped destinations', async () => {
    // Interleaved lifecycles sharing one staged URL: A prepares (copies to
    // A's attempt key), B prepares (copies to B's own key — never reuses
    // A's object), A fails and compensates, B commits. A's cleanup must
    // remove only A's copy; B's committed attachment stays intact.
    fakeBucket.set(`tmp/${runId}/shared-tmp.pdf`, true)
    const fpA = (seed: string) =>
      createHash('sha256').update(`${runId}:interA:${seed}`).digest('hex')
    const fpB = (seed: string) =>
      createHash('sha256').update(`${runId}:interB:${seed}`).digest('hex')
    const buildSharedRow = (
      name: string,
      fp: (seed: string) => string,
      rowNumber: number,
    ) => ({
      rowId: `inter-${name}`,
      rowNumber,
      source: {
        baseFingerprint: fp('base'),
        originFingerprint: fp('origin'),
      },
      expense: {
        expenseDate: new Date('2026-08-10T12:00:00.000Z'),
        expenseTimeZone: 'UTC',
        title: `Interleaved probe ${name}`,
        category: 'general',
        amount: 1000,
        paidBySplitMode: 'BY_AMOUNT',
        paidByList: [{ participant: participantId, shares: 1000 }],
        isMultiPayer: false,
        splitMode: 'EVENLY',
        paidFor: [{ participant: participantId, shares: 1 }],
        documents: [{ id: `doc-inter-${name}`, url: tmpUrl('shared-tmp.pdf') }],
        recurrenceRule: 'NONE',
      },
    })
    const preparedA = await prepareExpenseFileImport(groupId, accountId, [
      buildSharedRow('a', fpA, 920) as unknown as ExpenseFileImportRow,
    ])
    const preparedB = await prepareExpenseFileImport(groupId, accountId, [
      buildSharedRow('b', fpB, 921) as unknown as ExpenseFileImportRow,
    ])
    const urlA = preparedA.rows[0]?.documents[0]?.url
    const urlB = preparedB.rows[0]?.documents[0]?.url
    expect(urlA).toBeTruthy()
    expect(urlB).toBeTruthy()
    // Attempt-scoped destinations: no shared object to fight over.
    expect(urlA).not.toBe(urlB)
    expect(fakeBucket.has(fakeBucketKey(urlA!))).toBe(true)
    expect(fakeBucket.has(fakeBucketKey(urlB!))).toBe(true)

    // A fails after B prepared: A's compensation removes only A's copy.
    await compensateImportAttempt(preparedA)
    expect(fakeBucket.has(fakeBucketKey(urlA!))).toBe(false)
    expect(fakeBucket.has(fakeBucketKey(urlB!))).toBe(true)

    // B commits against A's cleanup having run: attachment intact.
    const committed = await importExpenseFile(
      {
        groupId,
        accountId,
        rows: [
          buildSharedRow('b', fpB, 921) as unknown as ExpenseFileImportRow,
        ],
      },
      { prepared: preparedB },
    )
    expect(committed.importedCount).toBe(1)
    const storedUrl = (
      await prisma.expenseDocument.findFirstOrThrow({
        where: { expenseId: committed.expenseIds[0] },
      })
    ).url
    expect(storedUrl).toBe(urlB)
    expect(fakeBucket.has(fakeBucketKey(urlB!))).toBe(true)
  })

  it('replay and conflicting retries retain committed attachments', async () => {
    fakeBucket.set(`tmp/${runId}/kept.pdf`, true)
    const requestId = crypto.randomUUID()
    const rows = [
      ownershipRow('kept', [{ id: 'doc-kept-1', url: tmpUrl('kept.pdf') }]),
    ]
    const first = await caller().expenses.importFile({
      requestId,
      groupId,
      rows,
    })
    expect(first.importedCount).toBe(1)
    const committedUrl = (
      await prisma.expenseDocument.findFirstOrThrow({
        where: { expenseId: first.expenseIds[0] },
      })
    ).url
    expect(fakeBucket.has(fakeBucketKey(committedUrl))).toBe(true)
    fakeDeleteCalls.length = 0
    const documentsBefore = await prisma.expenseDocument.count({
      where: { ledgerId },
    })

    const replayed = await caller().expenses.importFile({
      requestId,
      groupId,
      rows,
    })
    expect(replayed.importedCount).toBe(1)

    // A conflicting retry stages a fresh upload of the same content: it
    // copies to its own attempt key, conflicts on identity, and compensates
    // only its own copy — the committed attachment is never deleted.
    fakeBucket.set(`tmp/${runId}/kept.pdf`, true)
    const conflict = await caller()
      .expenses.importFile({
        requestId: crypto.randomUUID(),
        groupId,
        rows,
      })
      .then(
        () => {
          throw new Error('expected a CONFLICT rejection')
        },
        (cause) => cause as { code?: unknown },
      )
    expect(conflict).toMatchObject({ code: 'CONFLICT' })

    expect(fakeBucket.has(fakeBucketKey(committedUrl))).toBe(true)
    // Neither the idempotent replay nor the conflicting retry persisted
    // anything new.
    expect(await prisma.expenseDocument.count({ where: { ledgerId } })).toBe(
      documentsBefore,
    )
    expect(
      fakeDeleteCalls.map((key) => keyFromFileUrl(`https://s3.test/${key}`)),
    ).not.toContain(fakeBucketKey(committedUrl))
  })

  it('deletes staged sources after a committed import', async () => {
    fakeBucket.set(`tmp/${runId}/done.pdf`, true)
    const imported = await caller().expenses.importFile({
      requestId: crypto.randomUUID(),
      groupId,
      rows: [
        ownershipRow('done', [{ id: 'doc-done-1', url: tmpUrl('done.pdf') }]),
      ],
    })
    expect(imported.importedCount).toBe(1)
    const committedUrl = (
      await prisma.expenseDocument.findFirstOrThrow({
        where: { expenseId: imported.expenseIds[0] },
      })
    ).url
    expect(fakeBucket.has(fakeBucketKey(committedUrl))).toBe(true)
    expect(fakeBucket.has(`tmp/${runId}/done.pdf`)).toBe(false)
  })

  it('commits successfully when staged-source cleanup fails', async () => {
    // Post-commit hygiene is best-effort and settled: every delete is still
    // attempted under bounded concurrency, failures are logged (not thrown),
    // and the committed import is unaffected. The retained staged source is
    // left for a later hygiene pass.
    fakeBucket.set(`tmp/${runId}/flaky.pdf`, true)
    storageOverrides.failDeleteKeys = new Set(['flaky'])
    const imported = await caller().expenses.importFile({
      requestId: crypto.randomUUID(),
      groupId,
      rows: [
        ownershipRow('flaky', [
          { id: 'doc-flaky-1', url: tmpUrl('flaky.pdf') },
        ]),
      ],
    })
    expect(imported.importedCount).toBe(1)
    expect(fakeDeleteCalls).toContain(`tmp/${runId}/flaky.pdf`)
    expect(fakeBucket.has(`tmp/${runId}/flaky.pdf`)).toBe(true)
  })
})
