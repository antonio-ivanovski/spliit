import { Pencil } from 'lucide-react'
import { useMemo } from 'react'
import { Trans, useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useVirtualizedRows } from '@/components/use-virtualized-rows'

import { translateImportIssue } from './csv-import-messages'
import {
  formatMinorAmount,
  hashPreviewLens,
  type DraftRow,
  type DuplicateMatch,
} from './csv-import-review-model'
import {
  MappedCategoryCell,
  MappedRowLabel,
  MappedRowsHeader,
  MappedStatusBadge,
  MappedTableRow,
  mappedRowStatus,
  REVIEW_TABLE_GRID,
  REVIEW_TABLE_MIN_WIDTH,
} from './csv-import-viewers'

const duplicateReasonKeys = {
  exact: {
    titled: {
      plain: 'ExpenseImport.reviewList.duplicateExact',
      date: 'ExpenseImport.reviewList.duplicateExactDate',
      amount: 'ExpenseImport.reviewList.duplicateExactAmount',
      dateAmount: 'ExpenseImport.reviewList.duplicateExactDateAmount',
    },
    untitled: {
      plain: 'ExpenseImport.reviewList.duplicateExactUntitled',
      date: 'ExpenseImport.reviewList.duplicateExactUntitledDate',
      amount: 'ExpenseImport.reviewList.duplicateExactUntitledAmount',
      dateAmount: 'ExpenseImport.reviewList.duplicateExactUntitledDateAmount',
    },
  },
  existing: {
    titled: {
      plain: 'ExpenseImport.reviewList.duplicateExisting',
      date: 'ExpenseImport.reviewList.duplicateExistingDate',
      amount: 'ExpenseImport.reviewList.duplicateExistingAmount',
      dateAmount: 'ExpenseImport.reviewList.duplicateExistingDateAmount',
    },
    untitled: {
      plain: 'ExpenseImport.reviewList.duplicateExistingUntitled',
      date: 'ExpenseImport.reviewList.duplicateExistingUntitledDate',
      amount: 'ExpenseImport.reviewList.duplicateExistingUntitledAmount',
      dateAmount:
        'ExpenseImport.reviewList.duplicateExistingUntitledDateAmount',
    },
  },
} as const

export function duplicateReason(match: DuplicateMatch) {
  if (match.kind === 'EXACT_IMPORT' || match.kind === 'EXISTING_EXPENSE') {
    const group =
      match.kind === 'EXACT_IMPORT'
        ? duplicateReasonKeys.exact
        : duplicateReasonKeys.existing
    const title = match.title
    const expenseDate = match.expenseDate ? match.expenseDate : null
    const amount =
      match.amount != null && match.currency
        ? formatMinorAmount(match.amount, match.currency)
        : null
    const variant =
      expenseDate && amount
        ? 'dateAmount'
        : expenseDate
          ? 'date'
          : amount
            ? 'amount'
            : 'plain'
    const key = (title != null ? group.titled : group.untitled)[variant]
    const values: { title?: string; expenseDate?: string; amount?: string } = {}
    if (title != null) values.title = title
    if (expenseDate != null) values.expenseDate = expenseDate
    if (amount != null) values.amount = amount
    return <Trans i18nKey={key} values={values} />
  }
  if (match.sourceRowId) {
    return (
      <Trans
        i18nKey="ExpenseImport.reviewList.duplicateRepeatedSource"
        values={{ sourceRowId: match.sourceRowId }}
      />
    )
  }
  return <Trans i18nKey="ExpenseImport.reviewList.duplicateRepeated" />
}

// oxlint-disable react/react-compiler -- TanStack Virtual exposes measurement refs through its virtualizer result.
export function ReviewExpensesList({
  rows,
  duplicateByRow,
  onSelectedChange,
  onEdit,
  scrollPosition,
  scrollResetKey,
}: {
  rows: DraftRow[]
  duplicateByRow: Map<string, DuplicateMatch[]>
  onSelectedChange: (row: DraftRow, selected: boolean) => void
  onEdit: (row: DraftRow, trigger?: HTMLElement | null) => void
  scrollPosition: { current: number }
  scrollResetKey?: unknown
}) {
  const { t } = useTranslation()
  const remeasureKey = useMemo(() => {
    const pieces = rows.map(({ mapped, expense }) => {
      const matches = duplicateByRow.get(mapped.rowId) ?? []
      // Per-element lengths (not buckets or sums): row height depends on
      // wrapped text, so any character-count change must remeasure.
      const issueLens = mapped.issues
        .map(
          (issue) =>
            `${issue.code}:${issue.message?.length ?? 0}:${JSON.stringify(issue.params ?? {}).length}`,
        )
        .join(',')
      const duplicateLens = matches
        .map(
          (match) =>
            `${match.title?.length ?? 0}:${match.expenseDate?.length ?? 0}:${match.kind}:${match.amount ?? ''}:${match.currency ?? ''}:${match.sourceRowId?.length ?? 0}`,
        )
        .join(',')
      return `${mapped.rowId}:${mapped.issues.length}:${issueLens}:${mapped.warning?.length ?? 0}:${mapped.error?.length ?? 0}:${matches.length}:${duplicateLens}:${expense.title?.length ?? 0}:${expense.amount}:${mapped.currency}:${mapped.expenseDate}`
    })
    return hashPreviewLens(pieces)
  }, [rows, duplicateByRow])
  const virtualRows = useVirtualizedRows({
    count: rows.length,
    estimateSize: 56,
    remeasureKey,
    getItemKey: (index) => rows[index]!.mapped.rowId,
    overscan: 10,
    resetScrollOnChange: false,
    scrollResetKey,
    initialScrollOffset: scrollPosition.current,
  })

  if (!rows.length) {
    return (
      <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
        {t('ExpenseImport.reviewList.emptyFilter')}
      </p>
    )
  }

  return (
    <div
      ref={virtualRows.setScrollRef}
      onScroll={(event) => {
        scrollPosition.current = event.currentTarget.scrollTop
      }}
      className="h-[min(70dvh,46rem)] min-h-80 overflow-auto rounded-md border"
    >
      <table
        aria-label={t('ExpenseImport.reviewList.tableLabel')}
        aria-rowcount={rows.length + 1}
        className={`block min-w-0 text-left text-sm ${REVIEW_TABLE_MIN_WIDTH}`}
      >
        <caption className="sr-only">
          {t('ExpenseImport.reviewList.tableLabel')}
        </caption>
        <MappedRowsHeader selectColumn />
        <tbody
          className={`relative block min-w-0 ${REVIEW_TABLE_MIN_WIDTH}`}
          style={{ height: virtualRows.totalSize }}
        >
          {virtualRows.items.map((item) => {
            const row = rows[item.index]!
            const matches = duplicateByRow.get(row.mapped.rowId) ?? []
            const status = row.mapped.error
              ? 'error'
              : matches.length
                ? 'duplicate'
                : mappedRowStatus(row.mapped)
            const statusId = `review-status-${row.mapped.rowId}`
            const issueIds = row.mapped.issues.map(
              (_, index) => `review-issue-${row.mapped.rowId}-${index}`,
            )
            const duplicateIds = matches.map(
              (_, index) => `review-duplicate-${row.mapped.rowId}-${index}`,
            )
            const describedBy =
              [
                ...(row.mapped.error || matches.length ? [statusId] : []),
                ...issueIds,
                ...duplicateIds,
              ].join(' ') || undefined
            return (
              <MappedTableRow
                key={row.mapped.rowId}
                virtualized
                gridClass={REVIEW_TABLE_GRID}
                minWidthClass={REVIEW_TABLE_MIN_WIDTH}
                rowIndex={item.index}
                measureRef={virtualRows.measureElement}
                style={{ top: 0, transform: `translateY(${item.start}px)` }}
              >
                <td className="flex items-start gap-1 px-3 pt-3 md:px-2 md:py-3">
                  <Checkbox
                    checked={row.selected}
                    disabled={Boolean(row.mapped.error)}
                    onCheckedChange={(checked) =>
                      onSelectedChange(row, Boolean(checked))
                    }
                    aria-label={t('ExpenseImport.reviewList.selectRowLabel', {
                      rowNumber: row.mapped.rowNumber,
                      title:
                        row.expense.title ||
                        t('ExpenseImport.reviewList.missingTitle'),
                      amount: formatMinorAmount(
                        row.expense.amount,
                        row.mapped.currency,
                      ),
                    })}
                    aria-describedby={describedBy}
                    className="mt-0.5 size-6 shrink-0"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="-my-1.5 size-8 shrink-0"
                    aria-label={t('ExpenseImport.reviewList.editRowLabel', {
                      rowNumber: row.mapped.rowNumber,
                    })}
                    onClick={(event) =>
                      onEdit(row, event.currentTarget as HTMLElement)
                    }
                  >
                    <Pencil className="size-4" />
                  </Button>
                </td>
                <td className="px-3 pt-3 text-muted-foreground md:py-3">
                  <MappedRowLabel>
                    {t('ExpenseImport.reviewList.mobileSourceRow')}
                  </MappedRowLabel>
                  {row.mapped.rowNumber}
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  <MappedRowLabel>
                    {t('ExpenseImport.reviewList.mobileDate')}
                  </MappedRowLabel>
                  {row.mapped.expenseDate ||
                    t('ExpenseImport.reviewList.invalidDate')}
                </td>
                <td className="min-w-0 px-3 py-3 md:max-w-72">
                  <MappedRowLabel>
                    {t('ExpenseImport.reviewList.mobileTitle')}
                  </MappedRowLabel>
                  <span className="block font-medium">
                    {row.expense.title ||
                      t('ExpenseImport.reviewList.missingTitle')}
                  </span>
                  {row.mapped.issues.map((issue, index) => (
                    <span
                      key={`${row.mapped.rowId}-${issue.field}-${issue.code}-${index}`}
                      id={issueIds[index]}
                      className={`mt-1 block text-xs ${issue.severity === 'error' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'}`}
                    >
                      {translateImportIssue(issue, t)}
                    </span>
                  ))}
                  {matches.map((match, index) => (
                    <span
                      key={match.key}
                      id={duplicateIds[index]}
                      className="mt-1 block text-xs text-amber-700 dark:text-amber-400"
                    >
                      {duplicateReason(match)}
                    </span>
                  ))}
                </td>
                <td className="px-3 py-3 text-end font-medium whitespace-nowrap">
                  <MappedRowLabel className="font-normal">
                    {t('ExpenseImport.reviewList.mobileAmount')}
                  </MappedRowLabel>
                  {formatMinorAmount(row.expense.amount, row.mapped.currency)}
                </td>
                <MappedCategoryCell
                  category={row.expense.category}
                  provenance={row.mapped.categoryProvenance}
                />
                <td className="col-span-2 px-3 pb-3 md:col-span-1 md:py-3">
                  <MappedRowLabel>
                    {t('ExpenseImport.reviewList.mobileStatus')}
                  </MappedRowLabel>
                  <MappedStatusBadge status={status} id={statusId} />
                </td>
              </MappedTableRow>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// oxlint-enable react/react-compiler
