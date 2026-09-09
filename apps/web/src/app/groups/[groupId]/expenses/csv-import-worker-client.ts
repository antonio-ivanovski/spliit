import { loadLocaleDictionary } from '@spliit/domain'
import type {
  DelimitedDateOrder,
  DelimitedEncoding,
  ImportCategoryContext,
  ImportInference,
  DelimitedExpenseMappingV1,
  DelimitedMappedRow,
  DelimitedPreviewRow,
  DelimitedParseResult,
  DelimitedTable,
} from '@spliit/domain/import'
import {
  decodeDelimitedBytes,
  inferDelimitedExpenseMapping,
  mapDelimitedRows,
  previewDelimitedRows,
  parseDelimitedText,
} from '@spliit/domain/import'

type WorkerRequest =
  | {
      action: 'INFER'
      table: DelimitedTable
      currencyCode: string
      dateOrder: 'MDY' | 'DMY'
    }
  | {
      action: 'PARSE'
      bytes: ArrayBuffer
      options: {
        encoding: DelimitedEncoding
        headerRow: number
        delimiter?: string
      }
    }
  | {
      action: 'MAP'
      categories?: ImportCategoryContext
      table: DelimitedTable
      mapping: DelimitedExpenseMappingV1
      options?: {
        preferredDateOrder?: DelimitedDateOrder
      }
    }
  | {
      action: 'PREVIEW'
      table: DelimitedTable
      mapping: DelimitedExpenseMappingV1
      options?: {
        includeAmbiguousDateIssue?: boolean
        preferredDateOrder?: DelimitedDateOrder
        categories?: ImportCategoryContext
      }
    }

type ActiveWorker = {
  worker: Worker
  reject: (reason: Error) => void
  timeoutId?: ReturnType<typeof setTimeout>
}

// Worker evaluation can hang on very large files; callers surface a timeout
// as a mapping-preview error with a retry affordance.
const WORKER_TIMEOUT_MS = 45_000

// Cancellation is scoped to a caller channel rather than only the action.
// The mapping page and an open field editor can legitimately evaluate PREVIEW
// at the same time; cancelling one from the other would make the page briefly
// show a false worker error. Callers that issue generations of the same work
// use a stable channel and still keep their own generation guard.
const activeWorkers = new Map<string, ActiveWorker>()

async function runWorker<T>(
  request: WorkerRequest,
  channel: string = request.action,
): Promise<T> {
  if (typeof Worker === 'undefined') {
    if (request.action === 'INFER')
      return inferDelimitedExpenseMapping(
        request.table,
        request.currencyCode,
        request.dateOrder,
      ) as T
    if (request.action === 'PARSE') {
      const decoded = decodeDelimitedBytes(
        request.bytes,
        request.options.encoding,
      )
      return parseDelimitedText(decoded.text, {
        headerRow: request.options.headerRow,
        delimiter: request.options.delimiter,
        encoding: decoded.encoding,
      }) as T
    }
    const categories =
      request.action === 'MAP'
        ? request.categories
        : request.options?.categories
    if (categories) await loadLocaleDictionary(categories.locale ?? 'en-US')
    if (request.action === 'MAP') {
      return (
        mapDelimitedRows as (
          table: DelimitedTable,
          mapping: DelimitedExpenseMappingV1,
          categories?: ImportCategoryContext,
          options?: { preferredDateOrder?: DelimitedDateOrder },
        ) => Promise<T>
      )(request.table, request.mapping, request.categories, {
        preferredDateOrder: request.options?.preferredDateOrder,
      }) as Promise<T>
    }
    return previewDelimitedRows(
      request.table,
      request.mapping,
      request.options,
    ) as T
  }

  // Only one request of each kind is useful at a time. Mapping edits can be
  // frequent, so terminate the previous worker before cloning another 10k-row
  // table into a new worker. The caller still owns generation checks for
  // environments where a response is already queued.
  const previous = activeWorkers.get(channel)
  if (previous) {
    previous.worker.terminate()
    if (previous.timeoutId) clearTimeout(previous.timeoutId)
    previous.reject(
      new Error('A newer file mapping request superseded this one'),
    )
  }
  const worker = new Worker(
    new URL('./csv-import.worker.ts', import.meta.url),
    {
      type: 'module',
    },
  )
  const id = crypto.randomUUID()
  return new Promise<T>((resolve, reject) => {
    const active: ActiveWorker = { worker, reject }
    activeWorkers.set(channel, active)
    const cleanup = () => {
      if (active.timeoutId) clearTimeout(active.timeoutId)
      if (activeWorkers.get(channel) === active) {
        activeWorkers.delete(channel)
      }
    }
    active.timeoutId = setTimeout(() => {
      worker.terminate()
      cleanup()
      reject(
        new Error(
          'The file worker timed out. Try a smaller file or retry the preview.',
        ),
      )
    }, WORKER_TIMEOUT_MS)
    worker.onmessage = ({ data }) => {
      if (data.id !== id) return
      worker.terminate()
      cleanup()
      if (data.ok) resolve(data.value as T)
      else reject(new Error(data.error ?? 'Worker failed'))
    }
    worker.onerror = () => {
      worker.terminate()
      cleanup()
      reject(new Error('The file worker could not be started'))
    }
    worker.postMessage({ id, ...request })
  })
}

export function parseExpenseFile(
  bytes: ArrayBuffer,
  options: {
    encoding: DelimitedEncoding
    headerRow: number
    delimiter?: string
  },
) {
  // Bytes are cloned into the worker, not transferred, so the caller retains
  // them for reparse.
  return runWorker<DelimitedParseResult>({ action: 'PARSE', bytes, options })
}

export function mapExpenseFile(
  table: DelimitedTable,
  mapping: DelimitedExpenseMappingV1,
  categories?: ImportCategoryContext,
  options?: {
    preferredDateOrder?: DelimitedDateOrder
  },
) {
  return runWorker<DelimitedMappedRow[]>({
    action: 'MAP',
    table,
    mapping,
    categories,
    options,
  })
}

export function previewExpenseFile(
  table: DelimitedTable,
  mapping: DelimitedExpenseMappingV1,
  options?: {
    includeAmbiguousDateIssue?: boolean
    preferredDateOrder?: DelimitedDateOrder
    categories?: ImportCategoryContext
  },
  channel = 'PREVIEW',
) {
  return runWorker<DelimitedPreviewRow[]>(
    {
      action: 'PREVIEW',
      table,
      mapping,
      options,
    },
    channel,
  )
}

export function inferExpenseFile(
  table: DelimitedTable,
  currencyCode: string,
  dateOrder: 'MDY' | 'DMY',
) {
  return runWorker<ImportInference>({
    action: 'INFER',
    table,
    currencyCode,
    dateOrder,
  })
}
