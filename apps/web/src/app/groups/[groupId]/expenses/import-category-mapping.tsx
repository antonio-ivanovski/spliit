import { Loader2 } from 'lucide-react'
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react'

import { CategorySelector } from '@/components/category-selector'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { DEFAULT_CATEGORIES, type CategoryId } from '@spliit/domain'
import {
  importCategorySourceKey,
  type DelimitedExpenseMappingV1,
  type DelimitedPreviewRow,
  type ImportCategoryContext,
} from '@spliit/domain/import'

export type CategoryAssignment =
  | { mode: 'title' }
  | { mode: 'source'; categoryId?: CategoryId }
export type CategoryConfiguration = {
  bindings: DelimitedExpenseMappingV1['categoryBindings']
  ignoredSources: string[]
  suggestUnmatched: boolean
}

export function categoryConfiguration(
  mapping: DelimitedExpenseMappingV1,
  context: ImportCategoryContext,
): CategoryConfiguration {
  return {
    bindings: mapping.categoryBindings,
    ignoredSources: context.ignoredSources ?? [],
    suggestUnmatched: context.suggestUnmatched !== false,
  }
}

export type SourceCategorySummary = {
  key: string
  source: string
  count: number
  detectedCategory?: CategoryId
}

function PendingCategory({ pending }: { pending: boolean }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    // Both transitions go through a timeout: setting state synchronously in
    // the effect would cascade renders, and the render gates on `pending`
    // anyway, so a stale `visible` stays invisible until it is reset here.
    const timer = setTimeout(() => setVisible(pending), pending ? 250 : 0)
    return () => clearTimeout(timer)
  }, [pending])
  return (
    <output
      aria-live="polite"
      className="inline-flex size-4 shrink-0 items-center justify-center"
    >
      {pending && visible ? (
        <Loader2
          className="size-3.5 animate-spin text-muted-foreground"
          aria-label="Updating category suggestion"
        />
      ) : null}
    </output>
  )
}

export function CategorySourceRow({
  summary,
  categoryId,
  titleMode,
  pending,
  onChange,
  onPreview,
}: {
  summary: SourceCategorySummary
  categoryId: CategoryId
  titleMode: boolean
  pending: boolean
  onChange: (assignment: CategoryAssignment) => void
  onPreview?: (sourceKey: string) => void
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:gap-6">
      <div className="min-w-0 flex-1">
        <p className="font-medium break-words">{summary.source}</p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span>
            {summary.count} expense{summary.count === 1 ? '' : 's'}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-auto px-1 py-0 text-xs font-medium"
            aria-label={`View expenses for ${summary.source}`}
            onClick={() => onPreview?.(summary.key)}
          >
            View
          </Button>
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-2 sm:w-96 sm:shrink-0">
        <RadioGroup
          aria-label={`Category mode for ${summary.source}`}
          value={titleMode ? 'title' : 'source'}
          onValueChange={(mode) => {
            if (mode === (titleMode ? 'title' : 'source')) return
            onChange(mode === 'title' ? { mode: 'title' } : { mode: 'source' })
          }}
          className="flex flex-wrap items-center gap-x-4 gap-y-2"
        >
          <Label
            htmlFor={`${id}-source`}
            className="flex items-center gap-2 font-normal"
          >
            <RadioGroupItem id={`${id}-source`} value="source" /> Use selected
            category
          </Label>
          <Label
            htmlFor={`${id}-title`}
            className="flex items-center gap-2 font-normal"
          >
            <RadioGroupItem id={`${id}-title`} value="title" /> Detect from
            titles
          </Label>
          <PendingCategory pending={pending} />
        </RadioGroup>
        {titleMode ? (
          <p className="text-xs text-muted-foreground">
            Title detection can assign different categories to these expenses.
          </p>
        ) : (
          <>
            <CategorySelector
              categories={DEFAULT_CATEGORIES}
              defaultValue={categoryId}
              isLoading={pending}
              onValueChange={(categoryId) =>
                onChange({ mode: 'source', categoryId })
              }
            />
            <p className="text-xs text-muted-foreground">
              Expenses from this source use this category. It starts as the
              detected suggestion, or the fallback category when nothing was
              detected.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

export function ImportCategoryMapping({
  mapping,
  context,
  rows,
  published,
  updating,
  onAssignment,
  onFallbackChange,
  onSuggestUnmatched,
  historyUnavailable,
  onPreviewSource,
  children,
}: {
  mapping: DelimitedExpenseMappingV1
  context: ImportCategoryContext
  rows: DelimitedPreviewRow[]
  published: CategoryConfiguration | null
  updating: boolean
  onAssignment: (sourceKey: string, assignment: CategoryAssignment) => void
  onFallbackChange: (categoryId: CategoryId) => void
  onSuggestUnmatched: (enabled: boolean) => void
  historyUnavailable: boolean
  onPreviewSource?: (sourceKey: string) => void
  children?: ReactNode
}) {
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const searchId = useId()
  const fallbackId = useId()
  const summaries = useMemo(() => {
    const sources = new Map<string, SourceCategorySummary>()
    for (const row of rows) {
      const source = row.categorySource?.trim()
      if (!source) continue
      const key = importCategorySourceKey(source)
      const summary = sources.get(key) ?? { key, source, count: 0 }
      summary.count += 1
      if (row.categoryProvenance === 'source')
        summary.detectedCategory = row.category
      sources.set(key, summary)
    }
    return [...sources.values()]
  }, [rows])
  const filtered = summaries.filter(({ source }) =>
    source.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  )
  const pageCount = Math.max(1, Math.ceil(filtered.length / 25))
  const currentPage = Math.min(page, pageCount - 1)
  const ignored = new Set(context.ignoredSources)
  const publishedIgnored = new Set(published?.ignoredSources)
  const suggestUnmatched = context.suggestUnmatched !== false

  return (
    <Card>
      <CardHeader>
        <CardTitle>Category mapping</CardTitle>
        <CardDescription>
          Categories apply in this order: your manual row edits, Income for
          negative amounts, then each source&apos;s selected category (or title
          detection when enabled), then title suggestions, then the fallback
          category below.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          1. Manually edited rows keep their category. 2. Other negative amounts
          always use Income. 3. Each source uses its selected category, unless
          set to Detect from titles. 4. Remaining expenses try title suggestions
          from this file, previous expenses, and keywords (when enabled). 5.
          Anything left uses the fallback category.
        </p>
        <Label className="flex items-center gap-2">
          <Checkbox
            checked={suggestUnmatched}
            onCheckedChange={(checked) => {
              if ((checked === true) !== suggestUnmatched)
                onSuggestUnmatched(checked === true)
            }}
          />
          Suggest categories for unmatched expenses
          <PendingCategory
            pending={
              updating &&
              published !== null &&
              published.suggestUnmatched !== suggestUnmatched
            }
          />
        </Label>
        {historyUnavailable ? (
          <p className="text-sm text-muted-foreground">
            Previous expenses are unavailable. Suggestions use this file and
            category names.
          </p>
        ) : null}
        {summaries.length > 25 ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor={searchId}>Find a source category</Label>
            <Input
              id={searchId}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                setPage(0)
              }}
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-muted-foreground">
                {filtered.length} categories · Page {currentPage + 1} of{' '}
                {pageCount}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={currentPage === 0}
                  onClick={() => setPage(currentPage - 1)}
                >
                  Previous categories
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={currentPage + 1 >= pageCount}
                  onClick={() => setPage(currentPage + 1)}
                >
                  Next categories
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        <div className="divide-y">
          {filtered.length ? (
            filtered
              .slice(currentPage * 25, (currentPage + 1) * 25)
              .map((summary) => (
                <CategorySourceRow
                  key={summary.key}
                  summary={summary}
                  categoryId={
                    mapping.categoryBindings[summary.key] ??
                    summary.detectedCategory ??
                    mapping.defaults.categoryId
                  }
                  titleMode={ignored.has(summary.key)}
                  pending={
                    updating &&
                    published !== null &&
                    (publishedIgnored.has(summary.key) !==
                      ignored.has(summary.key) ||
                      published.bindings[summary.key] !==
                        mapping.categoryBindings[summary.key])
                  }
                  onChange={(assignment) =>
                    onAssignment(summary.key, assignment)
                  }
                  onPreview={onPreviewSource}
                />
              ))
          ) : (
            <p className="py-4 text-sm text-muted-foreground">
              {summaries.length
                ? 'No source categories match your search.'
                : 'No source categories were found. Titles and the fallback category will be used.'}
            </p>
          )}
        </div>
        <div className="border-t pt-4">
          <div className="max-w-md space-y-2">
            <Label id={fallbackId}>Fallback category</Label>
            <fieldset
              aria-labelledby={fallbackId}
              className="min-w-0 border-0 p-0"
            >
              <CategorySelector
                categories={DEFAULT_CATEGORIES}
                defaultValue={mapping.defaults.categoryId}
                isLoading={updating}
                onValueChange={onFallbackChange}
              />
            </fieldset>
            <p className="text-xs text-muted-foreground">
              Used when a source has no selected category and title detection
              finds no confident match.
            </p>
          </div>
        </div>
        {children}
      </CardContent>
    </Card>
  )
}
