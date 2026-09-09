import type { TFunction } from 'i18next'
import { AlertCircle, Loader2 } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { useVirtualizedRows } from '@/components/use-virtualized-rows'
import { getCategoryById } from '@spliit/domain'
import {
  classifyDelimitedFieldMapping,
  resolvedAutoDateFormatLabel,
  type DelimitedFieldMapping,
  type DelimitedPreviewRow,
  type DelimitedRowIssue,
  type DelimitedTable,
  type ImportCategoryProvenance,
} from '@spliit/domain/import'

import { translateImportIssue } from './csv-import-messages'
import {
  formatMinorAmount,
  hashPreviewLens,
  preferredDateOrder,
  type FieldMappingKey,
  type MappingFieldKey,
  type MappingIssueField,
} from './csv-import-review-model'

export const COMPACT_PREVIEW_ROWS = 10

type I18nKey = Parameters<TFunction>[0]

export type MappingPreviewStatus =
  | 'initializing'
  | 'ready'
  | 'updating'
  | 'error'

export const fieldMeta = {
  dateTime: {
    title: 'ExpenseImport.viewers.fields.dateTime.title',
    description: 'ExpenseImport.viewers.fields.dateTime.description',
    kind: 'date',
  },
  title: {
    title: 'ExpenseImport.viewers.fields.title.title',
    description: 'ExpenseImport.viewers.fields.title.description',
    kind: 'text',
  },
  categorySource: {
    title: 'ExpenseImport.viewers.fields.categorySource.title',
    description: 'ExpenseImport.viewers.fields.categorySource.description',
    kind: 'text',
  },
  notes: {
    title: 'ExpenseImport.viewers.fields.notes.title',
    description: 'ExpenseImport.viewers.fields.notes.description',
    kind: 'text',
  },
  externalId: {
    title: 'ExpenseImport.viewers.fields.externalId.title',
    description: 'ExpenseImport.viewers.fields.externalId.description',
    kind: 'text',
  },
  sourceAccount: {
    title: 'ExpenseImport.viewers.fields.sourceAccount.title',
    description: 'ExpenseImport.viewers.fields.sourceAccount.description',
    kind: 'text',
  },
} as const satisfies Record<
  FieldMappingKey,
  { title: string; description: string; kind: 'date' | 'amount' | 'text' }
>

function fieldMappingKind(field: MappingFieldKey) {
  if (field === 'dateTime') return 'dateTime' as const
  if (field === 'title' || field === 'categorySource' || field === 'notes')
    return 'text' as const
  return 'text' as const
}

export type MappingVisualization = {
  mode: 'SIMPLE' | 'ADVANCED' | 'CODE' | null
  lines: string[]
  code: string | null
  sections?: Array<{ title: string; lines: string[] }>
}

export function MappingVisualizationContent({
  visualization,
}: {
  visualization: MappingVisualization
}) {
  if (visualization.code) {
    return (
      <pre className="mt-2 max-h-20 overflow-auto rounded-md bg-muted/30 p-2 text-xs whitespace-pre-wrap">
        {visualization.code}
      </pre>
    )
  }
  if (visualization.sections?.length) {
    return (
      <div className="mt-2 divide-y text-sm">
        {visualization.sections.map((section) => (
          <section
            key={section.title}
            className="space-y-1 py-2 first:pt-0 last:pb-0"
          >
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {section.title}
            </p>
            {section.lines.map((line) => (
              <p key={line} className="font-medium">
                {line}
              </p>
            ))}
          </section>
        ))}
      </div>
    )
  }
  return (
    <div className="mt-2 space-y-1 text-sm font-medium">
      {visualization.lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>
  )
}

export function mappingVisualization(
  field: MappingFieldKey,
  mapping: DelimitedFieldMapping | undefined,
  table: DelimitedTable,
  t: TFunction,
): MappingVisualization {
  if (!mapping)
    return {
      mode: null,
      lines: [t('ExpenseImport.viewers.notMapped')],
      code: null,
    }
  if (mapping.mode === 'CEL') {
    return {
      mode: 'CODE' as const,
      lines: [],
      code: mapping.expression,
    }
  }
  const mode = classifyDelimitedFieldMapping(mapping, fieldMappingKind(field))
  const labelFor = (key: string) =>
    table.columns.find((column) => column.key === key)?.label ?? key
  if (mode === 'SIMPLE') {
    const source = mapping.sourceValues[0]
    const lines = [
      t('ExpenseImport.viewers.simpleSource', {
        label: labelFor(source?.primary ?? ''),
      }),
    ]
    const essentials = mapping.transforms
      .filter((transform) => transform.kind !== 'JOIN')
      .map((transform) => {
        if (transform.kind === 'TRIM') return ''
        if (transform.kind === 'PARSE_DATE')
          return t('ExpenseImport.viewers.simpleDateFormat', {
            format: resolvedAutoDateFormatLabel(
              transform.format,
              mapping,
              table,
              preferredDateOrder(),
            ),
          })
        if (transform.kind === 'PARSE_NUMBER')
          return t('ExpenseImport.viewers.simpleNumberFormat', {
            format: transform.format,
          })
        if (transform.kind === 'SIGN_FROM_COLUMN')
          return t('ExpenseImport.viewers.simpleSignFrom', {
            label: labelFor(transform.columnKey),
          })
        if (transform.kind === 'EXTRACT_CURRENCY')
          return t('ExpenseImport.viewers.extractCurrency')
        return ''
      })
      .filter(Boolean)
    return { mode, lines: [...lines, ...essentials], code: null }
  }
  const sources = mapping.sourceValues
    .map((source, index) => {
      const primary = labelFor(source.primary)
      const fallbacks = source.fallbacks.map((key) =>
        t('ExpenseImport.viewers.fallbackTo', { label: labelFor(key) }),
      )
      return mapping.sourceValues.length > 1
        ? t('ExpenseImport.viewers.sourceValueIndexed', {
            index: index + 1,
            sources: [primary, ...fallbacks].join(' → '),
          })
        : [primary, ...fallbacks].join(' → ')
    })
    .join(' + ')
  const transforms = mapping.transforms.map((transform) => {
    if (transform.kind === 'JOIN')
      return t('ExpenseImport.viewers.joinWith', {
        separator: transform.separator,
      })
    if (transform.kind === 'TRIM')
      return t('ExpenseImport.viewers.normalizeWhitespace')
    if (transform.kind === 'UPPER')
      return t('ExpenseImport.viewers.transformUppercase')
    if (transform.kind === 'LOWER')
      return t('ExpenseImport.viewers.transformLowercase')
    if (transform.kind === 'REPLACE')
      return t('ExpenseImport.viewers.replaceWith', {
        search: transform.search || '…',
      })
    if (transform.kind === 'REGEX_EXTRACT')
      return t('ExpenseImport.viewers.regexExtract')
    if (transform.kind === 'PARSE_DATE')
      return t('ExpenseImport.viewers.parseDate', {
        format: resolvedAutoDateFormatLabel(
          transform.format,
          mapping,
          table,
          preferredDateOrder(),
        ),
      })
    if (transform.kind === 'PARSE_NUMBER')
      return t('ExpenseImport.viewers.parseNumber', {
        format: transform.format,
      })
    if (transform.kind === 'EXTRACT_CURRENCY')
      return t('ExpenseImport.viewers.extractCurrency')
    if (transform.kind === 'DEBIT_CREDIT')
      return t('ExpenseImport.viewers.debitCredit', {
        debit: labelFor(transform.debitColumn),
        credit: labelFor(transform.creditColumn),
      })
    return t('ExpenseImport.viewers.signFromColumn', {
      label: labelFor(transform.columnKey),
    })
  })
  return {
    mode,
    lines: [],
    code: null,
    sections: [
      {
        title: t('ExpenseImport.viewers.sectionSourceValues'),
        lines: [sources],
      },
      {
        title: t('ExpenseImport.viewers.sectionTransformations'),
        lines: transforms.length
          ? transforms
          : [t('ExpenseImport.viewers.noTransformations')],
      },
    ],
  }
}

export function RawPreview({
  table,
  visibleRows = COMPACT_PREVIEW_ROWS,
  onShowAll,
}: {
  table: DelimitedTable
  visibleRows?: number
  onShowAll: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="w-full max-w-full min-w-0 overflow-hidden rounded-md border">
      <div className="max-w-full overflow-x-auto">
        <table className="w-full min-w-max text-left text-sm">
          <thead className="bg-muted/50">
            <tr>
              <SourceTableHeaderCell>
                {t('ExpenseImport.viewers.rowHeader')}
              </SourceTableHeaderCell>
              {table.columns.map((column) => (
                <SourceTableHeaderCell key={column.key} className="max-w-64">
                  {column.label}
                </SourceTableHeaderCell>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.slice(0, visibleRows).map((row) => (
              <tr key={row.rowNumber} className="border-t">
                <td className="px-3 py-2 text-muted-foreground">
                  {row.rowNumber}
                </td>
                {row.cells.map((cell, index) => (
                  <td
                    key={table.columns[index]?.key ?? `column-${index}`}
                    className="max-w-64 truncate px-3 py-2"
                    title={cell}
                  >
                    {cell || (
                      <span className="text-muted-foreground">
                        {t('ExpenseImport.viewers.blank')}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <TableFooterButton onClick={onShowAll}>
        {t('ExpenseImport.viewers.showAll')}
      </TableFooterButton>
    </div>
  )
}

// oxlint-disable react/react-compiler -- TanStack Virtual exposes measurement refs through its virtualizer result.
export function SourceFileDialog({
  table,
  open,
  onOpenChange,
}: {
  table: DelimitedTable
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const virtualRows = useVirtualizedRows({
    count: table.rows.length,
    estimateSize: 42,
    enabled: open,
    remeasureKey: table,
    getItemKey: (index) => table.rows[index]!.rowNumber,
    overscan: 8,
  })
  const gridTemplateColumns = `4rem repeat(${table.columns.length}, 12rem)`
  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-[min(96vw,80rem)]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t('ExpenseImport.viewers.sourceFileTitle')}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {t('ExpenseImport.viewers.sourceFileDescription', {
              rowCount: table.rows.length,
              columnCount: table.columns.length,
            })}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="min-h-0 overflow-y-auto">
          <div
            ref={virtualRows.setScrollRef}
            className="h-[min(58dvh,30rem)] min-h-64 max-w-full overflow-auto rounded-md border sm:h-[min(70dvh,42rem)]"
          >
            <table
              aria-label={t('ExpenseImport.viewers.parsedSourceRows')}
              className="min-w-max text-left text-sm"
            >
              <caption className="sr-only">
                {t('ExpenseImport.viewers.parsedSourceRowsCaption')}
              </caption>
              <thead>
                <tr
                  className="sticky top-0 z-20 grid min-w-max bg-muted shadow-sm"
                  style={{ gridTemplateColumns }}
                >
                  <SourceTableHeaderCell className="sticky left-0 z-10 bg-muted">
                    {t('ExpenseImport.viewers.rowHeader')}
                  </SourceTableHeaderCell>
                  {table.columns.map((column) => (
                    <SourceTableHeaderCell key={column.key}>
                      {column.label}
                    </SourceTableHeaderCell>
                  ))}
                </tr>
              </thead>
              <tbody
                className="relative block min-w-max"
                style={{ height: virtualRows.totalSize }}
              >
                {virtualRows.items.map((item) => {
                  const row = table.rows[item.index]!
                  return (
                    <tr
                      key={row.rowNumber}
                      ref={virtualRows.measureElement}
                      data-index={item.index}
                      aria-rowindex={item.index + 2}
                      className="absolute left-0 grid min-w-max border-t bg-background"
                      style={{
                        gridTemplateColumns,
                        height: item.size,
                        top: 0,
                        transform: `translateY(${item.start}px)`,
                      }}
                    >
                      <td className="sticky left-0 z-10 bg-background px-3 py-2 text-muted-foreground">
                        {row.rowNumber}
                      </td>
                      {row.cells.map((cell, index) => (
                        <td
                          key={table.columns[index]?.key ?? `column-${index}`}
                          className="w-48 truncate px-3 py-2"
                          title={cell}
                        >
                          {cell || (
                            <span className="text-muted-foreground">
                              {t('ExpenseImport.viewers.blank')}
                            </span>
                          )}
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            {t('ExpenseImport.viewers.close')}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

// oxlint-enable react/react-compiler

export function previewFieldValue(
  row: DelimitedPreviewRow,
  field: MappingFieldKey,
  t: TFunction,
): string {
  if (field === 'dateTime') {
    if (!row.expenseDate) return t('ExpenseImport.viewers.invalidDate')
    const hours = Math.floor(row.expenseTimeMinutes / 60)
      .toString()
      .padStart(2, '0')
    const minutes = (row.expenseTimeMinutes % 60).toString().padStart(2, '0')
    return `${row.expenseDate} ${hours}:${minutes}`
  }
  if (field === 'title') return row.title || t('ExpenseImport.viewers.blank')
  if (field === 'categorySource')
    return row.categorySource || t('ExpenseImport.viewers.blank')
  if (field === 'notes') return row.notes || t('ExpenseImport.viewers.blank')
  if (field === 'externalId')
    return row.externalId || t('ExpenseImport.viewers.blank')
  if (field === 'sourceAccount')
    return row.sourceAccount || t('ExpenseImport.viewers.blank')
  return t('ExpenseImport.viewers.blank')
}

export function previewSourceValues(
  table: DelimitedTable,
  rowNumber: number,
  mapping: DelimitedFieldMapping | undefined,
  t: TFunction,
) {
  if (!mapping || mapping.mode === 'CEL') return []
  const row = table.rows.find((candidate) => candidate.rowNumber === rowNumber)
  if (!row) return []
  const multipleValues = mapping.sourceValues.length > 1
  return mapping.sourceValues.flatMap((source, sourceIndex) => {
    const keys = [source.primary, ...source.fallbacks]
    return keys.map((key, columnIndex) => {
      const column = table.columns.find((candidate) => candidate.key === key)
      const sourceKind =
        columnIndex === 0
          ? multipleValues
            ? t('ExpenseImport.viewers.sourceKindIndexed', {
                index: sourceIndex + 1,
              })
            : t('ExpenseImport.viewers.sourceKindSource')
          : t('ExpenseImport.viewers.sourceKindFallback')
      return {
        label: column?.label ?? key,
        sourceKind,
        value:
          column && row.cells[column.index]
            ? row.cells[column.index]
            : t('ExpenseImport.viewers.blank'),
        // Stable discriminator for the translated sourceKind above: external
        // renderers must compare this flag (not the translated text) to tell
        // fallback entries apart.
        isFallback: columnIndex !== 0,
      }
    })
  })
}

function issueFieldLabel(field: MappingIssueField): I18nKey {
  if (field === 'category') return 'ExpenseImport.viewers.issueFieldCategory'
  if (field === 'amount' || field === 'currency')
    return 'ExpenseImport.viewers.issueFieldMoney'
  // Every remaining field has a fieldMeta entry; the fallback is unreachable
  // but keeps the return type a valid key union for strict t() checks.
  return fieldMeta[field]?.title ?? 'ExpenseImport.viewers.issueFieldMoney'
}

export function issueSummary(issues: DelimitedRowIssue[], t: TFunction) {
  const errors = issues.filter(({ severity }) => severity === 'error').length
  const warnings = issues.length - errors
  if (errors && warnings)
    return [
      t('ExpenseImport.viewers.issueErrors', { count: errors }),
      t('ExpenseImport.viewers.issueWarnings', { count: warnings }),
    ].join(' · ')
  if (errors) return t('ExpenseImport.viewers.issueErrors', { count: errors })
  return t('ExpenseImport.viewers.issueWarnings', { count: warnings })
}

export function mappedRowStatus(row: DelimitedPreviewRow, showIssues = true) {
  const issues = showIssues ? row.issues : []
  if (issues.some(({ severity }) => severity === 'error')) return 'error'
  if (issues.length) return 'warning'
  return 'ready'
}

function categoryProvenanceLabel(
  provenance: ImportCategoryProvenance | undefined,
  t: TFunction,
): string | undefined {
  if (!provenance) return undefined
  const labels = {
    manual: 'ExpenseImport.viewers.provenanceManual',
    income: 'ExpenseImport.viewers.provenanceIncome',
    source: 'ExpenseImport.viewers.provenanceSource',
    import: 'ExpenseImport.viewers.provenanceImport',
    history: 'ExpenseImport.viewers.provenanceHistory',
    dictionary: 'ExpenseImport.viewers.provenanceDictionary',
    fallback: 'ExpenseImport.viewers.provenanceFallback',
  } as const
  return t(labels[provenance])
}

const mappedStatusKeys = {
  error: 'ExpenseImport.viewers.statusError',
  warning: 'ExpenseImport.viewers.statusWarning',
  ready: 'ExpenseImport.viewers.statusReady',
  duplicate: 'ExpenseImport.viewers.statusDuplicate',
} as const

export function MappedStatusBadge({
  status,
  id,
}: {
  status: 'error' | 'warning' | 'ready' | 'duplicate'
  id?: string
}) {
  const { t } = useTranslation()
  return (
    <Badge
      id={id}
      variant={
        status === 'error'
          ? 'destructive'
          : status === 'ready'
            ? 'secondary'
            : 'warning'
      }
    >
      {t(mappedStatusKeys[status])}
    </Badge>
  )
}

export function MappedCategoryCell({
  category,
  provenance,
}: {
  category: string
  provenance: ImportCategoryProvenance | undefined
}) {
  const { t } = useTranslation()
  const provenanceLabel = categoryProvenanceLabel(provenance, t)
  return (
    <td className="px-3 py-3 whitespace-nowrap">
      <span className="me-2 text-xs text-muted-foreground md:hidden">
        {t('ExpenseImport.viewers.headerCategory')}
      </span>
      <span>
        {getCategoryById(category)?.name ?? category}
        {provenanceLabel ? (
          <span className="sr-only"> ({provenanceLabel})</span>
        ) : null}
      </span>
    </td>
  )
}

/**
 * Shared column model for the mapped-expense tables (compact preview, view-all
 * dialog, review list). The desktop min-width floor must always cover the grid
 * track minimums (mapped tracks sum to 55rem, review tracks to 56.5rem). A
 * smaller floor lets the right columns overflow their row boxes and spill past
 * the header background and row dividers in narrow containers.
 */
const MAPPED_TABLE_GRID =
  'md:grid-cols-[7rem_minmax(10rem,1fr)_minmax(12rem,1.5fr)_9rem_10rem_7rem]'
const MAPPED_TABLE_MIN_WIDTH = 'md:min-w-[55rem]'
export const REVIEW_TABLE_GRID =
  'md:grid-cols-[4.5rem_6rem_minmax(9rem,0.9fr)_minmax(12rem,1.5fr)_8rem_10rem_7rem]'
export const REVIEW_TABLE_MIN_WIDTH = 'md:min-w-[57rem]'

function MappedTableHeaderCell({
  children,
  end = false,
  pinned = false,
}: {
  children: ReactNode
  end?: boolean
  pinned?: boolean
}) {
  return (
    <th
      scope="col"
      className={`${pinned ? 'col-span-2 md:col-span-1' : 'hidden md:block'} min-w-0 bg-muted/95 px-3 py-2 font-medium text-muted-foreground ${end ? 'text-end' : 'text-start'}`}
    >
      {children}
    </th>
  )
}

export function MappedRowLabel({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={`me-2 text-xs text-muted-foreground md:hidden ${className}`}
    >
      {children}
    </span>
  )
}

export function MappedTableRow({
  gridClass,
  minWidthClass,
  virtualized = false,
  rowIndex,
  measureRef,
  style,
  children,
}: {
  gridClass: string
  minWidthClass: string
  virtualized?: boolean
  rowIndex?: number
  measureRef?: (element: HTMLElement | null) => void
  style?: CSSProperties
  children: ReactNode
}) {
  return (
    <tr
      ref={measureRef}
      data-index={rowIndex}
      aria-rowindex={rowIndex === undefined ? undefined : rowIndex + 2}
      style={style}
      className={
        virtualized
          ? `absolute inset-x-0 grid grid-cols-2 items-start border-t bg-background ${minWidthClass} ${gridClass}`
          : `grid w-full min-w-0 grid-cols-2 items-start border-t ${minWidthClass} ${gridClass}`
      }
    >
      {children}
    </tr>
  )
}

function TableFooterButton({
  disabled = false,
  onClick,
  children,
}: {
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
}) {
  return (
    <div className="border-t bg-muted/10 text-center">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="w-full rounded-none py-2 text-sm font-medium"
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </Button>
    </div>
  )
}

function SourceTableHeaderCell({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <th
      scope="col"
      className={`px-3 py-2 text-start font-medium text-muted-foreground ${className}`}
    >
      {children}
    </th>
  )
}

export function MappedRowsHeader({
  selectColumn = false,
}: {
  selectColumn?: boolean
}) {
  const { t } = useTranslation()
  const grid = selectColumn ? REVIEW_TABLE_GRID : MAPPED_TABLE_GRID
  const minWidth = selectColumn
    ? REVIEW_TABLE_MIN_WIDTH
    : MAPPED_TABLE_MIN_WIDTH
  return (
    <thead className="block w-full">
      <tr
        className={`sticky top-0 z-20 grid w-full min-w-0 grid-cols-2 bg-muted/95 shadow-sm ${minWidth} ${grid}`}
      >
        {selectColumn ? (
          <MappedTableHeaderCell>
            <span className="sr-only">
              {t('ExpenseImport.viewers.headerSelect')}
            </span>
          </MappedTableHeaderCell>
        ) : null}
        <MappedTableHeaderCell pinned>
          {t('ExpenseImport.viewers.headerSourceRow')}
        </MappedTableHeaderCell>
        <MappedTableHeaderCell>
          {t('ExpenseImport.viewers.headerDate')}
        </MappedTableHeaderCell>
        <MappedTableHeaderCell>
          {t('ExpenseImport.viewers.headerTitle')}
        </MappedTableHeaderCell>
        <MappedTableHeaderCell end>
          {t('ExpenseImport.viewers.headerAmount')}
        </MappedTableHeaderCell>
        <MappedTableHeaderCell>
          {t('ExpenseImport.viewers.headerCategory')}
        </MappedTableHeaderCell>
        <MappedTableHeaderCell>
          {t('ExpenseImport.viewers.headerStatus')}
        </MappedTableHeaderCell>
      </tr>
    </thead>
  )
}

function MappedRowCells({
  row,
  showIssues = true,
  concise = true,
}: {
  row: DelimitedPreviewRow
  showIssues?: boolean
  concise?: boolean
}) {
  const { t } = useTranslation()
  const issues = showIssues ? row.issues : []
  const status = mappedRowStatus(row, showIssues)
  return (
    <>
      <td className="col-span-2 px-3 pt-3 text-muted-foreground md:col-span-1 md:py-3">
        <MappedRowLabel>
          {t('ExpenseImport.viewers.headerSourceRow')}
        </MappedRowLabel>
        {row.rowNumber}
      </td>
      <td className="px-3 py-3 whitespace-nowrap">
        <MappedRowLabel>{t('ExpenseImport.viewers.headerDate')}</MappedRowLabel>
        {row.expenseDate || t('ExpenseImport.viewers.invalidDate')}
      </td>
      <td className="min-w-0 px-3 py-3 md:max-w-72">
        <MappedRowLabel>
          {t('ExpenseImport.viewers.headerTitle')}
        </MappedRowLabel>
        <span className="block truncate font-medium">
          {row.title || t('ExpenseImport.viewers.missingTitle')}
        </span>
        {concise ? (
          issues[0] ? (
            <span
              className={`mt-1 block text-xs ${issues[0].severity === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'}`}
            >
              {translateImportIssue(issues[0], t)}
              {issues.length > 1
                ? t('ExpenseImport.viewers.moreIssues', {
                    count: issues.length - 1,
                  })
                : ''}
            </span>
          ) : null
        ) : (
          <span className="mt-1 block space-y-1">
            {issues.map((issue, index) => (
              <span
                key={`${row.rowId}-${issue.field}-${issue.code}-${index}`}
                className={`block text-xs ${issue.severity === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'}`}
              >
                {translateImportIssue(issue, t)}
              </span>
            ))}
          </span>
        )}
      </td>
      <td className="px-3 py-3 text-end font-medium whitespace-nowrap">
        <MappedRowLabel className="font-normal">
          {t('ExpenseImport.viewers.headerAmount')}
        </MappedRowLabel>
        {formatMinorAmount(row.amount, row.currency)}
      </td>
      <MappedCategoryCell
        category={row.category}
        provenance={row.categoryProvenance}
      />
      <td className="col-span-2 px-3 pb-3 md:col-span-1 md:py-3">
        <MappedRowLabel>
          {t('ExpenseImport.viewers.headerStatus')}
        </MappedRowLabel>
        <MappedStatusBadge status={status} />
      </td>
    </>
  )
}

export function MappedPreview({
  rows,
  status,
  onViewSource,
  onViewAll,
}: {
  rows: DelimitedPreviewRow[]
  status?: MappingPreviewStatus
  onViewSource?: () => void
  onViewAll?: () => void
}) {
  const { t } = useTranslation()
  const effectiveStatus = status ?? (rows.length ? 'ready' : 'initializing')
  const compactRows = rows.slice(0, COMPACT_PREVIEW_ROWS)
  return (
    <Card className="min-w-0 overflow-hidden">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <CardTitle>{t('ExpenseImport.viewers.previewTitle')}</CardTitle>
          <CardDescription>
            {t('ExpenseImport.viewers.previewDescription')}
          </CardDescription>
          {effectiveStatus === 'updating' ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />{' '}
              {t('ExpenseImport.viewers.previewUpdating')}
            </p>
          ) : null}
        </div>
        {onViewSource ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={onViewSource}
          >
            {t('ExpenseImport.viewers.viewSourceFile')}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="min-w-0">
        {effectiveStatus === 'initializing' ? (
          <div className="flex min-h-48 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
            <span className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" />{' '}
              {t('ExpenseImport.viewers.previewInitializing')}
            </span>
          </div>
        ) : effectiveStatus === 'error' ? (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>
              {t('ExpenseImport.viewers.previewErrorTitle')}
            </AlertTitle>
            <AlertDescription>
              {t('ExpenseImport.viewers.previewErrorDescription')}
            </AlertDescription>
          </Alert>
        ) : (
          <div
            className="relative overflow-hidden rounded-md border"
            aria-busy={effectiveStatus === 'updating'}
          >
            <div className="overflow-x-auto">
              <table
                aria-label={t('ExpenseImport.viewers.previewTableLabel')}
                className={`block w-full min-w-0 text-left text-sm ${MAPPED_TABLE_MIN_WIDTH}`}
              >
                <caption className="sr-only">
                  {t('ExpenseImport.viewers.previewTableLabel')}
                </caption>
                <MappedRowsHeader />
                <tbody
                  className={`block w-full min-w-0 ${MAPPED_TABLE_MIN_WIDTH}`}
                >
                  {compactRows.map((row) => (
                    <MappedTableRow
                      key={row.rowId}
                      gridClass={MAPPED_TABLE_GRID}
                      minWidthClass={MAPPED_TABLE_MIN_WIDTH}
                    >
                      <MappedRowCells
                        row={row}
                        showIssues={effectiveStatus === 'ready'}
                      />
                    </MappedTableRow>
                  ))}
                </tbody>
              </table>
            </div>
            <TableFooterButton
              disabled={effectiveStatus !== 'ready'}
              onClick={onViewAll}
            >
              {t('ExpenseImport.viewers.viewAllMapped', {
                count: rows.length,
              })}
            </TableFooterButton>
            {effectiveStatus === 'updating' ? (
              <div className="pointer-events-none absolute inset-0 flex items-start justify-center bg-background/30 pt-3">
                <span
                  aria-live="polite"
                  className="rounded-full bg-background/95 px-3 py-1 text-xs text-muted-foreground shadow-sm"
                >
                  {t('ExpenseImport.viewers.previewUpdating')}
                </span>
              </div>
            ) : null}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// Per-element remeasure lens for preview rows: virtualized row height depends
// on wrapped issue/warning text, so any character-count change must remeasure
// — count sums alone miss same-count text rewrites (see ReviewExpensesList,
// which extends this lens with draft-level fields).
function previewRowRemeasureLens(row: DelimitedPreviewRow): string {
  const issueLens = row.issues
    .map(
      (issue) =>
        `${issue.code}:${issue.message?.length ?? 0}:${JSON.stringify(issue.params ?? {}).length}`,
    )
    .join(',')
  return `${row.rowId}:${row.issues.length}:${issueLens}:${row.warning?.length ?? 0}:${row.error?.length ?? 0}`
}

// oxlint-disable react/react-compiler -- TanStack Virtual exposes measurement refs through its virtualizer result.
export function MappedExpensesDialog({
  rows,
  open,
  status,
  filter,
  issueField,
  onOpenChange,
  onFilterChange,
}: {
  rows: DelimitedPreviewRow[]
  open: boolean
  status: MappingPreviewStatus
  filter: 'ALL' | 'ISSUES'
  issueField: MappingIssueField | null
  onOpenChange: (open: boolean) => void
  onFilterChange: (filter: 'ALL' | 'ISSUES', field?: MappingIssueField) => void
}) {
  const { t } = useTranslation()
  const showIssues = status === 'ready'
  const issueRows = rows.filter(
    (row) =>
      showIssues &&
      (issueField
        ? row.issues.some(({ field }) => field === issueField)
        : row.issues.length > 0),
  )
  const filteredRows = filter === 'ISSUES' ? issueRows : rows
  const issueCount = showIssues
    ? rows.filter((row) => row.issues.length > 0).length
    : 0
  const virtualRows = useVirtualizedRows({
    count: filteredRows.length,
    estimateSize: 56,
    enabled: open,
    remeasureKey: hashPreviewLens(
      filteredRows.map(previewRowRemeasureLens),
      `${filter}:${issueField ?? 'all'}:${status}`,
    ),
    getItemKey: (index) => filteredRows[index]!.rowId,
    scrollResetKey: `${filter}:${issueField ?? 'all'}`,
  })

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-[min(96vw,80rem)]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t('ExpenseImport.viewers.allMappedTitle')}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {t('ExpenseImport.viewers.allMappedDescription')}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="min-h-0 space-y-3 overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={filter === 'ALL' ? 'default' : 'outline'}
              aria-pressed={filter === 'ALL'}
              onClick={() => onFilterChange('ALL')}
            >
              {t('ExpenseImport.viewers.filterAllRows', { count: rows.length })}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={filter === 'ISSUES' ? 'default' : 'outline'}
              aria-pressed={filter === 'ISSUES'}
              onClick={() => onFilterChange('ISSUES')}
            >
              {t('ExpenseImport.viewers.filterIssues', { count: issueCount })}
            </Button>
            {issueField ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onFilterChange('ISSUES')}
              >
                {t('ExpenseImport.viewers.clearIssueFilter', {
                  field: t(issueFieldLabel(issueField)),
                })}
              </Button>
            ) : null}
          </div>
          {filter === 'ISSUES' && issueRows.length === 0 ? (
            <p className="rounded-md border border-dashed p-5 text-sm text-muted-foreground">
              {t('ExpenseImport.viewers.noIssueRows')}
            </p>
          ) : !filteredRows.length ? (
            <p className="rounded-md border border-dashed p-5 text-sm text-muted-foreground">
              {t('ExpenseImport.viewers.noMappedRows')}
            </p>
          ) : (
            <div
              ref={virtualRows.setScrollRef}
              className="h-[min(68dvh,42rem)] min-h-64 overflow-auto rounded-md border"
              aria-busy={status === 'updating'}
            >
              <table
                aria-label={t('ExpenseImport.viewers.allMappedTableLabel')}
                aria-rowcount={filteredRows.length + 1}
                className={`block w-full min-w-0 text-left text-sm ${MAPPED_TABLE_MIN_WIDTH}`}
              >
                <caption className="sr-only">
                  {t('ExpenseImport.viewers.allMappedTableLabel')}
                </caption>
                <MappedRowsHeader />
                <tbody
                  className={`relative block w-full min-w-0 ${MAPPED_TABLE_MIN_WIDTH}`}
                  style={{ height: virtualRows.totalSize }}
                >
                  {virtualRows.items.map((item) => {
                    const row = filteredRows[item.index]!
                    return (
                      <MappedTableRow
                        key={row.rowId}
                        virtualized
                        gridClass={MAPPED_TABLE_GRID}
                        minWidthClass={MAPPED_TABLE_MIN_WIDTH}
                        rowIndex={item.index}
                        measureRef={virtualRows.measureElement}
                        style={{
                          top: 0,
                          transform: `translateY(${item.start}px)`,
                        }}
                      >
                        <MappedRowCells
                          row={row}
                          showIssues={showIssues}
                          concise={false}
                        />
                      </MappedTableRow>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            {t('ExpenseImport.viewers.close')}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

export function SourceCategoryPreviewDialog({
  sourceName,
  titleMode,
  categoryName,
  rows,
  status,
  open,
  onOpenChange,
}: {
  sourceName: string
  titleMode: boolean
  categoryName: string | null
  rows: DelimitedPreviewRow[]
  status: MappingPreviewStatus
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation()
  const showIssues = status === 'ready'
  const virtualRows = useVirtualizedRows({
    count: rows.length,
    estimateSize: 56,
    enabled: open,
    remeasureKey: hashPreviewLens(
      rows.map(previewRowRemeasureLens),
      `${sourceName}:${titleMode}:${status}`,
    ),
    getItemKey: (index) => rows[index]!.rowId,
    scrollResetKey: `${sourceName}:${titleMode}`,
  })

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-[min(96vw,80rem)]">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t('ExpenseImport.viewers.expensesForSource', { sourceName })}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {t('ExpenseImport.viewers.expenseCount', { count: rows.length })}
            {titleMode
              ? t('ExpenseImport.viewers.titleModeSuffix')
              : categoryName
                ? t('ExpenseImport.viewers.selectedCategorySuffix', {
                    categoryName,
                  })
                : null}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="min-h-0 space-y-3 overflow-y-auto">
          {!rows.length ? (
            <p className="rounded-md border border-dashed p-5 text-sm text-muted-foreground">
              {t('ExpenseImport.viewers.noExpensesForSource')}
            </p>
          ) : (
            <div
              ref={virtualRows.setScrollRef}
              className="h-[min(68dvh,42rem)] min-h-64 overflow-auto rounded-md border"
              aria-busy={status === 'updating'}
            >
              <table
                aria-label={t('ExpenseImport.viewers.expensesForSource', {
                  sourceName,
                })}
                aria-rowcount={rows.length + 1}
                className={`block w-full min-w-0 text-left text-sm ${MAPPED_TABLE_MIN_WIDTH}`}
              >
                <caption className="sr-only">
                  {t('ExpenseImport.viewers.expensesForSource', { sourceName })}
                </caption>
                <MappedRowsHeader />
                <tbody
                  className={`relative block w-full min-w-0 ${MAPPED_TABLE_MIN_WIDTH}`}
                  style={{ height: virtualRows.totalSize }}
                >
                  {virtualRows.items.map((item) => {
                    const row = rows[item.index]!
                    return (
                      <MappedTableRow
                        key={row.rowId}
                        virtualized
                        gridClass={MAPPED_TABLE_GRID}
                        minWidthClass={MAPPED_TABLE_MIN_WIDTH}
                        rowIndex={item.index}
                        measureRef={virtualRows.measureElement}
                        style={{
                          top: 0,
                          transform: `translateY(${item.start}px)`,
                        }}
                      >
                        <MappedRowCells
                          row={row}
                          showIssues={showIssues}
                          concise={false}
                        />
                      </MappedTableRow>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            {t('ExpenseImport.viewers.close')}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

// oxlint-enable react/react-compiler
