import { describe, expect, it, vi } from 'vitest'

import {
  createManyInBatches,
  IMPORT_BATCH_SIZE,
} from './create-many-in-batches'

describe('createManyInBatches', () => {
  it('writes nothing without rows', async () => {
    const createMany = vi.fn().mockResolvedValue(undefined)
    await createManyInBatches([], createMany)
    expect(createMany).not.toHaveBeenCalled()
  })

  it('writes a single batch below the boundary', async () => {
    const rows = Array.from({ length: IMPORT_BATCH_SIZE - 1 }, (_, i) => i)
    const createMany = vi.fn().mockResolvedValue(undefined)
    await createManyInBatches(rows, createMany)
    expect(createMany).toHaveBeenCalledTimes(1)
    expect(createMany).toHaveBeenCalledWith(rows)
  })

  it('splits batches at the boundary and preserves order', async () => {
    const rows = Array.from({ length: 2 * IMPORT_BATCH_SIZE + 7 }, (_, i) => i)
    const seen: number[][] = []
    await createManyInBatches(rows, async (batch) => {
      seen.push([...batch])
    })
    expect(seen).toHaveLength(3)
    expect(seen[0]).toHaveLength(IMPORT_BATCH_SIZE)
    expect(seen[1]).toHaveLength(IMPORT_BATCH_SIZE)
    expect(seen[2]).toHaveLength(7)
    expect(seen.flat()).toEqual(rows)
  })

  it('stops at the first failing batch and propagates the error', async () => {
    const rows = Array.from({ length: 2 * IMPORT_BATCH_SIZE + 1 }, (_, i) => i)
    const createMany = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom-chunk-2'))
    await expect(createManyInBatches(rows, createMany)).rejects.toThrow(
      'boom-chunk-2',
    )
    // First chunk committed, second failed, third never attempted.
    expect(createMany).toHaveBeenCalledTimes(2)
  })
})
