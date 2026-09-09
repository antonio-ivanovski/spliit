import {
  INCOME_CATEGORY_ID,
  isSettlementCategory,
  type CategoryId,
} from '../categories'
import {
  createCategorySearchDocumentsForLocale,
  damerauLevenshtein,
  normalizeSearchText,
  suggestCategoryFromTitle,
  type CategoryTitleMemory,
} from '../category-search'
import type {
  DelimitedExpenseMappingV1,
  DelimitedPreviewRow,
} from './generic-csv'
import { importCategorySourceKey, truncateDelimitedRaw } from './generic-csv'

export { importCategorySourceKey }

export type ImportCategoryContext = {
  locale?: string
  history?: CategoryTitleMemory[]
  ignoredSources?: string[]
  suggestUnmatched?: boolean
  explicitRows?: Record<number, CategoryId>
  reviewedRows?: Record<number, Pick<DelimitedPreviewRow, 'title' | 'amount'>>
}
export type ImportCategoryProvenance =
  | 'manual'
  | 'income'
  | 'source'
  | 'import'
  | 'history'
  | 'dictionary'
  | 'fallback'
const ordinary = (id: string) =>
  id !== INCOME_CATEGORY_ID && !isSettlementCategory(id)

/**
 * Indexed conservative title matching, shared by categorization and bulk
 * confirmation.
 */
export function createImportTitleIndex<T>(
  rows: readonly T[],
  title: (row: T) => string,
) {
  const exact = new Map<string, T[]>()
  const lengths = new Map<number, string[]>()
  for (const row of rows) {
    const key = normalizeSearchText(title(row))
    if (!key) continue
    if (!exact.has(key)) {
      exact.set(key, [])
      const bucket = lengths.get(key.length) ?? []
      bucket.push(key)
      lengths.set(key.length, bucket)
    }
    exact.get(key)!.push(row)
  }
  return (value: string) => {
    const key = normalizeSearchText(value)
    const matching = exact.get(key) ?? []
    const fuzzy: T[] = []
    if (key.replaceAll(' ', '').length >= 3) {
      for (const length of [key.length - 1, key.length, key.length + 1]) {
        for (const candidate of lengths.get(length) ?? []) {
          // Changing a digit can mean a different account, bus route, or merchant.
          if (
            candidate === key ||
            candidate.match(/\d+/g)?.join('|') !== key.match(/\d+/g)?.join('|')
          )
            continue
          if (damerauLevenshtein(key, candidate, 1) <= 1)
            fuzzy.push(...exact.get(candidate)!)
        }
      }
    }
    return { exact: matching, fuzzy }
  }
}

export function resolveImportCategories<T extends DelimitedPreviewRow>(
  rows: T[],
  mapping: DelimitedExpenseMappingV1,
  context: ImportCategoryContext = {},
): T[] {
  // Categorize using the user's reviewed title and sign, before building the
  // trusted-title index. Full draft merging happens separately in the client.
  rows = rows.map((row) => ({
    ...row,
    ...context.reviewedRows?.[row.rowNumber],
  }))
  const documents = createCategorySearchDocumentsForLocale(
    context.locale ?? 'en-US',
  )
  const ignored = new Set(
    (context.ignoredSources ?? []).map(importCategorySourceKey),
  )
  const sourceCache = new Map<string, CategoryId | null>()
  const titleCache = new Map<
    string,
    { id: CategoryId; source: ImportCategoryProvenance } | null
  >()
  const trusted = new Map<string, Set<CategoryId>>()
  const sourceFor = (row: T) => {
    const key = importCategorySourceKey(row.categorySource ?? '')
    if (!key || ignored.has(key)) return undefined
    if (Object.hasOwn(mapping.categoryBindings, key))
      return mapping.categoryBindings[key]
    if (!sourceCache.has(key)) {
      const hit = suggestCategoryFromTitle(row.categorySource!, documents)
      sourceCache.set(key, hit && ordinary(hit.id) ? hit.id : null)
    }
    return sourceCache.get(key) ?? undefined
  }
  const sources = rows.map(sourceFor)
  rows.forEach((row, index) => {
    const category = context.explicitRows?.[row.rowNumber] ?? sources[index]
    if (
      !category ||
      category === 'general' ||
      !ordinary(category) ||
      row.amount < 0
    )
      return
    const key = normalizeSearchText(row.title)
    if (!key) return
    const categories = trusted.get(key) ?? new Set<CategoryId>()
    categories.add(category)
    trusted.set(key, categories)
  })
  const history = (context.history ?? []).filter(
    (row) => ordinary(row.categoryId) && row.categoryId !== 'general',
  )
  const historyIndex = createImportTitleIndex(history, (row) => row.title)
  return rows.map((row, index) => {
    let category = mapping.defaults.categoryId
    let provenance: ImportCategoryProvenance = 'fallback'
    const explicit = context.explicitRows?.[row.rowNumber]
    // A manual override always wins, even for negative amounts (refunds kept
    // in an expense category). The income rule only applies when the user has
    // not pinned a category.
    if (explicit) {
      category = explicit
      provenance = 'manual'
    } else if (row.amount < 0) {
      category = INCOME_CATEGORY_ID
      provenance = 'income'
    } else if (sources[index]) {
      category = sources[index]!
      provenance = 'source'
    } else if (context.suggestUnmatched !== false) {
      const key = normalizeSearchText(row.title)
      const confirmed = trusted.get(key)
      if (confirmed?.size === 1) {
        category = [...confirmed][0]!
        provenance = 'import'
      } else if (!confirmed || confirmed.size === 0) {
        if (!titleCache.has(key)) {
          const candidates = historyIndex(row.title)
          const hit = suggestCategoryFromTitle(row.title, documents, [
            ...candidates.exact,
            ...candidates.fuzzy,
          ])
          titleCache.set(
            key,
            hit && ordinary(hit.id) ? { id: hit.id, source: hit.source } : null,
          )
        }
        const hit = titleCache.get(key)
        if (hit) {
          category = hit.id
          provenance = hit.source
        }
      }
    }
    const issues = row.issues.filter(
      (issue) =>
        issue.code !== 'CATEGORY_FALLBACK' &&
        issue.code !== 'CATEGORY_NO_CONFIDENT_MATCH',
    )
    if (provenance === 'fallback') {
      const titlePart = row.title.trim()
        ? ` for “${truncateDelimitedRaw(row.title)}”`
        : ''
      const categoryLabel = category === 'general' ? 'General' : category
      issues.push({
        rowNumber: row.rowNumber,
        field: 'category',
        severity: 'warning',
        code: 'CATEGORY_NO_CONFIDENT_MATCH',
        message: `No confident category match${titlePart}; using ${categoryLabel}.`,
        params: { titlePart, category: categoryLabel },
      })
    }
    return {
      ...row,
      category,
      categoryProvenance: provenance,
      issues,
      warning:
        issues.find((issue) => issue.severity === 'warning')?.message ?? null,
    }
  })
}
