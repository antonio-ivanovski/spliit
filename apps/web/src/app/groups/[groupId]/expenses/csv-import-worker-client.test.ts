import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  inferExpenseFile,
  mapExpenseFile,
  parseExpenseFile,
  previewExpenseFile,
} from './csv-import-worker-client'

const csv = 'Date,Description,Amount\n03/04/2022,Cafe,10\n05/06/2022,Bistro,20'
const bytes = () => new TextEncoder().encode(csv).buffer as ArrayBuffer

class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  terminated = false
  posted: { id: string }[] = []
  constructor(public url: URL) {
    FakeWorker.instances.push(this)
  }
  postMessage(message: { id: string }) {
    this.posted.push(message)
  }
  terminate() {
    this.terminated = true
  }
  respond(value: unknown) {
    this.onmessage?.({ data: { id: this.posted[0]!.id, ok: true, value } })
  }
}

describe('csv-import-worker-client', () => {
  beforeEach(() => {
    FakeWorker.instances = []
    vi.unstubAllGlobals()
  })

  it('evaluates directly when no Worker constructor exists', async () => {
    vi.stubGlobal('Worker', undefined)
    const parsed = await parseExpenseFile(bytes(), {
      encoding: 'AUTO',
      headerRow: 0,
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.table.delimiter).toBe(',')
    expect(parsed.table.columns.map((column) => column.sourceLabel)).toEqual([
      'Date',
      'Description',
      'Amount',
    ])

    const inference = await inferExpenseFile(parsed.table, 'USD', 'MDY')
    expect(inference.mapping.mappings.money.mode).toBe('VISUAL')

    const preview = await previewExpenseFile(parsed.table, inference.mapping)
    expect(preview.map((row) => row.amount)).toEqual([1000, 2000])

    const first = await mapExpenseFile(parsed.table, inference.mapping)
    const second = await mapExpenseFile(parsed.table, inference.mapping)
    expect(first.map((row) => row.rowId)).toEqual(
      second.map((row) => row.rowId),
    )
  })

  it('supersedes the previous request on the same channel', async () => {
    vi.stubGlobal('Worker', FakeWorker as never)
    const options = { encoding: 'AUTO' as const, headerRow: 0 }
    const first = parseExpenseFile(bytes(), options)
    const second = parseExpenseFile(bytes(), options)
    expect(FakeWorker.instances).toHaveLength(2)
    expect(FakeWorker.instances[0]!.terminated).toBe(true)
    await expect(first).rejects.toThrow(/superseded/)
    FakeWorker.instances[1]!.respond({ ok: true })
    await expect(second).resolves.toEqual({ ok: true })
  })

  it('surfaces a startup error when the worker cannot be started', async () => {
    vi.stubGlobal('Worker', FakeWorker as never)
    const pending = parseExpenseFile(bytes(), {
      encoding: 'AUTO',
      headerRow: 0,
    })
    const worker = FakeWorker.instances[0]!
    worker.onerror?.()
    await expect(pending).rejects.toThrow(/could not be started/)
  })

  it('keeps MAP and PREVIEW consistent on the direct fallback path', async () => {
    // No Worker in this environment: both run direct. This asserts MAP/PREVIEW
    // parity (including the forwarded date order), not channel isolation —
    // that is covered by 'does not supersede across channels' below.
    // Ambiguous fixtures: with preferredDateOrder DMY both must read 3 Apr /
    // 5 Jun — dropping the forwarding would parse MDY (4 Mar / 6 May) and the
    // explicit expectation below would fail.
    vi.stubGlobal('Worker', undefined)
    const parsed = await parseExpenseFile(bytes(), {
      encoding: 'AUTO',
      headerRow: 0,
    })
    if (!parsed.ok) throw new Error(parsed.error)
    const inference = await inferExpenseFile(parsed.table, 'USD', 'MDY')
    const mapped = await mapExpenseFile(
      parsed.table,
      inference.mapping,
      undefined,
      {
        preferredDateOrder: 'DMY',
      },
    )
    const preview = await previewExpenseFile(parsed.table, inference.mapping, {
      preferredDateOrder: 'DMY',
    })
    expect(mapped.map((row) => row.expenseDate)).toEqual(
      preview.map((row) => row.expenseDate),
    )
    expect(mapped.map((row) => row.expenseDate)).toEqual([
      '2022-04-03',
      '2022-06-05',
    ])
  })

  it('does not supersede across channels', async () => {
    vi.stubGlobal('Worker', FakeWorker as never)
    const parsedOptions = { encoding: 'AUTO' as const, headerRow: 0 }
    const parsePending = parseExpenseFile(bytes(), parsedOptions)
    // MAP defaults to its own channel while PREVIEW uses a separate one, so
    // issuing a preview must not terminate the in-flight map worker.
    const table = {
      columns: [],
      rows: [],
      delimiter: ',',
      headerRow: 0,
      encoding: 'UTF-8',
    } as never
    const mapping = { mappings: {} } as never
    const mapPending = mapExpenseFile(table, mapping)
    const previewPending = previewExpenseFile(table, mapping)
    expect(FakeWorker.instances).toHaveLength(3)
    expect(FakeWorker.instances[1]!.terminated).toBe(false)
    expect(FakeWorker.instances[2]!.terminated).toBe(false)
    FakeWorker.instances[0]!.respond({ ok: true })
    FakeWorker.instances[1]!.respond([])
    FakeWorker.instances[2]!.respond([])
    await expect(parsePending).resolves.toEqual({ ok: true })
    await expect(mapPending).resolves.toEqual([])
    await expect(previewPending).resolves.toEqual([])
  })

  it('ignores worker responses with a stale message id', async () => {
    vi.stubGlobal('Worker', FakeWorker as never)
    const pending = parseExpenseFile(bytes(), {
      encoding: 'AUTO',
      headerRow: 0,
    })
    const worker = FakeWorker.instances[0]!
    worker.onmessage?.({ data: { id: 'stale-id', ok: true, value: 'WRONG' } })
    worker.respond('RIGHT')
    await expect(pending).resolves.toBe('RIGHT')
  })
})
