import type { TFunction } from 'i18next'
import { AlertCircle, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { CurrencySelector } from '@/components/currency-selector'
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
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useCurrencies } from '@/lib/currency'
import {
  classifyDelimitedFieldMapping,
  classifyDelimitedMoneyMapping,
  compileDelimitedMapping,
  simplifyDelimitedFieldMapping,
  simplifyDelimitedMoneyMapping,
  validateDelimitedMapping,
  validateDelimitedMoneyMapping,
  type DelimitedColumn,
  type DelimitedExpenseMappingV1,
  type DelimitedFieldMapping,
  type DelimitedMoneyMapping,
  type DelimitedPreviewRow,
  type DelimitedTable,
  type DelimitedVisualMapping,
  type DelimitedVisualTransform,
  type ImportDetection,
} from '@spliit/domain/import'

import { translateImportDetection } from './csv-import-messages'
import {
  formatMinorAmount,
  preferredDateOrder,
  type MappingFieldKey,
  type MappingIssueField,
} from './csv-import-review-model'
import {
  fieldMeta,
  issueSummary,
  mappingVisualization,
  MappingVisualizationContent,
  previewFieldValue,
  previewSourceValues,
  type MappingVisualization,
} from './csv-import-viewers'
import { previewExpenseFile } from './csv-import-worker-client'

function normalizedHeader(value: string) {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
}

function findColumn(columns: DelimitedColumn[], patterns: RegExp[]) {
  for (const pattern of patterns) {
    const column = columns.find((column) =>
      pattern.test(normalizedHeader(column.sourceLabel)),
    )
    if (column) return column
  }
}

function dateFormatLabel(format: string, t: TFunction) {
  if (format === 'AUTO_MDY') return t('ExpenseImport.mapping.dateFormatMdy')
  if (format === 'AUTO_DMY') return t('ExpenseImport.mapping.dateFormatDmy')
  return format
}

function mappingModeLabel(mode: 'SIMPLE' | 'ADVANCED' | 'CODE', t: TFunction) {
  if (mode === 'CODE') return t('ExpenseImport.mapping.modeCode')
  if (mode === 'ADVANCED') return t('ExpenseImport.mapping.modeAdvanced')
  return t('ExpenseImport.mapping.modeSimple')
}

type VisualMoneyMapping = Extract<DelimitedMoneyMapping, { mode: 'VISUAL' }>
type MoneyCurrencySource = 'FIXED' | 'AMOUNT_SOURCE' | 'SEPARATE_SOURCE'
type MoneySignHandling = 'AS_WRITTEN' | 'FROM_COLUMN'

function mappingColumnLabel(table: DelimitedTable, key: string) {
  return table.columns.find((column) => column.key === key)?.label ?? key
}

function moneySourceSummary(
  mapping: DelimitedVisualMapping,
  table: DelimitedTable,
) {
  return mapping.sourceValues
    .map((source) =>
      [source.primary, ...source.fallbacks]
        .map((key) => mappingColumnLabel(table, key))
        .join(' → '),
    )
    .join(' + ')
}

function moneyCurrencySource(mapping: VisualMoneyMapping): MoneyCurrencySource {
  if (!mapping.currency) return 'FIXED'
  const amountSource = mapping.amount.sourceValues[0]
  const currencySource = mapping.currency.sourceValues[0]
  return amountSource &&
    currencySource &&
    mapping.amount.sourceValues.length === 1 &&
    mapping.currency.sourceValues.length === 1 &&
    amountSource.primary === currencySource.primary &&
    amountSource.fallbacks.length === 0 &&
    currencySource.fallbacks.length === 0
    ? 'AMOUNT_SOURCE'
    : 'SEPARATE_SOURCE'
}

function numberFormatSummary(format: 'AUTO' | 'DOT' | 'COMMA', t: TFunction) {
  if (format === 'DOT') return t('ExpenseImport.mapping.numberFormatDot')
  if (format === 'COMMA') return t('ExpenseImport.mapping.numberFormatComma')
  return t('ExpenseImport.mapping.numberFormatAuto')
}

function moneySummaryLines(
  mapping: VisualMoneyMapping,
  table: DelimitedTable,
  defaultCurrencyCode: string,
  t: TFunction,
) {
  const numberTransform = mapping.amount.transforms.find(
    (
      transform,
    ): transform is Extract<
      DelimitedVisualTransform,
      { kind: 'PARSE_NUMBER' }
    > => transform.kind === 'PARSE_NUMBER',
  )
  const debitCreditTransform = mapping.amount.transforms.find(
    (
      transform,
    ): transform is Extract<
      DelimitedVisualTransform,
      { kind: 'DEBIT_CREDIT' }
    > => transform.kind === 'DEBIT_CREDIT',
  )
  const signTransform = mapping.amount.transforms.find(
    (
      transform,
    ): transform is Extract<
      DelimitedVisualTransform,
      { kind: 'SIGN_FROM_COLUMN' }
    > => transform.kind === 'SIGN_FROM_COLUMN',
  )
  const amountDetails = [
    debitCreditTransform
      ? t('ExpenseImport.mapping.moneyDebitCredit', {
          credit: mappingColumnLabel(table, debitCreditTransform.creditColumn),
          debit: mappingColumnLabel(table, debitCreditTransform.debitColumn),
        })
      : moneySourceSummary(mapping.amount, table),
  ]
  if (numberTransform) {
    amountDetails.push(
      t('ExpenseImport.mapping.moneyNumberFormat', {
        format: numberFormatSummary(numberTransform.format, t),
      }),
    )
  } else if (debitCreditTransform) {
    amountDetails.push(
      t('ExpenseImport.mapping.moneyNumberFormat', {
        format: numberFormatSummary(debitCreditTransform.format, t),
      }),
    )
  }
  amountDetails.push(
    signTransform
      ? t('ExpenseImport.mapping.moneySign', {
          column: mappingColumnLabel(table, signTransform.columnKey),
        })
      : t('ExpenseImport.mapping.moneySignAsWritten'),
  )

  const currencyMode = moneyCurrencySource(mapping)
  const currencySummary =
    currencyMode === 'FIXED'
      ? defaultCurrencyCode
      : currencyMode === 'AMOUNT_SOURCE'
        ? t('ExpenseImport.mapping.moneyExtractedFrom', {
            column: mappingColumnLabel(
              table,
              mapping.amount.sourceValues[0]?.primary ?? '',
            ),
          })
        : moneySourceSummary(mapping.currency!, table)

  return [
    t('ExpenseImport.mapping.moneyAmountLine', {
      details: amountDetails.join(' · '),
    }),
    t('ExpenseImport.mapping.moneyCurrencyLine', {
      summary: currencySummary,
    }),
  ]
}

function simpleCurrencyMapping(sourceKey: string): DelimitedVisualMapping {
  return {
    mode: 'VISUAL',
    sourceValues: [{ primary: sourceKey, fallbacks: [] }],
    transforms: [{ kind: 'TRIM' }, { kind: 'EXTRACT_CURRENCY' }],
  }
}

export function DetectionFeedback({
  entries,
  onConfirm,
}: {
  entries: ImportDetection[]
  onConfirm: () => void
}) {
  const { t } = useTranslation()
  if (!entries.length) return null
  return (
    <div className="space-y-2 text-sm text-muted-foreground">
      {entries.map((entry, index) => (
        <div key={index}>
          <p>{translateImportDetection(entry, t)}</p>
          {entry.requiresConfirmation && entry.candidates.length > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="link"
              className="h-auto px-0"
              onClick={onConfirm}
            >
              {t('ExpenseImport.mapping.useDetectedColumn')}
            </Button>
          ) : null}
        </div>
      ))}
    </div>
  )
}

export function MappingCard({
  field,
  table,
  mapping,
  previewRows,
  onShowIssues,
  dateConfirmationPending,
  onConfirmDate,
  isUpdating,
  required,
  onEdit,
  onRemove,
  detectionFeedback,
}: {
  field: MappingFieldKey
  table: DelimitedTable
  mapping: DelimitedFieldMapping | undefined
  previewRows?: DelimitedPreviewRow[]
  onShowIssues?: (field: MappingIssueField) => void
  dateConfirmationPending?: boolean
  onConfirmDate?: () => void
  isUpdating?: boolean
  required?: boolean
  onEdit: () => void
  onRemove?: () => void
  detectionFeedback?: ReactNode
}) {
  const { t } = useTranslation()
  const meta = fieldMeta[field]
  const [visibleExamples, setVisibleExamples] = useState(10)
  const examples =
    mapping && previewRows?.length
      ? previewRows.slice(0, visibleExamples).map((row, index) => ({
          rowNumber: row.rowNumber,
          expenseNumber: index + 1,
          source: previewSourceValues(table, row.rowNumber, mapping, t),
          result: previewFieldValue(row, field, t),
        }))
      : []
  const issues =
    previewRows?.flatMap((row) =>
      row.issues
        .filter(({ field: issueField }) => issueField === field)
        .map((entry) => ({ ...entry, rowNumber: row.rowNumber })),
    ) ?? []
  const errorCount = issues.filter(
    ({ severity }) => severity === 'error',
  ).length
  const ambiguousIssues = issues.filter(({ code }) => code === 'AMBIGUOUS_DATE')
  const inconsistentIssues = issues.filter(
    ({ code }) => code === 'INCONSISTENT_DATE_ORDER',
  )
  const suggestedDayFirst =
    field === 'dateTime' &&
    mapping?.mode === 'VISUAL' &&
    mapping.transforms.some(
      (transform) =>
        transform.kind === 'PARSE_DATE' &&
        (transform.format === 'AUTO_DMY' || transform.format.startsWith('D/')),
    )
  const visualization = mappingVisualization(field, mapping, table, t)
  const suggestedOrder = suggestedDayFirst
    ? t('ExpenseImport.mapping.dayMonth')
    : t('ExpenseImport.mapping.monthDay')
  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">{t(meta.title)}</CardTitle>
            {required ? (
              <Badge variant="outline">
                {t('ExpenseImport.mapping.requiredBadge')}
              </Badge>
            ) : null}
          </div>
          <CardDescription className="max-w-2xl">
            {t(meta.description)}
          </CardDescription>
        </div>
        <div className="flex shrink-0 gap-2">
          {mapping && onRemove ? (
            <Button type="button" variant="ghost" size="sm" onClick={onRemove}>
              {t('ExpenseImport.mapping.removeButton')}
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>
            {mapping
              ? t('ExpenseImport.mapping.editMappingButton')
              : t('ExpenseImport.mapping.addMappingButton')}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {!isUpdating ? detectionFeedback : null}
        <div className="border-b pb-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t('ExpenseImport.mapping.mappingSectionLabel')}
            </span>
            {visualization.mode ? (
              <Badge variant="outline">
                {mappingModeLabel(visualization.mode, t)}
              </Badge>
            ) : null}
          </div>
          <MappingVisualizationContent visualization={visualization} />
        </div>
        {isUpdating ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />{' '}
            {t('ExpenseImport.mapping.updatingExamples')}
          </p>
        ) : examples.length ? (
          <div className="flex max-w-full gap-2 overflow-x-auto pb-1">
            {examples.map((example) => (
              <div
                key={`${example.rowNumber}-${field}`}
                className="min-w-64 shrink-0 rounded-md border bg-muted/30 px-3 py-2 text-sm"
              >
                <span className="block text-xs text-muted-foreground">
                  {t('ExpenseImport.mapping.sourceRowExpense', {
                    expenseNumber: example.expenseNumber,
                    rowNumber: example.rowNumber,
                  })}
                </span>
                <div className="mt-2 space-y-1 text-xs">
                  <span className="block font-medium text-muted-foreground">
                    {t('ExpenseImport.mapping.rawValueLabel')}
                  </span>
                  {example.source.length ? (
                    example.source.map(({ label, sourceKind, value }) => (
                      <span
                        key={`${sourceKind}-${label}`}
                        className="block truncate"
                        title={value}
                      >
                        <span className="text-muted-foreground">
                          {sourceKind} ·{' '}
                        </span>
                        <span className="font-medium">{label}</span>: {value}
                      </span>
                    ))
                  ) : (
                    <span className="block text-muted-foreground">
                      {t('ExpenseImport.mapping.blankValue')}
                    </span>
                  )}
                </div>
                <div className="mt-2 text-sm font-medium">
                  <span className="block text-xs font-normal text-muted-foreground">
                    {t('ExpenseImport.mapping.mappedValueLabel')}
                  </span>
                  <span className="block truncate" title={example.result}>
                    {example.result}
                  </span>
                </div>
              </div>
            ))}
            {previewRows && visibleExamples < previewRows.length ? (
              <Button
                type="button"
                variant="ghost"
                className="min-w-40 shrink-0"
                onClick={() =>
                  setVisibleExamples((count) =>
                    Math.min(count + 10, previewRows.length),
                  )
                }
              >
                {t('ExpenseImport.mapping.loadMoreExamples')}
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('ExpenseImport.mapping.defaultFieldHint')}
          </p>
        )}
        {inconsistentIssues.length ? (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>{t('ExpenseImport.mapping.mixedDateTitle')}</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>{t('ExpenseImport.mapping.mixedDateBody')}</p>
              <p>
                {t('ExpenseImport.mapping.affectedRows', {
                  rows: inconsistentIssues
                    .slice(0, 8)
                    .map(({ rowNumber }) => rowNumber)
                    .join(', '),
                })}
                {inconsistentIssues.length > 8
                  ? t('ExpenseImport.mapping.andMore')
                  : ''}
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={() => onShowIssues?.(field)}
              >
                {t('ExpenseImport.mapping.showAffectedRows')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : ambiguousIssues.length && dateConfirmationPending ? (
          <Alert>
            <AlertCircle className="size-4" />
            <AlertTitle>
              {t('ExpenseImport.mapping.confirmDateTitle')}
            </AlertTitle>
            <AlertDescription>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="warning">
                  {issueSummary(ambiguousIssues, t)}
                </Badge>
              </div>
              <p className="mt-1 text-xs">
                {t('ExpenseImport.mapping.ambiguousDateBody', {
                  order: suggestedOrder,
                })}
              </p>
              <div className="mt-2 space-y-1 text-xs">
                {previewRows
                  ?.filter((row) =>
                    row.issues.some(({ code }) => code === 'AMBIGUOUS_DATE'),
                  )
                  .slice(0, 3)
                  .map((row) => (
                    <p key={row.rowId}>
                      {t('ExpenseImport.mapping.ambiguousRowExample', {
                        rowNumber: row.rowNumber,
                        values: previewSourceValues(
                          table,
                          row.rowNumber,
                          mapping,
                          t,
                        )
                          .map(({ value }) => value)
                          .join(' · '),
                      })}
                    </p>
                  ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={onConfirmDate}
                >
                  {t('ExpenseImport.mapping.confirmOrder', {
                    order: suggestedOrder,
                  })}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => onShowIssues?.(field)}
                >
                  {t('ExpenseImport.mapping.showAffectedRows')}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : issues.length ? (
          <Alert variant={errorCount ? 'destructive' : 'default'}>
            <AlertCircle className="size-4" />
            <AlertTitle>
              {t('ExpenseImport.mapping.issuesInField', {
                summary: issueSummary(issues, t),
                title: t(meta.title),
              })}
            </AlertTitle>
            <AlertDescription>
              {t('ExpenseImport.mapping.rowsList', {
                rows: issues
                  .slice(0, 5)
                  .map(({ rowNumber }) => rowNumber)
                  .join(', '),
              })}
              {issues.length > 5 ? t('ExpenseImport.mapping.andMore') : ''}.
              <Button
                type="button"
                variant="link"
                size="sm"
                className="ms-1 h-auto p-0"
                onClick={() => onShowIssues?.(field)}
              >
                {t('ExpenseImport.mapping.inspectRows')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {errorCount === 0 && issues.length === 0 && previewRows?.length ? (
          <p className="text-xs text-muted-foreground">
            {t('ExpenseImport.mapping.allRowsMapped')}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function MoneyMappingCard({
  table,
  previewRows,
  onShowIssues,
  mapping,
  defaultCurrencyCode,
  onEdit,
  isUpdating,
  detectionFeedback,
}: {
  table: DelimitedTable
  previewRows?: DelimitedPreviewRow[]
  onShowIssues?: (field: MappingIssueField) => void
  mapping: DelimitedMoneyMapping
  defaultCurrencyCode: string
  onEdit: () => void
  isUpdating?: boolean
  detectionFeedback?: ReactNode
}) {
  const { t } = useTranslation()
  const visual = mapping.mode === 'VISUAL' ? mapping : null
  const [visibleExamples, setVisibleExamples] = useState(10)
  const amountMapping = visual?.amount
  const currencyMapping = visual?.currency
  const amountSourceLane = t('ExpenseImport.mapping.moneyAmountSource')
  const currencySourceLane = t('ExpenseImport.mapping.moneyCurrencySource')
  const moneyTitle = t('ExpenseImport.mapping.moneyTitle')
  const issues =
    previewRows?.flatMap((row) =>
      row.issues.filter(
        ({ field }) => field === 'amount' || field === 'currency',
      ),
    ) ?? []
  const moneyMode = classifyDelimitedMoneyMapping(mapping)
  const visualization: MappingVisualization =
    mapping.mode === 'CEL'
      ? { mode: 'CODE', lines: [], code: mapping.expression }
      : {
          mode: moneyMode,
          lines: moneySummaryLines(mapping, table, defaultCurrencyCode, t),
          code: null,
        }
  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <CardTitle className="text-base">{moneyTitle}</CardTitle>
            <Badge variant="outline">
              {t('ExpenseImport.mapping.requiredBadge')}
            </Badge>
          </div>
          <CardDescription className="max-w-2xl">
            {t('ExpenseImport.mapping.moneyDescription')}
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onEdit}
        >
          {t('ExpenseImport.mapping.editMappingButton')}
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {!isUpdating ? detectionFeedback : null}
        <div className="border-b pb-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t('ExpenseImport.mapping.mappingSectionLabel')}
            </span>
            <Badge variant="outline">{mappingModeLabel(moneyMode, t)}</Badge>
          </div>
          <MappingVisualizationContent visualization={visualization} />
        </div>
        {isUpdating ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />{' '}
            {t('ExpenseImport.mapping.updatingExamples')}
          </p>
        ) : previewRows?.length ? (
          <div className="flex max-w-full gap-2 overflow-x-auto pb-1">
            {previewRows.slice(0, visibleExamples).map((row, index) => {
              const sourceEntries = [
                ...(amountMapping
                  ? previewSourceValues(
                      table,
                      row.rowNumber,
                      amountMapping,
                      t,
                    ).map((source) => ({ ...source, lane: amountSourceLane }))
                  : []),
                ...(currencyMapping
                  ? previewSourceValues(
                      table,
                      row.rowNumber,
                      currencyMapping,
                      t,
                    ).map((source) => ({
                      ...source,
                      lane: currencySourceLane,
                    }))
                  : []),
              ]
              return (
                <div
                  key={row.rowId}
                  className="min-w-64 shrink-0 rounded-md border bg-muted/30 px-3 py-2 text-sm"
                >
                  <span className="block text-xs text-muted-foreground">
                    {t('ExpenseImport.mapping.sourceRowExpense', {
                      expenseNumber: index + 1,
                      rowNumber: row.rowNumber,
                    })}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {t('ExpenseImport.mapping.rawValueLabel')}
                  </span>
                  <div className="space-y-1 text-xs">
                    {sourceEntries.length ? (
                      sourceEntries.map(
                        (
                          { lane, label, sourceKind, value, isFallback },
                          sourceIndex,
                        ) => (
                          <span
                            key={`${lane}-${sourceKind}-${label}-${sourceIndex}`}
                            className="block truncate"
                            title={value}
                          >
                            <span className="text-muted-foreground">
                              {isFallback
                                ? t('ExpenseImport.mapping.moneyLaneFallback', {
                                    lane,
                                  })
                                : lane}{' '}
                              ·{' '}
                            </span>
                            <span className="font-medium">{label}</span>:{' '}
                            {value}
                          </span>
                        ),
                      )
                    ) : mapping.mode === 'CEL' ? (
                      <span className="block text-muted-foreground">
                        {t('ExpenseImport.mapping.definedByCode')}
                      </span>
                    ) : (
                      <span className="block text-muted-foreground">
                        {t('ExpenseImport.mapping.blankValue')}
                      </span>
                    )}
                  </div>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {t('ExpenseImport.mapping.mappedValueLabel')}
                  </span>
                  <span className="block font-medium">
                    {formatMinorAmount(row.amount, row.currency)}
                  </span>
                </div>
              )
            })}
            {visibleExamples < previewRows.length ? (
              <Button
                type="button"
                variant="ghost"
                className="min-w-40 shrink-0"
                onClick={() =>
                  setVisibleExamples((count) =>
                    Math.min(count + 10, previewRows.length),
                  )
                }
              >
                {t('ExpenseImport.mapping.loadMoreExamples')}
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t('ExpenseImport.mapping.noPreviewRows')}
          </p>
        )}
        {issues.length ? (
          <Alert
            variant={
              issues.some(({ severity }) => severity === 'error')
                ? 'destructive'
                : 'default'
            }
          >
            <AlertCircle className="size-4" />
            <AlertTitle>
              {t('ExpenseImport.mapping.issuesInField', {
                summary: issueSummary(issues, t),
                title: moneyTitle,
              })}
            </AlertTitle>
            <AlertDescription>
              {t('ExpenseImport.mapping.rowsList', {
                rows: issues
                  .slice(0, 5)
                  .map(({ rowNumber }) => rowNumber)
                  .join(', '),
              })}
              {issues.length > 5 ? t('ExpenseImport.mapping.andMore') : ''}.
              <Button
                type="button"
                variant="link"
                size="sm"
                className="ms-1 h-auto p-0"
                onClick={() =>
                  onShowIssues?.(
                    issues[0]?.field === 'currency' ? 'currency' : 'amount',
                  )
                }
              >
                {t('ExpenseImport.mapping.inspectRows')}
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  )
}

function transformLabel(
  transform: DelimitedVisualTransform,
  t: TFunction,
): string {
  switch (transform.kind) {
    case 'JOIN':
      return t('ExpenseImport.mapping.transformJoinValues', {
        separator:
          transform.separator || t('ExpenseImport.mapping.transformJoinSpace'),
      })
    case 'TRIM':
      return t('ExpenseImport.mapping.transformTrim')
    case 'UPPER':
      return t('ExpenseImport.mapping.transformUpper')
    case 'LOWER':
      return t('ExpenseImport.mapping.transformLower')
    case 'REPLACE':
      return t('ExpenseImport.mapping.transformReplace', {
        search: transform.search || '…',
      })
    case 'REGEX_EXTRACT':
      return t('ExpenseImport.mapping.transformRegex')
    case 'PARSE_DATE':
      return t('ExpenseImport.mapping.transformParseDate', {
        format: dateFormatLabel(transform.format, t),
      })
    case 'PARSE_NUMBER':
      return t('ExpenseImport.mapping.transformParseNumber', {
        format: transform.format,
      })
    case 'EXTRACT_CURRENCY':
      return t('ExpenseImport.mapping.transformExtractCurrency')
    case 'SIGN_FROM_COLUMN':
      return t('ExpenseImport.mapping.transformSignFromColumn')
    case 'DEBIT_CREDIT':
      return t('ExpenseImport.mapping.transformDebitCredit')
  }
}

function newTransform(
  kind: DelimitedVisualTransform['kind'],
  table: DelimitedTable,
): DelimitedVisualTransform {
  switch (kind) {
    case 'JOIN':
      return { kind, separator: ' ' }
    case 'TRIM':
    case 'UPPER':
    case 'LOWER':
      return { kind }
    case 'REPLACE':
      return { kind, search: '', replacement: '' }
    case 'REGEX_EXTRACT':
      return { kind, pattern: '', group: 0 }
    case 'PARSE_DATE':
      return { kind, format: 'M/D/YYYY H:mm' }
    case 'PARSE_NUMBER':
      return { kind, format: 'AUTO' }
    case 'EXTRACT_CURRENCY':
      return { kind }
    case 'SIGN_FROM_COLUMN':
      return {
        kind,
        columnKey: table.columns[0]?.key ?? '',
        negativeValues: ['income', 'credit', 'deposit'],
      }
    case 'DEBIT_CREDIT':
      return {
        kind,
        debitColumn: table.columns[0]?.key ?? '',
        creditColumn: table.columns[1]?.key ?? '',
        format: 'AUTO',
      }
  }
}

type PipelineFieldKind = 'date' | 'amount' | 'text' | 'currency'
type MappingEditorMode = 'simple' | 'advanced' | 'code'

function normalizeVisualSourceValues(
  mapping: DelimitedVisualMapping,
  sourceValues: DelimitedVisualMapping['sourceValues'],
): DelimitedVisualMapping {
  const existingJoin = mapping.transforms.find(
    (transform) => transform.kind === 'JOIN',
  )
  const scalarTransforms = mapping.transforms.filter(
    (transform) => transform.kind !== 'JOIN',
  )
  const transforms =
    sourceValues.length > 1
      ? [
          {
            kind: 'JOIN' as const,
            separator:
              existingJoin?.kind === 'JOIN' ? existingJoin.separator : ' ',
          },
          ...scalarTransforms,
        ]
      : scalarTransforms
  return { ...mapping, sourceValues, transforms }
}

function SourceValuesEditor({
  table,
  mapping,
  simple,
  onChange,
  onOpenAdvanced,
}: {
  table: DelimitedTable
  mapping: DelimitedVisualMapping
  simple: boolean
  onChange: (mapping: DelimitedVisualMapping) => void
  onOpenAdvanced?: () => void
}) {
  const { t } = useTranslation()
  const updateSourceValues = (
    sourceValues: DelimitedVisualMapping['sourceValues'],
  ) => onChange(normalizeVisualSourceValues(mapping, sourceValues))
  const sourceValues = simple
    ? mapping.sourceValues.slice(0, 1)
    : mapping.sourceValues
  const updateSource = (
    sourceIndex: number,
    source: DelimitedVisualMapping['sourceValues'][number],
  ) => {
    const next = [...mapping.sourceValues]
    next[sourceIndex] = source
    updateSourceValues(next)
  }
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label>
            {simple
              ? t('ExpenseImport.mapping.sourceLabelSimple')
              : t('ExpenseImport.mapping.sourceLabelAdvanced')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {simple
              ? t('ExpenseImport.mapping.sourceHintSimple')
              : t('ExpenseImport.mapping.sourceHintAdvanced')}
          </p>
        </div>
        {!simple ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={mapping.sourceValues.length >= 12}
            onClick={() =>
              updateSourceValues([
                ...mapping.sourceValues,
                { primary: table.columns[0]!.key, fallbacks: [] },
              ])
            }
          >
            {t('ExpenseImport.mapping.addSourceValue')}
          </Button>
        ) : null}
      </div>
      {simple && mapping.sourceValues.length > 1 ? (
        <Alert>
          <AlertCircle className="size-4" />
          <AlertTitle>{t('ExpenseImport.mapping.combinesTitle')}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            {t('ExpenseImport.mapping.combinesBody')}
            {onOpenAdvanced ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onOpenAdvanced}
              >
                {t('ExpenseImport.mapping.openAdvanced')}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => updateSourceValues([mapping.sourceValues[0]!])}
            >
              {t('ExpenseImport.mapping.resetOneSource')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-3">
        {sourceValues.map((source, sourceIndex) => {
          const sourceLabel =
            mapping.sourceValues.length === 1
              ? t('ExpenseImport.mapping.sourceSingle')
              : t('ExpenseImport.mapping.sourceValueNumbered', {
                  index: sourceIndex + 1,
                })
          return (
            <div
              key={sourceIndex}
              className="space-y-2 border-b pb-3 last:border-b-0"
            >
              <div className="flex items-center justify-between gap-2 text-sm font-medium">
                <span>{sourceLabel}</span>
                {!simple ? (
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={t('ExpenseImport.mapping.moveSourceUp', {
                        label: sourceLabel,
                      })}
                      disabled={sourceIndex === 0}
                      onClick={() => {
                        const next = [...mapping.sourceValues]
                        ;[next[sourceIndex - 1], next[sourceIndex]] = [
                          next[sourceIndex]!,
                          next[sourceIndex - 1]!,
                        ]
                        updateSourceValues(next)
                      }}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={t('ExpenseImport.mapping.moveSourceDown', {
                        label: sourceLabel,
                      })}
                      disabled={sourceIndex === mapping.sourceValues.length - 1}
                      onClick={() => {
                        const next = [...mapping.sourceValues]
                        ;[next[sourceIndex], next[sourceIndex + 1]] = [
                          next[sourceIndex + 1]!,
                          next[sourceIndex]!,
                        ]
                        updateSourceValues(next)
                      }}
                    >
                      ↓
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={t('ExpenseImport.mapping.removeSource', {
                        label: sourceLabel,
                      })}
                      disabled={mapping.sourceValues.length === 1}
                      onClick={() =>
                        updateSourceValues(
                          mapping.sourceValues.filter(
                            (_, index) => index !== sourceIndex,
                          ),
                        )
                      }
                    >
                      ×
                    </Button>
                  </div>
                ) : null}
              </div>
              <SourceColumnList
                table={table}
                source={source}
                sourceLabel={sourceLabel}
                simple={simple}
                onChange={(next) => updateSource(sourceIndex, next)}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SourceColumnList({
  table,
  source,
  sourceLabel,
  simple,
  onChange,
}: {
  table: DelimitedTable
  source: DelimitedVisualMapping['sourceValues'][number]
  sourceLabel: string
  simple: boolean
  onChange: (source: DelimitedVisualMapping['sourceValues'][number]) => void
}) {
  const { t } = useTranslation()
  const columns = simple
    ? [source.primary]
    : [source.primary, ...source.fallbacks]
  const setColumn = (index: number, key: string) => {
    const next = [...columns]
    next[index] = key
    onChange({ primary: next[0]!, fallbacks: next.slice(1) })
  }
  return (
    <div className="space-y-2">
      {columns.map((key, columnIndex) => (
        <div key={`${key}-${columnIndex}`} className="flex items-center gap-2">
          <span className="w-20 shrink-0 text-xs text-muted-foreground">
            {columnIndex === 0
              ? t('ExpenseImport.mapping.columnSource')
              : t('ExpenseImport.mapping.columnFallback')}
          </span>
          <Select
            value={key}
            onValueChange={(value) => value && setColumn(columnIndex, value)}
          >
            <SelectTrigger
              aria-label={
                columnIndex === 0
                  ? t('ExpenseImport.mapping.sourceColumnSourceAria', {
                      sourceLabel,
                    })
                  : t('ExpenseImport.mapping.sourceColumnFallbackAria', {
                      index: columnIndex,
                      sourceLabel,
                    })
              }
              className="h-9 min-w-0 flex-1"
            >
              <SelectValue>{mappingColumnLabel(table, key)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {table.columns.map((column) => (
                <SelectItem key={column.key} value={column.key}>
                  {column.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!simple && columnIndex > 0 ? (
            <div className="flex shrink-0 gap-1">
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t('ExpenseImport.mapping.moveFallbackUp', {
                  index: columnIndex,
                  sourceLabel,
                })}
                disabled={columnIndex === 1}
                onClick={() => {
                  const next = [...columns]
                  ;[next[columnIndex - 1], next[columnIndex]] = [
                    next[columnIndex]!,
                    next[columnIndex - 1]!,
                  ]
                  onChange({ primary: next[0]!, fallbacks: next.slice(1) })
                }}
              >
                ↑
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t('ExpenseImport.mapping.moveFallbackDown', {
                  index: columnIndex,
                  sourceLabel,
                })}
                disabled={columnIndex === columns.length - 1}
                onClick={() => {
                  const next = [...columns]
                  ;[next[columnIndex], next[columnIndex + 1]] = [
                    next[columnIndex + 1]!,
                    next[columnIndex]!,
                  ]
                  onChange({ primary: next[0]!, fallbacks: next.slice(1) })
                }}
              >
                ↓
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={t('ExpenseImport.mapping.removeFallback', {
                  index: columnIndex,
                  sourceLabel,
                })}
                onClick={() =>
                  onChange({
                    primary: nextPrimary(columns, columnIndex),
                    fallbacks: columns.filter(
                      (_, index) => index !== columnIndex && index !== 0,
                    ),
                  })
                }
              >
                ×
              </Button>
            </div>
          ) : null}
        </div>
      ))}
      {!simple ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={columns.length >= 12}
          onClick={() =>
            onChange({
              ...source,
              fallbacks: [...source.fallbacks, table.columns[0]!.key],
            })
          }
        >
          {t('ExpenseImport.mapping.addFallbackColumn')}
        </Button>
      ) : null}
    </div>
  )
}

function nextPrimary(columns: string[], removedIndex: number) {
  return columns.find((_, index) => index !== removedIndex) ?? columns[0]!
}

function TransformList({
  table,
  mapping,
  fieldKind,
  onChange,
}: {
  table: DelimitedTable
  mapping: DelimitedVisualMapping
  fieldKind: PipelineFieldKind
  onChange: (mapping: DelimitedVisualMapping) => void
}) {
  const { t } = useTranslation()
  const updateTransform = (
    index: number,
    transform: DelimitedVisualTransform,
  ) =>
    onChange({
      ...mapping,
      transforms: mapping.transforms.map((item, itemIndex) =>
        itemIndex === index ? transform : item,
      ),
    })
  const moveTransform = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= mapping.transforms.length) return
    const next = [...mapping.transforms]
    ;[next[index], next[target]] = [next[target]!, next[index]!]
    if (next.some((item) => item.kind === 'JOIN') && next[0]?.kind !== 'JOIN')
      return
    onChange({ ...mapping, transforms: next })
  }
  const addTransform = (kind: DelimitedVisualTransform['kind']) => {
    if (
      kind === 'JOIN' &&
      mapping.transforms.some(({ kind }) => kind === 'JOIN')
    ) {
      return
    }
    const transform = newTransform(kind, table)
    const transforms = [...mapping.transforms]
    if (kind === 'JOIN') transforms.unshift(transform)
    else transforms.push(transform)
    onChange({ ...mapping, transforms })
  }
  const transformKeys = useMemo(() => {
    const occurrences = new Map<string, number>()
    return mapping.transforms.map((transform) => {
      const identity = JSON.stringify(transform)
      const occurrence = occurrences.get(identity) ?? 0
      occurrences.set(identity, occurrence + 1)
      return `${identity}-${occurrence}`
    })
  }, [mapping.transforms])
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <Label>{t('ExpenseImport.mapping.transformationsLabel')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('ExpenseImport.mapping.transformationsHint')}
          </p>
        </div>
        <Select
          value={null}
          onValueChange={(value) => {
            if (value) addTransform(value as DelimitedVisualTransform['kind'])
          }}
        >
          <SelectTrigger
            aria-label={t('ExpenseImport.mapping.addTransformationAria')}
            className="h-9 max-w-48"
          >
            <SelectValue
              placeholder={t(
                'ExpenseImport.mapping.addTransformationPlaceholder',
              )}
            />
          </SelectTrigger>
          <SelectContent>
            {mapping.sourceValues.length > 1 &&
            !mapping.transforms.some(({ kind }) => kind === 'JOIN') ? (
              <SelectItem value="JOIN">
                {t('ExpenseImport.mapping.optionJoin')}
              </SelectItem>
            ) : null}
            <SelectItem value="TRIM">
              {t('ExpenseImport.mapping.transformTrim')}
            </SelectItem>
            <SelectItem value="UPPER">
              {t('ExpenseImport.mapping.transformUpper')}
            </SelectItem>
            <SelectItem value="LOWER">
              {t('ExpenseImport.mapping.transformLower')}
            </SelectItem>
            <SelectItem value="REPLACE">
              {t('ExpenseImport.mapping.optionReplace')}
            </SelectItem>
            <SelectItem value="REGEX_EXTRACT">
              {t('ExpenseImport.mapping.optionRegex')}
            </SelectItem>
            {fieldKind === 'date' ? (
              <SelectItem value="PARSE_DATE">
                {t('ExpenseImport.mapping.optionParseDate')}
              </SelectItem>
            ) : null}
            {fieldKind === 'amount' ? (
              <>
                <SelectItem value="PARSE_NUMBER">
                  {t('ExpenseImport.mapping.optionParseNumber')}
                </SelectItem>
                <SelectItem value="DEBIT_CREDIT">
                  {t('ExpenseImport.mapping.optionDebitCredit')}
                </SelectItem>
              </>
            ) : null}
            {fieldKind === 'currency' ? (
              <SelectItem value="EXTRACT_CURRENCY">
                {t('ExpenseImport.mapping.optionExtractCurrency')}
              </SelectItem>
            ) : null}
            {fieldKind === 'amount' ? (
              <SelectItem value="SIGN_FROM_COLUMN">
                {t('ExpenseImport.mapping.optionSignRule')}
              </SelectItem>
            ) : null}
          </SelectContent>
        </Select>
      </div>
      {mapping.transforms.length ? (
        <div className="divide-y border-t">
          {mapping.transforms.map((transform, index) => (
            <div
              key={transformKeys[index]}
              className="space-y-2 py-3 text-sm first:pt-4 last:pb-0"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">
                  {index + 1}. {transformLabel(transform, t)}
                </span>
                <div className="flex shrink-0 gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t('ExpenseImport.mapping.moveTransformUp', {
                      index: index + 1,
                    })}
                    disabled={
                      index === 0 ||
                      (transform.kind !== 'JOIN' &&
                        mapping.transforms[0]?.kind === 'JOIN' &&
                        index === 1)
                    }
                    onClick={() => moveTransform(index, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t('ExpenseImport.mapping.moveTransformDown', {
                      index: index + 1,
                    })}
                    disabled={
                      index === mapping.transforms.length - 1 ||
                      transform.kind === 'JOIN'
                    }
                    onClick={() => moveTransform(index, 1)}
                  >
                    ↓
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t('ExpenseImport.mapping.removeTransform', {
                      index: index + 1,
                    })}
                    disabled={
                      transform.kind === 'JOIN' &&
                      mapping.sourceValues.length > 1
                    }
                    onClick={() =>
                      onChange({
                        ...mapping,
                        transforms: mapping.transforms.filter(
                          (_, itemIndex) => itemIndex !== index,
                        ),
                      })
                    }
                  >
                    ×
                  </Button>
                </div>
              </div>
              {transform.kind === 'JOIN' ? (
                <Input
                  aria-label={t(
                    'ExpenseImport.mapping.transformJoinSeparatorAria',
                    { index: index + 1 },
                  )}
                  value={transform.separator}
                  onChange={(event) =>
                    updateTransform(index, {
                      ...transform,
                      separator: event.target.value,
                    })
                  }
                  placeholder={t(
                    'ExpenseImport.mapping.joinSeparatorPlaceholder',
                  )}
                />
              ) : null}
              {transform.kind === 'REPLACE' ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Input
                    aria-label={t('ExpenseImport.mapping.transformSearchAria', {
                      index: index + 1,
                    })}
                    placeholder={t('ExpenseImport.mapping.findTextPlaceholder')}
                    value={transform.search}
                    onChange={(event) =>
                      updateTransform(index, {
                        ...transform,
                        search: event.target.value,
                      })
                    }
                  />
                  <Input
                    aria-label={t(
                      'ExpenseImport.mapping.transformReplacementAria',
                      { index: index + 1 },
                    )}
                    placeholder={t(
                      'ExpenseImport.mapping.replaceWithPlaceholder',
                    )}
                    value={transform.replacement}
                    onChange={(event) =>
                      updateTransform(index, {
                        ...transform,
                        replacement: event.target.value,
                      })
                    }
                  />
                </div>
              ) : null}
              {transform.kind === 'REGEX_EXTRACT' ? (
                <div className="grid gap-2 sm:grid-cols-[1fr_6rem]">
                  <Input
                    aria-label={t(
                      'ExpenseImport.mapping.transformPatternAria',
                      { index: index + 1 },
                    )}
                    placeholder={t('ExpenseImport.mapping.regexPlaceholder')}
                    value={transform.pattern}
                    onChange={(event) =>
                      updateTransform(index, {
                        ...transform,
                        pattern: event.target.value,
                      })
                    }
                  />
                  <Input
                    aria-label={t('ExpenseImport.mapping.transformGroupAria', {
                      index: index + 1,
                    })}
                    type="number"
                    min={0}
                    max={20}
                    value={transform.group}
                    onChange={(event) =>
                      updateTransform(index, {
                        ...transform,
                        group: Number(event.target.value) || 0,
                      })
                    }
                  />
                </div>
              ) : null}
              {transform.kind === 'PARSE_DATE' ? (
                <div className="space-y-1">
                  <Label htmlFor={`date-format-${index}`}>
                    {t('ExpenseImport.mapping.dateFormatLabel')}
                  </Label>
                  <Input
                    id={`date-format-${index}`}
                    aria-label={t(
                      'ExpenseImport.mapping.transformDateFormatAria',
                      { index: index + 1 },
                    )}
                    value={transform.format}
                    onChange={(event) =>
                      updateTransform(index, {
                        ...transform,
                        format: event.target.value,
                      })
                    }
                    placeholder={t(
                      'ExpenseImport.mapping.dateFormatPlaceholder',
                    )}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('ExpenseImport.mapping.explicitFormatHint')}
                  </p>
                </div>
              ) : null}
              {transform.kind === 'DEBIT_CREDIT' ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  {(['debitColumn', 'creditColumn'] as const).map((key) => (
                    <div key={key} className="space-y-1">
                      <Label>
                        {key === 'debitColumn'
                          ? t('ExpenseImport.mapping.debitColumnLabel')
                          : t('ExpenseImport.mapping.creditColumnLabel')}
                      </Label>
                      <Select
                        value={transform[key]}
                        onValueChange={(value) =>
                          value &&
                          updateTransform(index, { ...transform, [key]: value })
                        }
                      >
                        <SelectTrigger
                          aria-label={
                            key === 'debitColumn'
                              ? t('ExpenseImport.mapping.debitColumnLabel')
                              : t('ExpenseImport.mapping.creditColumnLabel')
                          }
                        >
                          <SelectValue>
                            {mappingColumnLabel(table, transform[key])}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          {table.columns.map((column) => (
                            <SelectItem key={column.key} value={column.key}>
                              {column.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              ) : null}
              {transform.kind === 'PARSE_NUMBER' ||
              transform.kind === 'DEBIT_CREDIT' ? (
                <Select
                  value={transform.format}
                  onValueChange={(value) =>
                    value &&
                    updateTransform(index, {
                      ...transform,
                      format: value as 'AUTO' | 'DOT' | 'COMMA',
                    })
                  }
                >
                  <SelectTrigger
                    aria-label={t(
                      'ExpenseImport.mapping.transformNumberFormatAria',
                      { index: index + 1 },
                    )}
                    className="h-9"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="AUTO">
                      {t('ExpenseImport.mapping.detectNumberFormat')}
                    </SelectItem>
                    <SelectItem value="DOT">
                      {t('ExpenseImport.mapping.dotDecimalExample')}
                    </SelectItem>
                    <SelectItem value="COMMA">
                      {t('ExpenseImport.mapping.commaDecimalExample')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              ) : null}
              {transform.kind === 'SIGN_FROM_COLUMN' ? (
                <div className="space-y-2">
                  <Select
                    value={transform.columnKey}
                    onValueChange={(value) =>
                      value &&
                      updateTransform(index, {
                        ...transform,
                        columnKey: value,
                      })
                    }
                  >
                    <SelectTrigger
                      aria-label={t(
                        'ExpenseImport.mapping.transformSignColumnAria',
                        { index: index + 1 },
                      )}
                      className="h-9"
                    >
                      <SelectValue>
                        {mappingColumnLabel(table, transform.columnKey)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {table.columns.map((column) => (
                        <SelectItem key={column.key} value={column.key}>
                          {column.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    aria-label={t(
                      'ExpenseImport.mapping.transformNegativeValuesAria',
                      { index: index + 1 },
                    )}
                    value={transform.negativeValues.join(', ')}
                    onChange={(event) =>
                      updateTransform(index, {
                        ...transform,
                        negativeValues: event.target.value
                          .split(',')
                          .map((value) => value.trim())
                          .filter(Boolean),
                      })
                    }
                    placeholder={t(
                      'ExpenseImport.mapping.negativeValuesPlaceholder',
                    )}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t('ExpenseImport.mapping.noTransforms')}
        </p>
      )}
    </div>
  )
}

function SimpleFieldControls({
  table,
  mapping,
  fieldKind,
  onChange,
}: {
  table: DelimitedTable
  mapping: DelimitedVisualMapping
  fieldKind: PipelineFieldKind
  onChange: (mapping: DelimitedVisualMapping) => void
}) {
  const { t } = useTranslation()
  const updateTransform = (
    kind: DelimitedVisualTransform['kind'],
    next: DelimitedVisualTransform | null,
  ) => {
    const remaining = mapping.transforms.filter(
      (transform) => transform.kind !== kind,
    )
    if (next) remaining.push(next)
    onChange({ ...mapping, transforms: remaining })
  }
  const dateTransform = mapping.transforms.find(
    (
      transform,
    ): transform is Extract<DelimitedVisualTransform, { kind: 'PARSE_DATE' }> =>
      transform.kind === 'PARSE_DATE',
  )
  const numberTransform = mapping.transforms.find(
    (
      transform,
    ): transform is Extract<
      DelimitedVisualTransform,
      { kind: 'PARSE_NUMBER' }
    > => transform.kind === 'PARSE_NUMBER',
  )
  const signTransform = mapping.transforms.find(
    (
      transform,
    ): transform is Extract<
      DelimitedVisualTransform,
      { kind: 'SIGN_FROM_COLUMN' }
    > => transform.kind === 'SIGN_FROM_COLUMN',
  )

  if (fieldKind === 'text') return null

  return (
    <div className="space-y-3 border-t pt-4">
      <div>
        <Label>{t('ExpenseImport.mapping.basicSettings')}</Label>
        <p className="text-xs text-muted-foreground">
          {t('ExpenseImport.mapping.basicSettingsHint')}
        </p>
      </div>
      {fieldKind === 'date' ? (
        <div className="space-y-1">
          <Label htmlFor="simple-date-format">
            {t('ExpenseImport.mapping.dateFormatLabel')}
          </Label>
          <Input
            id="simple-date-format"
            aria-label={t('ExpenseImport.mapping.dateFormatLabel')}
            value={
              dateTransform?.kind === 'PARSE_DATE' ? dateTransform.format : ''
            }
            onChange={(event) => {
              const next: DelimitedVisualTransform[] =
                mapping.transforms.filter(
                  (transform) =>
                    transform.kind !== 'PARSE_DATE' &&
                    transform.kind !== 'JOIN',
                )
              next.push({ kind: 'PARSE_DATE', format: event.target.value })
              onChange({ ...mapping, transforms: next })
            }}
            placeholder={t('ExpenseImport.mapping.dateFormatPlaceholder')}
          />
          <p className="text-xs text-muted-foreground">
            {t('ExpenseImport.mapping.simpleDateHint')}
          </p>
        </div>
      ) : null}
      {fieldKind === 'amount' ? (
        <div className="space-y-3">
          <div className="space-y-1 text-sm">
            <Label>{t('ExpenseImport.mapping.numberFormatLabel')}</Label>
            <Select
              value={
                numberTransform?.kind === 'PARSE_NUMBER'
                  ? numberTransform.format
                  : 'AUTO'
              }
              onValueChange={(value) =>
                value &&
                updateTransform('PARSE_NUMBER', {
                  kind: 'PARSE_NUMBER',
                  format: value as 'AUTO' | 'DOT' | 'COMMA',
                })
              }
            >
              <SelectTrigger
                aria-label={t('ExpenseImport.mapping.numberFormatLabel')}
                className="h-9"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="AUTO">
                  {t('ExpenseImport.mapping.detectNumberFormat')}
                </SelectItem>
                <SelectItem value="DOT">
                  {t('ExpenseImport.mapping.dotDecimalExample')}
                </SelectItem>
                <SelectItem value="COMMA">
                  {t('ExpenseImport.mapping.commaDecimalExample')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Checkbox
              id="simple-sign-rule"
              checked={Boolean(signTransform)}
              onCheckedChange={(checked) =>
                updateTransform(
                  'SIGN_FROM_COLUMN',
                  checked
                    ? {
                        kind: 'SIGN_FROM_COLUMN',
                        columnKey: table.columns[0]?.key ?? '',
                        negativeValues: ['income', 'credit', 'deposit'],
                      }
                    : null,
                )
              }
            />
            <label htmlFor="simple-sign-rule">
              {t('ExpenseImport.mapping.applySignRule')}
            </label>
          </div>
          {signTransform?.kind === 'SIGN_FROM_COLUMN' ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <label htmlFor="simple-sign-column" className="space-y-1 text-sm">
                <span className="font-medium">
                  {t('ExpenseImport.mapping.signColumnLabel')}
                </span>
                <Select
                  value={signTransform.columnKey}
                  onValueChange={(value) =>
                    value &&
                    updateTransform('SIGN_FROM_COLUMN', {
                      ...signTransform,
                      columnKey: value,
                    })
                  }
                >
                  <SelectTrigger
                    id="simple-sign-column"
                    aria-label={t('ExpenseImport.mapping.signColumnLabel')}
                    className="h-9"
                  >
                    <SelectValue>
                      {mappingColumnLabel(table, signTransform.columnKey)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {table.columns.map((column) => (
                      <SelectItem key={column.key} value={column.key}>
                        {column.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label
                htmlFor="simple-negative-values"
                className="space-y-1 text-sm"
              >
                <span className="font-medium">
                  {t('ExpenseImport.mapping.negativeValuesLabel')}
                </span>
                <Input
                  id="simple-negative-values"
                  aria-label={t('ExpenseImport.mapping.negativeValuesLabel')}
                  value={signTransform.negativeValues.join(', ')}
                  onChange={(event) =>
                    updateTransform('SIGN_FROM_COLUMN', {
                      ...signTransform,
                      negativeValues: event.target.value
                        .split(',')
                        .map((value) => value.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder={t(
                    'ExpenseImport.mapping.negativeValuesPlaceholder',
                  )}
                />
              </label>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function VisualPipelineEditor({
  table,
  mapping,
  fieldKind,
  simple,
  onChange,
  onOpenAdvanced,
}: {
  table: DelimitedTable
  mapping: DelimitedVisualMapping
  fieldKind: PipelineFieldKind
  simple: boolean
  onChange: (mapping: DelimitedVisualMapping) => void
  onOpenAdvanced?: () => void
}) {
  return (
    <div className="space-y-5">
      <SourceValuesEditor
        table={table}
        mapping={mapping}
        simple={simple}
        onChange={onChange}
        onOpenAdvanced={onOpenAdvanced}
      />
      {simple ? (
        <SimpleFieldControls
          table={table}
          mapping={mapping}
          fieldKind={fieldKind}
          onChange={onChange}
        />
      ) : (
        <TransformList
          table={table}
          mapping={mapping}
          fieldKind={fieldKind}
          onChange={onChange}
        />
      )}
    </div>
  )
}

function MappingModeTabs({
  mode,
  onChange,
}: {
  mode: MappingEditorMode
  onChange: (mode: MappingEditorMode) => void
}) {
  const { t } = useTranslation()
  return (
    <Tabs
      value={mode}
      onValueChange={(value) => onChange(value as MappingEditorMode)}
    >
      <TabsList className="grid w-full grid-cols-3">
        <TabsTrigger value="simple">
          {t('ExpenseImport.mapping.tabSimple')}
        </TabsTrigger>
        <TabsTrigger value="advanced">
          {t('ExpenseImport.mapping.tabAdvanced')}
        </TabsTrigger>
        <TabsTrigger value="code">
          {t('ExpenseImport.mapping.tabCode')}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  )
}

export function MappingEditor({
  field,
  table,
  mappingDocument,
  initialMapping,
  defaultMapping,
  previewRows,
  onClose,
  onSave,
}: {
  field: MappingFieldKey
  table: DelimitedTable
  mappingDocument?: DelimitedExpenseMappingV1
  initialMapping: DelimitedFieldMapping
  defaultMapping: DelimitedVisualMapping
  previewRows?: DelimitedPreviewRow[]
  onClose: () => void
  onSave: (mapping: DelimitedFieldMapping) => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(() =>
    initialMapping.mode === 'VISUAL'
      ? normalizeVisualSourceValues(initialMapping, initialMapping.sourceValues)
      : initialMapping,
  )
  const [mode, setMode] = useState<MappingEditorMode>(
    initialMapping.mode === 'CEL'
      ? 'code'
      : (classifyDelimitedFieldMapping(
          initialMapping,
          field === 'dateTime' ? 'dateTime' : 'text',
        ).toLowerCase() as MappingEditorMode),
  )
  const [codeEditing, setCodeEditing] = useState(false)
  const [codeEditWarning, setCodeEditWarning] = useState(false)
  const [pendingResetMode, setPendingResetMode] = useState<
    'simple' | 'advanced' | null
  >(null)
  const [compileError, setCompileError] = useState<string | null>(null)
  const [draftExamples, setDraftExamples] = useState<DelimitedPreviewRow[]>([])
  const [draftExamplesPending, setDraftExamplesPending] = useState(
    Boolean(mappingDocument && previewRows?.length),
  )
  const draftExamplesRequest = useRef(0)
  const meta = fieldMeta[field]
  useEffect(() => {
    if (!mappingDocument || !previewRows?.length) return
    // Debounce editor keystrokes so rapid edits issue one preview instead of
    // cloning the full table per change.
    let cancelled = false
    let request = 0
    const previewMapping: DelimitedExpenseMappingV1 = {
      ...mappingDocument,
      mappings: { ...mappingDocument.mappings, [field]: draft },
    }
    const timer = setTimeout(() => {
      request = ++draftExamplesRequest.current
      void Promise.resolve()
        .then(() => {
          if (cancelled) return undefined
          setDraftExamplesPending(true)
          setDraftExamples([])
          setCompileError(null)
          return previewExpenseFile(
            table,
            previewMapping,
            {
              includeAmbiguousDateIssue: false,
              preferredDateOrder: preferredDateOrder(),
            },
            `MAPPING_EDITOR_PREVIEW:${field}`,
          )
        })
        .then((rows) => {
          if (!rows) return
          if (cancelled || request !== draftExamplesRequest.current) return
          setDraftExamples(rows)
          setDraftExamplesPending(false)
        })
        .catch((previewError) => {
          if (cancelled || request !== draftExamplesRequest.current) return
          setDraftExamplesPending(false)
          // Don't leave a stale preview up: surface mapping evaluation
          // failures (e.g. a stale column signature) in the editor's error
          // slot instead of silently showing rows from the old mapping.
          setCompileError(
            previewError instanceof Error
              ? previewError.message
              : t('ExpenseImport.mapping.previewEvalError'),
          )
        })
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
      draftExamplesRequest.current += 1
    }
  }, [draft, field, mappingDocument, previewRows?.length, t, table])
  const visual = draft.mode === 'VISUAL' ? draft : null
  const examples = draftExamplesPending
    ? []
    : (draftExamples.length ? draftExamples : (previewRows ?? [])).slice(0, 10)
  const visualMode = visual
    ? classifyDelimitedFieldMapping(
        visual,
        field === 'dateTime' ? 'dateTime' : 'text',
      )
    : null
  const switchMode = (next: MappingEditorMode) => {
    if (next === 'simple' && visualMode === 'ADVANCED') {
      setPendingResetMode('simple')
      return
    }
    if (next !== 'code' && draft.mode === 'CEL') {
      setPendingResetMode(next)
      return
    }
    if (next === 'code') setCodeEditWarning(false)
    setMode(next)
  }

  const resetToVisual = (nextMode: 'simple' | 'advanced' = 'simple') => {
    const next =
      draft.mode === 'VISUAL'
        ? simplifyDelimitedFieldMapping(
            draft,
            field === 'dateTime' ? 'dateTime' : 'text',
          )
        : defaultMapping
    setDraft(next)
    setPendingResetMode(null)
    setCodeEditing(false)
    setCodeEditWarning(false)
    setMode(nextMode)
    setCompileError(null)
  }

  const confirmCodeEdit = () => {
    if (!visual) {
      setCodeEditing(true)
      setCodeEditWarning(false)
      return
    }
    try {
      setDraft({ mode: 'CEL', expression: compileDelimitedMapping(visual) })
      setCompileError(null)
      setCodeEditing(true)
      setCodeEditWarning(false)
    } catch (error) {
      setCompileError(
        error instanceof Error
          ? error.message
          : t('ExpenseImport.mapping.cannotCompileYet'),
      )
    }
  }

  const generatedCode =
    draft.mode === 'CEL'
      ? draft.expression
      : (() => {
          try {
            return compileDelimitedMapping(draft)
          } catch {
            return t('ExpenseImport.mapping.currentMappingCannotCompile')
          }
        })()

  const mappingValidationError = useMemo(() => {
    try {
      validateDelimitedMapping(draft)
      return null
    } catch (error) {
      return error instanceof Error
        ? error.message
        : t('ExpenseImport.mapping.mappingInvalid')
    }
  }, [draft, t])

  const resetVisual = () => resetToVisual('simple')

  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-3xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t('ExpenseImport.mapping.editorTitle', { title: t(meta.title) })}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {t(meta.description)}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="min-h-0 space-y-5 overflow-y-auto">
          <MappingModeTabs mode={mode} onChange={switchMode} />
          {pendingResetMode ? (
            <Alert>
              <AlertCircle className="size-4" />
              <AlertTitle>
                {draft.mode === 'CEL'
                  ? t('ExpenseImport.mapping.resetVisualTitle')
                  : t('ExpenseImport.mapping.simplifyTitle')}
              </AlertTitle>
              <AlertDescription className="space-y-3">
                {draft.mode === 'CEL'
                  ? t('ExpenseImport.mapping.codeResetBody')
                  : t('ExpenseImport.mapping.simpleResetBody')}
                {draft.mode === 'VISUAL' && pendingResetMode === 'simple' ? (
                  <div className="grid gap-2 text-xs sm:grid-cols-2">
                    <div className="border-s ps-3">
                      <p className="font-medium">
                        {t('ExpenseImport.mapping.beforeLabel')}
                      </p>
                      <p className="text-muted-foreground">
                        {t('ExpenseImport.mapping.beforeBody')}
                      </p>
                    </div>
                    <div className="border-s ps-3">
                      <p className="font-medium">
                        {t('ExpenseImport.mapping.afterLabel')}
                      </p>
                      <p className="text-muted-foreground">
                        {t('ExpenseImport.mapping.afterBody')}
                      </p>
                    </div>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => resetToVisual(pendingResetMode)}
                  >
                    {draft.mode === 'CEL'
                      ? pendingResetMode === 'simple'
                        ? t('ExpenseImport.mapping.resetToSimple')
                        : t('ExpenseImport.mapping.resetToAdvanced')
                      : pendingResetMode === 'simple'
                        ? t('ExpenseImport.mapping.useSimple')
                        : t('ExpenseImport.mapping.useAdvanced')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setPendingResetMode(null)}
                  >
                    {draft.mode === 'CEL'
                      ? t('ExpenseImport.mapping.keepCode')
                      : mode === 'advanced'
                        ? t('ExpenseImport.mapping.keepAdvanced')
                        : t('ExpenseImport.mapping.keepSimple')}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}
          {mappingValidationError ? (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>
                {t('ExpenseImport.mapping.needsAttention')}
              </AlertTitle>
              <AlertDescription>{mappingValidationError}</AlertDescription>
            </Alert>
          ) : null}
          {mode === 'code' ? (
            <div className="space-y-3">
              {!codeEditing ? (
                <Alert>
                  <AlertCircle className="size-4" />
                  <AlertTitle>
                    {t('ExpenseImport.mapping.codePreviewTitle')}
                  </AlertTitle>
                  <AlertDescription>
                    {t('ExpenseImport.mapping.codePreviewBody')}
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert>
                  <AlertCircle className="size-4" />
                  <AlertTitle>
                    {t('ExpenseImport.mapping.codeOneWayTitle')}
                  </AlertTitle>
                  <AlertDescription>
                    {t('ExpenseImport.mapping.codeOneWayBody')}
                  </AlertDescription>
                </Alert>
              )}
              {codeEditing ? (
                <>
                  <Label htmlFor="mapping-cel">
                    {t('ExpenseImport.mapping.celLabel')}
                  </Label>
                  <Textarea
                    id="mapping-cel"
                    aria-label={t('ExpenseImport.mapping.celLabel')}
                    className="min-h-48 font-mono text-xs"
                    value={
                      draft.mode === 'CEL' ? draft.expression : generatedCode
                    }
                    onChange={(event) =>
                      setDraft({ mode: 'CEL', expression: event.target.value })
                    }
                  />
                </>
              ) : (
                <pre className="max-h-56 overflow-auto rounded-md bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap">
                  {generatedCode}
                </pre>
              )}
              {compileError ? (
                <p className="text-sm text-destructive">{compileError}</p>
              ) : null}
              {codeEditWarning ? (
                <Alert>
                  <AlertCircle className="size-4" />
                  <AlertTitle>
                    {t('ExpenseImport.mapping.useCodeTitle')}
                  </AlertTitle>
                  <AlertDescription className="space-y-3">
                    {t('ExpenseImport.mapping.useCodeBody')}
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" onClick={confirmCodeEdit}>
                        {t('ExpenseImport.mapping.editWithCode')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setCodeEditWarning(false)}
                      >
                        {t('ExpenseImport.mapping.cancelButton')}
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              ) : null}
              {codeEditing ? (
                <Button type="button" variant="outline" onClick={resetVisual}>
                  {t('ExpenseImport.mapping.resetToVisual')}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setCodeEditWarning(true)}
                >
                  {t('ExpenseImport.mapping.editWithCode')}
                </Button>
              )}
            </div>
          ) : visual ? (
            <VisualPipelineEditor
              table={table}
              mapping={visual}
              fieldKind={meta.kind}
              simple={mode === 'simple'}
              onOpenAdvanced={() => setMode('advanced')}
              onChange={(next) => setDraft(next)}
            />
          ) : null}
          <div className="space-y-2">
            <Label>{t('ExpenseImport.mapping.liveExamples')}</Label>
            {draftExamplesPending ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />{' '}
                {t('ExpenseImport.mapping.evaluatingMapping')}
              </p>
            ) : null}
            <div className="flex max-w-full gap-2 overflow-x-auto pb-1">
              {examples.map((row, index) => (
                <div
                  key={`${row.rowNumber}-${field}`}
                  className="min-w-64 shrink-0 rounded-md border bg-muted/30 px-3 py-2 text-sm"
                >
                  <span className="block text-xs text-muted-foreground">
                    {t('ExpenseImport.mapping.sourceRowExpense', {
                      expenseNumber: index + 1,
                      rowNumber: row.rowNumber,
                    })}
                  </span>
                  <span className="mt-2 block text-xs font-medium text-muted-foreground">
                    {t('ExpenseImport.mapping.rawValueLabel')}
                  </span>
                  {previewSourceValues(table, row.rowNumber, draft, t).map(
                    ({ label, sourceKind, value }) => (
                      <span
                        key={`${row.rowNumber}-${sourceKind}-${label}`}
                        className="block truncate text-xs"
                        title={value}
                      >
                        <span className="text-muted-foreground">
                          {sourceKind} ·{' '}
                        </span>
                        <span className="font-medium">{label}</span>: {value}
                      </span>
                    ),
                  )}
                  <span className="mt-2 block text-xs font-medium text-muted-foreground">
                    {t('ExpenseImport.mapping.mappedValueLabel')}
                  </span>
                  <span
                    className="block truncate font-medium"
                    title={previewFieldValue(row, field, t)}
                  >
                    {previewFieldValue(row, field, t)}
                  </span>
                </div>
              ))}
              {examples.length < (previewRows?.length ?? 0) ? (
                <span className="flex min-w-40 shrink-0 items-center justify-center text-xs text-muted-foreground">
                  {t('ExpenseImport.mapping.moreExamplesHint')}
                </span>
              ) : null}
            </div>
          </div>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('ExpenseImport.mapping.cancelButton')}
          </Button>
          <Button
            type="button"
            disabled={Boolean(mappingValidationError)}
            onClick={() => onSave(draft)}
          >
            {t('ExpenseImport.mapping.saveMapping')}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function updateSimpleTransform(
  mapping: DelimitedVisualMapping,
  kind: DelimitedVisualTransform['kind'],
  next: DelimitedVisualTransform | null,
  order: DelimitedVisualTransform['kind'][],
) {
  const transforms = mapping.transforms.filter(
    (transform) => transform.kind !== kind,
  )
  if (next) transforms.push(next)
  transforms.sort((left, right) => {
    const leftIndex = order.indexOf(left.kind)
    const rightIndex = order.indexOf(right.kind)
    return (
      (leftIndex < 0 ? order.length : leftIndex) -
      (rightIndex < 0 ? order.length : rightIndex)
    )
  })
  return { ...mapping, transforms }
}

function preferredSignColumn(table: DelimitedTable, amountSourceKey: string) {
  return (
    findColumn(table.columns, [
      /income expense/,
      /credit debit/,
      /transaction type/,
      /^type$/,
    ]) ?? table.columns.find((column) => column.key !== amountSourceKey)
  )
}

function preferredCurrencyColumn(
  table: DelimitedTable,
  amountSourceKey: string,
) {
  return (
    findColumn(table.columns, [/^currency$/, /^ccy$/]) ??
    table.columns.find((column) => column.key !== amountSourceKey)
  )
}

function RadioChoice({
  id,
  value,
  title,
  description,
}: {
  id: string
  value: string
  title: string
  description: string
}) {
  return (
    <div className="flex items-start gap-3 py-1">
      <RadioGroupItem id={id} value={value} className="mt-0.5 shrink-0" />
      <Label htmlFor={id} className="min-w-0 cursor-pointer font-normal">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">
          {description}
        </span>
      </Label>
    </div>
  )
}

function SimpleMoneyMappingEditor({
  table,
  mapping,
  fixedCurrencyCode,
  groupCurrencyCode,
  onFixedCurrencyChange,
  onChange,
}: {
  table: DelimitedTable
  mapping: VisualMoneyMapping
  fixedCurrencyCode: string
  groupCurrencyCode: string
  onFixedCurrencyChange: (currencyCode: string) => void
  onChange: (mapping: VisualMoneyMapping) => void
}) {
  const { t } = useTranslation()
  const currencies = useCurrencies('')
  const amountSourceKey = mapping.amount.sourceValues[0]?.primary ?? ''
  const currencyMode = moneyCurrencySource(mapping)
  const numberTransform = mapping.amount.transforms.find(
    (
      transform,
    ): transform is Extract<
      DelimitedVisualTransform,
      { kind: 'PARSE_NUMBER' }
    > => transform.kind === 'PARSE_NUMBER',
  )
  const signTransform = mapping.amount.transforms.find(
    (
      transform,
    ): transform is Extract<
      DelimitedVisualTransform,
      { kind: 'SIGN_FROM_COLUMN' }
    > => transform.kind === 'SIGN_FROM_COLUMN',
  )
  const signHandling: MoneySignHandling = signTransform
    ? 'FROM_COLUMN'
    : 'AS_WRITTEN'
  const separateCurrencySource =
    currencyMode === 'SEPARATE_SOURCE'
      ? (mapping.currency?.sourceValues[0]?.primary ?? '')
      : ''
  const amountTransformOrder: DelimitedVisualTransform['kind'][] = [
    'TRIM',
    'PARSE_NUMBER',
    'SIGN_FROM_COLUMN',
  ]

  const setAmountSource = (sourceKey: string) => {
    const amount = {
      ...mapping.amount,
      sourceValues: [{ primary: sourceKey, fallbacks: [] }],
    }
    onChange({
      ...mapping,
      amount,
      ...(currencyMode === 'AMOUNT_SOURCE'
        ? { currency: simpleCurrencyMapping(sourceKey) }
        : {}),
    })
  }

  const setAmountTransform = (
    kind: DelimitedVisualTransform['kind'],
    transform: DelimitedVisualTransform | null,
  ) =>
    onChange({
      ...mapping,
      amount: updateSimpleTransform(
        mapping.amount,
        kind,
        transform,
        amountTransformOrder,
      ),
    })

  const setSignHandling = (handling: MoneySignHandling) => {
    if (handling === 'AS_WRITTEN') {
      setAmountTransform('SIGN_FROM_COLUMN', null)
      return
    }
    const column = preferredSignColumn(table, amountSourceKey)
    if (!column) return
    setAmountTransform(
      'SIGN_FROM_COLUMN',
      signTransform ?? {
        kind: 'SIGN_FROM_COLUMN',
        columnKey: column.key,
        negativeValues: ['income', 'credit', 'deposit'],
      },
    )
  }

  const setCurrencyMode = (nextMode: MoneyCurrencySource) => {
    if (nextMode === 'FIXED') {
      onChange({ ...mapping, currency: undefined })
      return
    }
    if (nextMode === 'AMOUNT_SOURCE') {
      if (!amountSourceKey) return
      onChange({
        ...mapping,
        currency: simpleCurrencyMapping(amountSourceKey),
      })
      return
    }
    const source =
      (currencyMode === 'SEPARATE_SOURCE' &&
        mapping.currency?.sourceValues[0]?.primary) ||
      preferredCurrencyColumn(table, amountSourceKey)?.key
    if (!source) return
    onChange({ ...mapping, currency: simpleCurrencyMapping(source) })
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4 border-b pb-6">
        <div>
          <h3 className="font-medium">
            {t('ExpenseImport.mapping.amountHeading')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t('ExpenseImport.mapping.amountHint')}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{t('ExpenseImport.mapping.amountColumnLabel')}</Label>
            <Select
              value={amountSourceKey}
              onValueChange={(value) => value && setAmountSource(value)}
            >
              <SelectTrigger
                aria-label={t('ExpenseImport.mapping.amountColumnLabel')}
              >
                <SelectValue>
                  {mappingColumnLabel(table, amountSourceKey)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {table.columns.map((column) => (
                  <SelectItem key={column.key} value={column.key}>
                    {column.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t('ExpenseImport.mapping.numberFormatLabel')}</Label>
            <Select
              value={numberTransform?.format ?? 'AUTO'}
              onValueChange={(value) =>
                value &&
                setAmountTransform('PARSE_NUMBER', {
                  kind: 'PARSE_NUMBER',
                  format: value as 'AUTO' | 'DOT' | 'COMMA',
                })
              }
            >
              <SelectTrigger
                aria-label={t('ExpenseImport.mapping.numberFormatLabel')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="AUTO">
                  {t('ExpenseImport.mapping.automaticOption')}
                </SelectItem>
                <SelectItem value="DOT">
                  {t('ExpenseImport.mapping.dotDecimalMoney')}
                </SelectItem>
                <SelectItem value="COMMA">
                  {t('ExpenseImport.mapping.commaDecimalMoney')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-2">
          <Label>{t('ExpenseImport.mapping.signHandlingLabel')}</Label>
          <RadioGroup
            aria-label={t('ExpenseImport.mapping.signHandlingLabel')}
            value={signHandling}
            onValueChange={(value) =>
              setSignHandling(value as MoneySignHandling)
            }
            className="gap-2"
          >
            <RadioChoice
              id="money-sign-as-written"
              value="AS_WRITTEN"
              title={t('ExpenseImport.mapping.signAsWrittenTitle')}
              description={t('ExpenseImport.mapping.signAsWrittenDesc')}
            />
            <RadioChoice
              id="money-sign-from-column"
              value="FROM_COLUMN"
              title={t('ExpenseImport.mapping.signFromColumnTitle')}
              description={t('ExpenseImport.mapping.signFromColumnDesc')}
            />
          </RadioGroup>
        </div>
        {signTransform ? (
          <div className="grid gap-4 border-s-2 border-muted ps-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>
                {t('ExpenseImport.mapping.incomeExpenseColumnLabel')}
              </Label>
              <Select
                value={signTransform.columnKey}
                onValueChange={(value) =>
                  value &&
                  setAmountTransform('SIGN_FROM_COLUMN', {
                    ...signTransform,
                    columnKey: value,
                  })
                }
              >
                <SelectTrigger
                  aria-label={t(
                    'ExpenseImport.mapping.incomeExpenseColumnLabel',
                  )}
                >
                  <SelectValue>
                    {mappingColumnLabel(table, signTransform.columnKey)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {table.columns.map((column) => (
                    <SelectItem key={column.key} value={column.key}>
                      {column.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="money-income-values">
                {t('ExpenseImport.mapping.incomeValuesLabel')}
              </Label>
              <Input
                id="money-income-values"
                value={signTransform.negativeValues.join(', ')}
                onChange={(event) =>
                  setAmountTransform('SIGN_FROM_COLUMN', {
                    ...signTransform,
                    negativeValues: event.target.value
                      .split(',')
                      .map((value) => value.trim())
                      .filter(Boolean),
                  })
                }
                placeholder={t(
                  'ExpenseImport.mapping.negativeValuesPlaceholder',
                )}
              />
              <p className="text-xs text-muted-foreground">
                {t('ExpenseImport.mapping.incomeHint')}
              </p>
            </div>
          </div>
        ) : null}
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="font-medium">
            {t('ExpenseImport.mapping.currencyHeading')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t('ExpenseImport.mapping.currencyHint')}
          </p>
        </div>
        <RadioGroup
          aria-label={t('ExpenseImport.mapping.currencySourceAria')}
          value={currencyMode}
          onValueChange={(value) =>
            setCurrencyMode(value as MoneyCurrencySource)
          }
          className="gap-2"
        >
          <RadioChoice
            id="money-currency-fixed"
            value="FIXED"
            title={t('ExpenseImport.mapping.useOneCurrencyTitle')}
            description={t('ExpenseImport.mapping.useOneCurrencyDesc')}
          />
          <RadioChoice
            id="money-currency-amount"
            value="AMOUNT_SOURCE"
            title={t('ExpenseImport.mapping.extractAmountTitle')}
            description={t('ExpenseImport.mapping.extractAmountDesc', {
              column: mappingColumnLabel(table, amountSourceKey),
            })}
          />
          <RadioChoice
            id="money-currency-separate"
            value="SEPARATE_SOURCE"
            title={t('ExpenseImport.mapping.readAnotherTitle')}
            description={t('ExpenseImport.mapping.readAnotherDesc')}
          />
        </RadioGroup>
        {currencyMode === 'FIXED' ? (
          <div className="max-w-md space-y-1.5 border-s-2 border-muted ps-4">
            <Label htmlFor="money-fixed-currency">
              {t('ExpenseImport.mapping.currencyLabel')}
            </Label>
            <CurrencySelector
              id="money-fixed-currency"
              aria-label={t('ExpenseImport.mapping.currencyLabel')}
              currencies={currencies}
              defaultValue={fixedCurrencyCode}
              isLoading={false}
              pinnedCurrencyCode={groupCurrencyCode}
              onValueChange={onFixedCurrencyChange}
            />
          </div>
        ) : currencyMode === 'SEPARATE_SOURCE' ? (
          <div className="max-w-md space-y-1.5 border-s-2 border-muted ps-4">
            <Label>{t('ExpenseImport.mapping.currencyColumnLabel')}</Label>
            <Select
              value={separateCurrencySource}
              onValueChange={(value) =>
                value &&
                onChange({
                  ...mapping,
                  currency: simpleCurrencyMapping(value),
                })
              }
            >
              <SelectTrigger
                aria-label={t('ExpenseImport.mapping.currencyColumnLabel')}
              >
                <SelectValue>
                  {mappingColumnLabel(table, separateCurrencySource)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {table.columns.map((column) => (
                  <SelectItem key={column.key} value={column.key}>
                    {column.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </section>
    </div>
  )
}

function AdvancedCurrencyMappingEditor({
  table,
  mapping,
  fixedCurrencyCode,
  groupCurrencyCode,
  onFixedCurrencyChange,
  onChange,
}: {
  table: DelimitedTable
  mapping: VisualMoneyMapping
  fixedCurrencyCode: string
  groupCurrencyCode: string
  onFixedCurrencyChange: (currencyCode: string) => void
  onChange: (mapping: VisualMoneyMapping) => void
}) {
  const { t } = useTranslation()
  const currencies = useCurrencies('')
  const amountSourceKey = mapping.amount.sourceValues[0]?.primary ?? ''
  const sourceMode = mapping.currency ? 'SOURCE' : 'FIXED'
  const enableSourceMapping = () => {
    const source =
      preferredCurrencyColumn(table, amountSourceKey)?.key ?? amountSourceKey
    if (!source) return
    onChange({ ...mapping, currency: simpleCurrencyMapping(source) })
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>{t('ExpenseImport.mapping.advCurrencySourceLabel')}</Label>
        <RadioGroup
          aria-label={t('ExpenseImport.mapping.advCurrencySourceAria')}
          value={sourceMode}
          onValueChange={(value) => {
            if (value === 'FIXED') onChange({ ...mapping, currency: undefined })
            else if (value === 'SOURCE') enableSourceMapping()
          }}
        >
          <RadioChoice
            id="advanced-money-currency-fixed"
            value="FIXED"
            title={t('ExpenseImport.mapping.useOneCurrencyTitle')}
            description={t('ExpenseImport.mapping.advUseOneDesc')}
          />
          <RadioChoice
            id="advanced-money-currency-source"
            value="SOURCE"
            title={t('ExpenseImport.mapping.advMapTitle')}
            description={t('ExpenseImport.mapping.advMapDesc')}
          />
        </RadioGroup>
      </div>
      {mapping.currency ? (
        <VisualPipelineEditor
          table={table}
          mapping={mapping.currency}
          fieldKind="currency"
          simple={false}
          onChange={(currency) => onChange({ ...mapping, currency })}
        />
      ) : (
        <div className="max-w-md space-y-1.5 border-s-2 border-muted ps-4">
          <Label htmlFor="advanced-money-fixed-currency">
            {t('ExpenseImport.mapping.currencyLabel')}
          </Label>
          <CurrencySelector
            id="advanced-money-fixed-currency"
            aria-label={t('ExpenseImport.mapping.currencyLabel')}
            currencies={currencies}
            defaultValue={fixedCurrencyCode}
            isLoading={false}
            pinnedCurrencyCode={groupCurrencyCode}
            onValueChange={onFixedCurrencyChange}
          />
        </div>
      )}
    </div>
  )
}

export function MoneyMappingEditor({
  table,
  initialMapping,
  defaultMapping,
  defaultCurrencyCode,
  groupCurrencyCode = defaultCurrencyCode,
  onClose,
  onSave,
}: {
  table: DelimitedTable
  initialMapping: DelimitedMoneyMapping
  defaultMapping: DelimitedMoneyMapping
  defaultCurrencyCode: string
  groupCurrencyCode?: string
  onClose: () => void
  onSave: (mapping: DelimitedMoneyMapping, currencyCode: string) => void
}) {
  const { t } = useTranslation()
  const [fixedCurrencyCode, setFixedCurrencyCode] =
    useState(defaultCurrencyCode)
  const [draft, setDraft] = useState<DelimitedMoneyMapping>(() => {
    if (initialMapping.mode === 'CEL') return initialMapping
    return {
      ...initialMapping,
      amount: normalizeVisualSourceValues(
        initialMapping.amount,
        initialMapping.amount.sourceValues,
      ),
      currency: initialMapping.currency
        ? normalizeVisualSourceValues(
            initialMapping.currency,
            initialMapping.currency.sourceValues,
          )
        : undefined,
    }
  })
  const [mode, setMode] = useState<MappingEditorMode>(
    initialMapping.mode === 'CEL'
      ? 'code'
      : (classifyDelimitedMoneyMapping(
          initialMapping,
        ).toLowerCase() as MappingEditorMode),
  )
  const [codeEditing, setCodeEditing] = useState(false)
  const [codeEditWarning, setCodeEditWarning] = useState(false)
  const [pendingResetMode, setPendingResetMode] = useState<
    'simple' | 'advanced' | null
  >(null)
  const [compileError, setCompileError] = useState<string | null>(null)
  const visual = draft.mode === 'VISUAL' ? draft : null
  const visualMode = visual ? classifyDelimitedMoneyMapping(visual) : null
  const switchMode = (next: MappingEditorMode) => {
    if (next === 'simple' && visualMode === 'ADVANCED') {
      setPendingResetMode('simple')
      return
    }
    if (next !== 'code' && draft.mode === 'CEL') {
      setPendingResetMode(next)
      return
    }
    if (next === 'code') setCodeEditWarning(false)
    setMode(next)
  }

  const resetToVisual = (nextMode: 'simple' | 'advanced' = 'simple') => {
    const next =
      draft.mode === 'VISUAL'
        ? simplifyDelimitedMoneyMapping(draft)
        : defaultMapping
    setDraft(next)
    setPendingResetMode(null)
    setCodeEditing(false)
    setCodeEditWarning(false)
    setMode(nextMode)
    setCompileError(null)
  }

  const confirmCodeEdit = () => {
    if (!visual) {
      setCodeEditing(true)
      setCodeEditWarning(false)
      return
    }
    try {
      const currencyExpression = visual.currency
        ? compileDelimitedMapping(visual.currency)
        : '""'
      setDraft({
        mode: 'CEL',
        expression: `{"amount": ${compileDelimitedMapping(visual.amount)}, "currency": ${currencyExpression}}`,
      })
      setCompileError(null)
      setCodeEditing(true)
      setCodeEditWarning(false)
    } catch (error) {
      setCompileError(
        error instanceof Error
          ? error.message
          : t('ExpenseImport.mapping.cannotCompileYet'),
      )
    }
  }

  const generatedCode =
    draft.mode === 'CEL'
      ? draft.expression
      : (() => {
          try {
            const currencyExpression = draft.currency
              ? compileDelimitedMapping(draft.currency)
              : '""'
            return `{"amount": ${compileDelimitedMapping(draft.amount)}, "currency": ${currencyExpression}}`
          } catch {
            return t('ExpenseImport.mapping.currentMappingCannotCompile')
          }
        })()

  const mappingValidationError = useMemo(() => {
    try {
      validateDelimitedMoneyMapping(draft)
      return null
    } catch (error) {
      return error instanceof Error
        ? error.message
        : t('ExpenseImport.mapping.moneyInvalid')
    }
  }, [draft, t])

  const resetVisual = () => resetToVisual('simple')
  return (
    <ResponsiveDialog open onOpenChange={(open) => !open && onClose()}>
      <ResponsiveDialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-3xl">
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>
            {t('ExpenseImport.mapping.moneyMappingTitle')}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {t('ExpenseImport.mapping.moneyMappingDesc')}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="min-h-0 space-y-5 overflow-y-auto">
          <MappingModeTabs mode={mode} onChange={switchMode} />
          {pendingResetMode ? (
            <Alert>
              <AlertCircle className="size-4" />
              <AlertTitle>
                {draft.mode === 'CEL'
                  ? t('ExpenseImport.mapping.resetVisualTitle')
                  : t('ExpenseImport.mapping.simplifyTitle')}
              </AlertTitle>
              <AlertDescription className="space-y-3">
                {draft.mode === 'CEL'
                  ? t('ExpenseImport.mapping.codeResetBody')
                  : t('ExpenseImport.mapping.moneySimpleResetBody')}
                {draft.mode === 'VISUAL' && pendingResetMode === 'simple' ? (
                  <div className="grid gap-2 text-xs sm:grid-cols-2">
                    <div className="border-s ps-3">
                      <p className="font-medium">
                        {t('ExpenseImport.mapping.beforeLabel')}
                      </p>
                      <p className="text-muted-foreground">
                        {t('ExpenseImport.mapping.beforeBody')}
                      </p>
                    </div>
                    <div className="border-s ps-3">
                      <p className="font-medium">
                        {t('ExpenseImport.mapping.afterLabel')}
                      </p>
                      <p className="text-muted-foreground">
                        {t('ExpenseImport.mapping.moneyAfterBody')}
                      </p>
                    </div>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => resetToVisual(pendingResetMode)}
                  >
                    {draft.mode === 'CEL'
                      ? pendingResetMode === 'simple'
                        ? t('ExpenseImport.mapping.resetToSimple')
                        : t('ExpenseImport.mapping.resetToAdvanced')
                      : pendingResetMode === 'simple'
                        ? t('ExpenseImport.mapping.useSimple')
                        : t('ExpenseImport.mapping.useAdvanced')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setPendingResetMode(null)}
                  >
                    {draft.mode === 'CEL'
                      ? t('ExpenseImport.mapping.keepCode')
                      : mode === 'advanced'
                        ? t('ExpenseImport.mapping.keepAdvanced')
                        : t('ExpenseImport.mapping.keepSimple')}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}
          {mappingValidationError ? (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>
                {t('ExpenseImport.mapping.needsAttention')}
              </AlertTitle>
              <AlertDescription>{mappingValidationError}</AlertDescription>
            </Alert>
          ) : null}
          {mode === 'code' ? (
            <div className="space-y-3">
              {!codeEditing ? (
                <Alert>
                  <AlertCircle className="size-4" />
                  <AlertTitle>
                    {t('ExpenseImport.mapping.codePreviewTitle')}
                  </AlertTitle>
                  <AlertDescription>
                    {t('ExpenseImport.mapping.codePreviewBody')}
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert>
                  <AlertCircle className="size-4" />
                  <AlertTitle>
                    {t('ExpenseImport.mapping.codeOneWayTitle')}
                  </AlertTitle>
                  <AlertDescription>
                    {t('ExpenseImport.mapping.codeOneWayBody')}
                  </AlertDescription>
                </Alert>
              )}
              {codeEditing ? (
                <>
                  <Label htmlFor="money-mapping-cel">
                    {t('ExpenseImport.mapping.celLabel')}
                  </Label>
                  <Textarea
                    id="money-mapping-cel"
                    aria-label={t('ExpenseImport.mapping.celLabel')}
                    className="min-h-48 font-mono text-xs"
                    value={
                      draft.mode === 'CEL' ? draft.expression : generatedCode
                    }
                    onChange={(event) =>
                      setDraft({ mode: 'CEL', expression: event.target.value })
                    }
                  />
                </>
              ) : (
                <pre className="max-h-56 overflow-auto rounded-md bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap">
                  {generatedCode}
                </pre>
              )}
              {compileError ? (
                <p className="text-sm text-destructive">{compileError}</p>
              ) : null}
              {codeEditWarning ? (
                <Alert>
                  <AlertCircle className="size-4" />
                  <AlertTitle>
                    {t('ExpenseImport.mapping.useCodeTitle')}
                  </AlertTitle>
                  <AlertDescription className="space-y-3">
                    {t('ExpenseImport.mapping.useCodeBody')}
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" size="sm" onClick={confirmCodeEdit}>
                        {t('ExpenseImport.mapping.editWithCode')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setCodeEditWarning(false)}
                      >
                        {t('ExpenseImport.mapping.cancelButton')}
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              ) : null}
              {codeEditing ? (
                <Button type="button" variant="outline" onClick={resetVisual}>
                  {t('ExpenseImport.mapping.resetToVisual')}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setCodeEditWarning(true)}
                >
                  {t('ExpenseImport.mapping.editWithCode')}
                </Button>
              )}
            </div>
          ) : visual && mode === 'simple' ? (
            <SimpleMoneyMappingEditor
              table={table}
              mapping={visual}
              fixedCurrencyCode={fixedCurrencyCode}
              groupCurrencyCode={groupCurrencyCode}
              onFixedCurrencyChange={setFixedCurrencyCode}
              onChange={setDraft}
            />
          ) : visual ? (
            <div className="space-y-5">
              <section className="space-y-3 border-b pb-5 last:border-b-0">
                <div>
                  <h3 className="font-medium">
                    {t('ExpenseImport.mapping.amountHeading')}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {t('ExpenseImport.mapping.advAmountHint')}
                  </p>
                </div>
                <VisualPipelineEditor
                  table={table}
                  mapping={visual.amount}
                  fieldKind="amount"
                  simple={false}
                  onChange={(amount) => setDraft({ ...visual, amount })}
                />
              </section>
              <section className="space-y-3 border-b pb-5 last:border-b-0">
                <div>
                  <h3 className="font-medium">
                    {t('ExpenseImport.mapping.currencyHeading')}
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    {t('ExpenseImport.mapping.advCurrencyHint')}
                  </p>
                </div>
                <AdvancedCurrencyMappingEditor
                  table={table}
                  mapping={visual}
                  fixedCurrencyCode={fixedCurrencyCode}
                  groupCurrencyCode={groupCurrencyCode}
                  onFixedCurrencyChange={setFixedCurrencyCode}
                  onChange={setDraft}
                />
              </section>
            </div>
          ) : null}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('ExpenseImport.mapping.cancelButton')}
          </Button>
          <Button
            type="button"
            disabled={Boolean(mappingValidationError)}
            onClick={() => onSave(draft, fixedCurrencyCode)}
          >
            {t('ExpenseImport.mapping.saveMapping')}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
