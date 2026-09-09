/// <reference lib="webworker" />

import { loadLocaleDictionary } from '@spliit/domain'
import type {
  DelimitedDateOrder,
  DelimitedEncoding,
  ImportCategoryContext,
  DelimitedExpenseMappingV1,
  DelimitedTable,
} from '@spliit/domain/import'
import {
  decodeDelimitedBytes,
  inferDelimitedExpenseMapping,
  mapDelimitedRows,
  previewDelimitedRows,
  parseDelimitedText,
} from '@spliit/domain/import'

type Request =
  | {
      id: string
      action: 'INFER'
      table: DelimitedTable
      currencyCode: string
      dateOrder: 'MDY' | 'DMY'
    }
  | {
      id: string
      action: 'PARSE'
      bytes: ArrayBuffer
      options: {
        encoding: DelimitedEncoding
        headerRow: number
        delimiter?: string
      }
    }
  | {
      id: string
      action: 'MAP'
      categories?: ImportCategoryContext
      table: DelimitedTable
      mapping: DelimitedExpenseMappingV1
      options?: {
        preferredDateOrder?: DelimitedDateOrder
      }
    }
  | {
      id: string
      action: 'PREVIEW'
      table: DelimitedTable
      mapping: DelimitedExpenseMappingV1
      options?: {
        includeAmbiguousDateIssue?: boolean
        preferredDateOrder?: DelimitedDateOrder
        categories?: ImportCategoryContext
      }
    }

const worker = self as DedicatedWorkerGlobalScope

worker.onmessage = ({ data }: MessageEvent<Request>) => {
  void (async () => {
    try {
      if (data.action === 'INFER') {
        worker.postMessage({
          id: data.id,
          ok: true,
          value: inferDelimitedExpenseMapping(
            data.table,
            data.currencyCode,
            data.dateOrder,
          ),
        })
        return
      }
      if (data.action === 'PARSE') {
        const decoded = decodeDelimitedBytes(data.bytes, data.options.encoding)
        const parsed = parseDelimitedText(decoded.text, {
          headerRow: data.options.headerRow,
          delimiter: data.options.delimiter,
          encoding: decoded.encoding,
        })
        worker.postMessage({ id: data.id, ok: true, value: parsed })
        return
      }
      const categories =
        data.action === 'MAP' ? data.categories : data.options?.categories
      if (categories) await loadLocaleDictionary(categories.locale ?? 'en-US')
      const rows =
        data.action === 'MAP'
          ? await (
              mapDelimitedRows as (
                table: DelimitedTable,
                mapping: DelimitedExpenseMappingV1,
                categories?: ImportCategoryContext,
                options?: { preferredDateOrder?: DelimitedDateOrder },
              ) => Promise<unknown>
            )(data.table, data.mapping, data.categories, {
              preferredDateOrder: data.options?.preferredDateOrder,
            })
          : previewDelimitedRows(data.table, data.mapping, data.options)
      worker.postMessage({ id: data.id, ok: true, value: rows })
    } catch (error) {
      worker.postMessage({
        id: data.id,
        ok: false,
        error: error instanceof Error ? error.message : 'Worker failed',
      })
    }
  })()
}

export {}
