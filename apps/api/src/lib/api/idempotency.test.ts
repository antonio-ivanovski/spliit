import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { Prisma } from '@spliit/db'

import '../../test/mocks'
import { prisma$Transaction, prismaMock } from '../../test/state'
import {
  CREATE_MUTATION_CATALOG,
  CREATE_OPERATIONS,
  deriveCreateToken,
  idempotencyRequestHash,
  runIdempotentCreate,
} from './idempotency'

const routerRoot = fileURLToPath(
  new URL('../../trpc/routers/', import.meta.url),
)

function routerSources(directory = routerRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return routerSources(path)
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts'))
      return []
    return [path]
  })
}

function discoverCreateMutations() {
  const discovered = new Set<string>()
  for (const path of routerSources()) {
    const source = readFileSync(path, 'utf8')
    if (!source.includes('.mutation')) continue
    const relativePath = path.slice(routerRoot.length).replace(/^\//, '')
    let hasExportedCreateProcedure = false
    for (const match of source.matchAll(
      /^export const (create[A-Z]\w*Procedure|importGroupProcedure|importCloudBundleProcedure|importExpenseFileProcedure)\s*=/gm,
    )) {
      hasExportedCreateProcedure ||= match[1]!.startsWith('create')
      discovered.add(`${relativePath}#${match[1]}`)
    }
    for (const match of source.matchAll(
      /^(?:export )?const (create)\s*=\s*protectedProcedure/gm,
    )) {
      discovered.add(`${relativePath}#${match[1]}`)
    }
    if (!hasExportedCreateProcedure) {
      for (const match of source.matchAll(/^  (create(?:[A-Z]\w*)?):\s/gm)) {
        discovered.add(`${relativePath}#${match[1]}`)
      }
    }
  }
  return [...discovered].sort()
}

describe('create idempotency primitives', () => {
  it('hashes semantically identical validated objects canonically', () => {
    expect(idempotencyRequestHash({ b: 2, a: { y: 2, x: 1 } })).toBe(
      idempotencyRequestHash({ a: { x: 1, y: 2 }, b: 2 }),
    )
    expect(idempotencyRequestHash({ amount: 100 })).not.toBe(
      idempotencyRequestHash({ amount: 101 }),
    )
  })

  it('derives stable domain-separated invitation tokens', () => {
    const base = {
      accountId: 'account-1',
      operation: CREATE_OPERATIONS.linkInvitation,
      requestId: '00000000-0000-4000-8000-000000000001',
      discriminator: 'invite-1',
    } as const
    expect(deriveCreateToken(base)).toBe(deriveCreateToken(base))
    expect(deriveCreateToken(base)).not.toBe(
      deriveCreateToken({ ...base, discriminator: 'invite-2' }),
    )
  })

  it('finishes external preparation before opening the transaction', async () => {
    const events: string[] = []
    prismaMock.idempotencyRequest.create.mockImplementation(async () => {
      events.push('marker')
      return {} as never
    })
    prismaMock.idempotencyRequest.update.mockImplementation(async () => {
      events.push('complete')
      return {} as never
    })

    const result = await runIdempotentCreate({
      accountId: 'account-1',
      operation: CREATE_OPERATIONS.expense,
      requestId: '00000000-0000-4000-8000-000000000002',
      input: { amount: 100 },
      prepare: async () => {
        events.push('prepare')
        return { conversion: 'resolved' }
      },
      execute: async (_tx, prepared) => {
        events.push('execute')
        return prepared
      },
    })

    expect(result).toEqual({
      value: { conversion: 'resolved' },
      replayed: false,
    })
    expect(events).toEqual(['prepare', 'marker', 'execute', 'complete'])
  })

  it('replays completed requests without repeating external preparation', async () => {
    const requestId = '00000000-0000-4000-8000-000000000003'
    const input = { amount: 100 }
    prismaMock.idempotencyRequest.findUnique.mockResolvedValue({
      requestHash: idempotencyRequestHash(input),
      result: { expenseId: 'expense-1' },
      completedAt: new Date(),
    } as never)
    const prepare = vi.fn(async () => ({ conversion: 'resolved' }))
    const execute = vi.fn(async () => ({ expenseId: 'unexpected' }))

    const result = await runIdempotentCreate({
      accountId: 'account-1',
      operation: CREATE_OPERATIONS.expense,
      requestId,
      input,
      prepare,
      execute,
      decode: (stored) => stored as { expenseId: string },
    })

    expect(result).toEqual({
      value: { expenseId: 'expense-1' },
      replayed: true,
    })
    expect(prepare).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('rejects a reused request ID before external preparation', async () => {
    prismaMock.idempotencyRequest.findUnique.mockResolvedValue({
      requestHash: idempotencyRequestHash({ amount: 100 }),
      result: { expenseId: 'expense-1' },
      completedAt: new Date(),
    } as never)
    const prepare = vi.fn(async () => ({ conversion: 'resolved' }))

    await expect(
      runIdempotentCreate({
        accountId: 'account-1',
        operation: CREATE_OPERATIONS.expense,
        requestId: '00000000-0000-4000-8000-000000000004',
        input: { amount: 101 },
        prepare,
        execute: async () => ({ expenseId: 'unexpected' }),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(prepare).not.toHaveBeenCalled()
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('passes transaction settings through to the owned transaction', async () => {
    prismaMock.idempotencyRequest.findUnique.mockResolvedValue(null as never)
    prismaMock.idempotencyRequest.create.mockResolvedValue({} as never)
    prismaMock.idempotencyRequest.update.mockResolvedValue({} as never)

    await runIdempotentCreate({
      accountId: 'account-1',
      operation: CREATE_OPERATIONS.expense,
      requestId: '00000000-0000-4000-8000-000000000101',
      input: { amount: 100 },
      transaction: { timeout: 120_000, maxWait: 30_000 },
      execute: async () => ({ ok: true }),
    })

    expect(prisma$Transaction).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 120_000,
      maxWait: 30_000,
    })
  })

  it('keeps the default transaction call shape for ordinary creates', async () => {
    prismaMock.idempotencyRequest.findUnique.mockResolvedValue(null as never)
    prismaMock.idempotencyRequest.create.mockResolvedValue({} as never)
    prismaMock.idempotencyRequest.update.mockResolvedValue({} as never)
    prisma$Transaction.mockClear()

    await runIdempotentCreate({
      accountId: 'account-1',
      operation: CREATE_OPERATIONS.expense,
      requestId: '00000000-0000-4000-8000-000000000102',
      input: { amount: 100 },
      execute: async () => ({ ok: true }),
    })

    expect(prisma$Transaction).toHaveBeenCalledTimes(1)
    expect(prisma$Transaction).toHaveBeenCalledWith(expect.any(Function))
  })

  it('compensates the prepared attempt when execution fails', async () => {
    prismaMock.idempotencyRequest.findUnique.mockResolvedValue(null as never)
    prismaMock.idempotencyRequest.create.mockResolvedValue({} as never)
    const failure = new Error('execute down')
    const compensate = vi.fn(async () => {})
    const onSuccess = vi.fn(async () => {})

    await expect(
      runIdempotentCreate({
        accountId: 'account-1',
        operation: CREATE_OPERATIONS.expenseFileImport,
        requestId: '00000000-0000-4000-8000-000000000103',
        input: { rows: [] },
        prepare: async () => ({ copies: ['copy-1'] }),
        execute: async () => {
          throw failure
        },
        compensate,
        onSuccess,
      }),
    ).rejects.toBe(failure)
    expect(compensate).toHaveBeenCalledTimes(1)
    expect(compensate).toHaveBeenCalledWith({ copies: ['copy-1'] })
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('compensates when the idempotency result update fails after execution', async () => {
    prismaMock.idempotencyRequest.findUnique.mockResolvedValue(null as never)
    prismaMock.idempotencyRequest.create.mockResolvedValue({} as never)
    const updateFailure = new Error('result update down')
    prismaMock.idempotencyRequest.update.mockRejectedValueOnce(updateFailure)
    const compensate = vi.fn(async () => {})

    await expect(
      runIdempotentCreate({
        accountId: 'account-1',
        operation: CREATE_OPERATIONS.expenseFileImport,
        requestId: '00000000-0000-4000-8000-000000000104',
        input: { rows: [] },
        prepare: async () => ({ copies: ['copy-1'] }),
        execute: async () => ({ ok: true }),
        compensate,
      }),
    ).rejects.toBe(updateFailure)
    expect(compensate).toHaveBeenCalledTimes(1)
    expect(compensate).toHaveBeenCalledWith({ copies: ['copy-1'] })
  })

  it('compensates a lost race before replaying the winner', async () => {
    const requestId = '00000000-0000-4000-8000-000000000105'
    const input = { rows: [] }
    prismaMock.idempotencyRequest.findUnique.mockResolvedValueOnce(
      null as never,
    )
    prisma$Transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    )
    prismaMock.idempotencyRequest.findUnique.mockResolvedValueOnce({
      requestHash: idempotencyRequestHash(input),
      result: { importedCount: 3 },
      completedAt: new Date(),
    } as never)
    const compensate = vi.fn(async () => {})

    const result = await runIdempotentCreate({
      accountId: 'account-1',
      operation: CREATE_OPERATIONS.expenseFileImport,
      requestId,
      input,
      prepare: async () => ({ copies: ['copy-1'] }),
      execute: async () => ({ importedCount: -1 }),
      compensate,
      decode: (stored) => stored as { importedCount: number },
    })

    expect(result).toEqual({
      value: { importedCount: 3 },
      replayed: true,
    })
    expect(compensate).toHaveBeenCalledTimes(1)
  })

  it('runs post-commit work only for fresh commits, never for replays', async () => {
    prismaMock.idempotencyRequest.findUnique.mockResolvedValue(null as never)
    prismaMock.idempotencyRequest.create.mockResolvedValue({} as never)
    prismaMock.idempotencyRequest.update.mockResolvedValue({} as never)
    const compensate = vi.fn(async () => {})
    const onSuccess = vi.fn(async () => {})

    await runIdempotentCreate({
      accountId: 'account-1',
      operation: CREATE_OPERATIONS.expenseFileImport,
      requestId: '00000000-0000-4000-8000-000000000106',
      input: { rows: [] },
      prepare: async () => ({ copies: [] }),
      execute: async () => ({ ok: true }),
      compensate,
      onSuccess,
    })

    expect(compensate).not.toHaveBeenCalled()
    expect(onSuccess).toHaveBeenCalledTimes(1)
    expect(onSuccess).toHaveBeenCalledWith({ copies: [] })
  })

  it('never fails a committed result because post-commit work throws', async () => {
    prismaMock.idempotencyRequest.findUnique.mockResolvedValue(null as never)
    prismaMock.idempotencyRequest.create.mockResolvedValue({} as never)
    prismaMock.idempotencyRequest.update.mockResolvedValue({} as never)

    const result = await runIdempotentCreate({
      accountId: 'account-1',
      operation: CREATE_OPERATIONS.expenseFileImport,
      requestId: '00000000-0000-4000-8000-000000000107',
      input: { rows: [] },
      execute: async () => ({ ok: true }),
      onSuccess: async () => {
        throw new Error('post-commit hygiene down')
      },
    })

    expect(result).toEqual({ value: { ok: true }, replayed: false })
  })

  it('maintains an explicit operation for every shared create flow', () => {
    expect(Object.keys(CREATE_OPERATIONS).sort()).toEqual(
      [
        'budget',
        'cloudImport',
        'expenseFileImport',
        'emailInvitation',
        'expense',
        'expenseComment',
        'friendLedger',
        'group',
        'import',
        'linkInvitation',
        'participant',
        'splitPreset',
        'subgroup',
      ].sort(),
    )
    expect(new Set(Object.values(CREATE_OPERATIONS)).size).toBe(
      Object.keys(CREATE_OPERATIONS).length,
    )

    const sharedEntries = CREATE_MUTATION_CATALOG.filter(
      (entry) => entry.mechanism === 'shared',
    )
    expect(sharedEntries.map((entry) => entry.operation).sort()).toEqual(
      Object.values(CREATE_OPERATIONS).sort(),
    )
    expect(
      CREATE_MUTATION_CATALOG.map(
        (entry) => `${entry.source}#${entry.symbol}`,
      ).sort(),
    ).toEqual(discoverCreateMutations())

    for (const entry of sharedEntries) {
      const source = readFileSync(`${routerRoot}${entry.source}`, 'utf8')
      expect(source).toContain('requestId')
      expect(source).toContain('runIdempotentCreate')
      expect(source).toContain(
        `CREATE_OPERATIONS.${
          Object.entries(CREATE_OPERATIONS).find(
            ([, operation]) => operation === entry.operation,
          )![0]
        }`,
      )
    }
  })
})
