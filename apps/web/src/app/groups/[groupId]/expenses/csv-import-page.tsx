import {
  getRouteApi,
  Link,
  useBlocker,
  useNavigate,
} from '@tanstack/react-router'
import { AlertCircle, Check, ChevronDown, Loader2, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { FileUploadCard } from '@/app/groups/import/file-upload-card'
import { useSyncedAccountPreferences } from '@/components/account-preferences-sync'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import {
  WizardNav,
  WizardProgress,
  WizardStepHeader,
} from '@/components/wizard'
import type { RuntimeFeatureFlags } from '@/lib/featureFlags'
import { useIdempotentCreate } from '@/lib/use-idempotent-create'
import { trpc } from '@/trpc/client'
import {
  getCategoryById,
  isSettlementCategory,
  type Expense,
  utcToWallTime,
  wallTimeToUtc,
} from '@spliit/domain'
import {
  analyzeDelimitedDateOrder,
  decodeDelimitedBytes,
  inferDelimitedExpenseMapping,
  remainingMoneyDetections,
  createImportTitleIndex,
  importCategorySourceKey,
  type ImportCategoryContext,
  type ImportDetection,
  type DelimitedColumn,
  type DelimitedEncoding,
  type DelimitedExpenseMappingV1,
  type DelimitedFieldMapping,
  type DelimitedMappedRow,
  type DelimitedPreviewRow,
  type DelimitedTable,
  type DelimitedVisualMapping,
  type ExpenseImportBatchDefaults,
} from '@spliit/domain/import'

import {
  BatchDefaultsCard,
  createBatchDefaults,
} from './csv-import-batch-defaults'
import {
  DetectionFeedback,
  MappingCard,
  MappingEditor,
  MoneyMappingCard,
  MoneyMappingEditor,
} from './csv-import-mapping-editors'
import { translateImportError } from './csv-import-messages'
import { duplicateReason, ReviewExpensesList } from './csv-import-review-list'
import {
  applyCategoryBindingAssignment,
  duplicateCheckSignature,
  preferredDateOrder,
  reviewStatusFor,
  sortReviewRows,
  type DraftRow,
  type DuplicateMatch,
  type MappingFieldKey,
  type MappingIssueField,
  type MappingKey,
  type ReviewFilter,
} from './csv-import-review-model'
import {
  COMPACT_PREVIEW_ROWS,
  issueSummary,
  MappedExpensesDialog,
  MappedPreview,
  RawPreview,
  SourceCategoryPreviewDialog,
  SourceFileDialog,
  type MappingPreviewStatus,
} from './csv-import-viewers'
import {
  inferExpenseFile,
  mapExpenseFile,
  parseExpenseFile,
  previewExpenseFile,
} from './csv-import-worker-client'
import { ExpenseForm } from './expense-form'
import {
  ImportCategoryMapping,
  categoryConfiguration,
  type CategoryAssignment,
  type CategoryConfiguration,
} from './import-category-mapping'

export {
  applyCategoryBindingAssignment,
  duplicateCheckSignature,
  fnv1aHash,
  hashPreviewLens,
  reviewStatusFor,
  sortReviewRows,
} from './csv-import-review-model'
export {
  DetectionFeedback,
  MappingCard,
  MappingEditor,
  MoneyMappingCard,
  MoneyMappingEditor,
} from './csv-import-mapping-editors'
export {
  MappedExpensesDialog,
  MappedPreview,
  RawPreview,
  SourceCategoryPreviewDialog,
  SourceFileDialog,
} from './csv-import-viewers'
export { ReviewExpensesList } from './csv-import-review-list'

const importRoute = getRouteApi('/groups/$groupId/tools/import')
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_FILE_ROWS = 10_000

const MOBILE_DESKTOP_NOTE_KEY = 'expense-import-desktop-note'

function hasDismissedDesktopNote() {
  if (typeof window === 'undefined') return false
  try {
    return (
      window.sessionStorage.getItem(MOBILE_DESKTOP_NOTE_KEY) === 'dismissed'
    )
  } catch {
    return false
  }
}

type Step = 'file' | 'mapping' | 'review' | 'done'

function visualMapping(column: DelimitedColumn): DelimitedVisualMapping {
  return {
    mode: 'VISUAL',
    sourceValues: [{ primary: column.key, fallbacks: [] }],
    transforms: [{ kind: 'TRIM' }],
  }
}

export function inferMapping(table: DelimitedTable, currencyCode: string) {
  return inferDelimitedExpenseMapping(table, currencyCode, preferredDateOrder())
    .mapping
}

function detectLocalTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

function hasAmbiguousDate(
  table: DelimitedTable,
  mapping: DelimitedFieldMapping | undefined,
) {
  if (!mapping || mapping.mode === 'CEL') return false
  const analysis = analyzeDelimitedDateOrder(table, mapping)
  return (
    analysis.status === 'MIXED' ||
    (analysis.status === 'AMBIGUOUS' && analysis.ambiguousRows.length > 0)
  )
}

function isConfirmedDateMapping(mapping: DelimitedFieldMapping): boolean {
  if (mapping.mode === 'CEL') return true
  return mapping.transforms.some(
    (transform) =>
      transform.kind === 'PARSE_DATE' &&
      transform.format !== 'AUTO_MDY' &&
      transform.format !== 'AUTO_DMY',
  )
}

function buildExpense(
  row: DelimitedMappedRow,
  options: {
    defaults: ExpenseImportBatchDefaults
    timeZone: string
    ledgerCurrencyCode: string
    fallbackTitle: string
  },
): Expense {
  let expenseDate = new Date('1970-01-01T12:00:00.000Z')
  try {
    expenseDate = wallTimeToUtc(
      row.expenseDate,
      row.expenseTimeMinutes,
      options.timeZone,
    )
  } catch {
    // Invalid rows remain reviewable but are never selected for import.
  }
  return {
    expenseDate,
    expenseTimeZone: options.timeZone,
    title: row.title || options.fallbackTitle,
    category: row.category,
    // A valid zero-cent row stays zero; only nullish amounts fall back.
    amount: row.amount ?? 1,
    ...(row.currency !== options.ledgerCurrencyCode
      ? { conversion: { type: 'exchange' as const, currency: row.currency } }
      : {}),
    paidBySplitMode:
      options.defaults.paidBy.mode === 'SINGLE'
        ? 'BY_AMOUNT'
        : options.defaults.paidBy.mode,
    paidByList:
      options.defaults.paidBy.mode === 'SINGLE'
        ? [
            {
              participant: options.defaults.paidBy.participantId,
              shares: row.amount ?? 1,
            },
          ]
        : options.defaults.paidBy.shares,
    isMultiPayer: options.defaults.paidBy.mode !== 'SINGLE',
    splitMode: options.defaults.paidFor.mode,
    paidFor: options.defaults.paidFor.shares,
    // New rows start without documents; full-form edits keep whole Expense objects including items/documents.
    documents: [],
    notes: row.notes ?? undefined,
    recurrenceRule: 'NONE',
  }
}

// Rebuild drafts on currency/timezone change; edited rows keep full-form overrides including items/documents.
export function rebuildDraftsForSettingsChange(
  current: DraftRow[],
  editedByRowNumber: Map<number, DraftRow>,
  options: {
    defaults: ExpenseImportBatchDefaults
    timeZone: string
    ledgerCurrencyCode: string
    fallbackTitle: string
  },
): DraftRow[] {
  return current.map((row) => {
    if (editedByRowNumber.has(row.mapped.rowNumber)) return row
    return {
      ...row,
      expense: buildExpense(row.mapped, options),
    }
  })
}

export function ExpenseFileImportPage({
  runtimeFeatureFlags,
}: {
  runtimeFeatureFlags: RuntimeFeatureFlags
}) {
  const { t } = useTranslation()
  const { groupId } = importRoute.useParams()
  const search = importRoute.useSearch()
  const navigate = useNavigate({ from: '/groups/$groupId/tools/import' })
  const accountPreferences = useSyncedAccountPreferences()
  const {
    data: groupData,
    error: groupError,
    isPending: groupPending,
  } = trpc.groups.get.useQuery({ groupId })
  const [step, setStep] = useState<Step>('file')
  const [fileName, setFileName] = useState('')
  const [fileBytes, setFileBytes] = useState<ArrayBuffer | null>(null)
  const [table, setTable] = useState<DelimitedTable | null>(null)
  const [mapping, setMapping] = useState<DelimitedExpenseMappingV1 | null>(null)
  const [mappedPreviewRows, setMappedPreviewRows] = useState<
    DelimitedPreviewRow[]
  >([])
  const [mappedPreviewFilter, setMappedPreviewFilter] = useState<
    'ALL' | 'ISSUES'
  >('ALL')
  const [mappedPreviewIssueField, setMappedPreviewIssueField] =
    useState<MappingIssueField | null>(null)
  const [delimiter, setDelimiter] = useState(',')
  const [headerRow, setHeaderRow] = useState(1)
  const [encoding, setEncoding] = useState<DelimitedEncoding>('UTF-8')
  const [detectedDelimiter, setDetectedDelimiter] = useState(',')
  const [detectedEncoding, setDetectedEncoding] =
    useState<Exclude<DelimitedEncoding, 'AUTO'>>('UTF-8')
  const delimiterLabelId = useId()
  const encodingLabelId = useId()
  const [batchDefaults, setBatchDefaults] =
    useState<ExpenseImportBatchDefaults | null>(null)
  const [drafts, setDrafts] = useState<DraftRow[]>([])
  // Mirror of the last committed drafts for event handlers, effects, and
  // async continuations that would otherwise close over a stale render
  // snapshot. Assigned in an effect (never during render); this effect is
  // declared before any reader effect, so it flushes first after commit.
  const draftsRef = useRef<DraftRow[]>([])
  useEffect(() => {
    draftsRef.current = drafts
  }, [drafts])
  const [editingField, setEditingField] = useState<MappingKey | null>(null)
  const [filter, setFilter] = useState<ReviewFilter>('ALL')
  const [overrideRowId, setOverrideRowId] = useState<string | null>(null)
  const [resultCount, setResultCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const editUrlNotice = Boolean(search.editRow)
  const [dateFormatConfirmed, setDateFormatConfirmed] = useState(false)
  const [isParsing, setIsParsing] = useState(false)
  const [headerRowDraft, setHeaderRowDraft] = useState<string | null>(null)
  const [settingsRecomputed, setSettingsRecomputed] = useState(false)
  const draftsSettingsRef = useRef<{
    currency: string
    timeZone: string
  } | null>(null)
  const [mappingPreviewStatus, setMappingPreviewStatus] =
    useState<MappingPreviewStatus>('initializing')
  const [mappingPreviewSignature, setMappingPreviewSignature] = useState<
    string | null
  >(null)
  const [mappingPreviewRetry, setMappingPreviewRetry] = useState(0)
  const [publishedSettings, setPublishedSettings] = useState<{
    fieldSignature: string | null
    categories: CategoryConfiguration
  } | null>(null)
  const [sourceViewerOpen, setSourceViewerOpen] = useState(false)
  const [mappedViewerOpen, setMappedViewerOpen] = useState(false)
  const [previewSourceKey, setPreviewSourceKey] = useState<string | null>(null)
  const [mobileNoteDismissed, setMobileNoteDismissed] = useState(
    hasDismissedDesktopNote,
  )
  const fileInput = useRef<HTMLInputElement>(null)
  const [isDraggingFile, setIsDraggingFile] = useState(false)
  const reviewScrollPosition = useRef(0)
  const lastEditTrigger = useRef<HTMLElement | null>(null)
  const parseRequest = useRef(0)
  const mappingPreviewRequest = useRef(0)
  const reviewRequest = useRef(0)
  const duplicateRequest = useRef(0)
  const [detections, setDetections] = useState<ImportDetection[]>([])
  const [inferredMapping, setInferredMapping] =
    useState<DelimitedExpenseMappingV1 | null>(null)
  const [categoryContext, setCategoryContext] = useState<ImportCategoryContext>(
    { suggestUnmatched: true },
  )
  const [historyUnavailable, setHistoryUnavailable] = useState(false)
  const historyRequest = useRef<{
    groupId: string
    promise: Promise<ImportCategoryContext['history']>
  } | null>(null)
  const editedRows = useRef(new Map<number, DraftRow>())
  const [categoryCopySource, setCategoryCopySource] = useState<{
    rowNumber: number
    title: string
    category: Expense['category']
  } | null>(null)
  const [categoryCopyOpen, setCategoryCopyOpen] = useState(false)
  const [categoryCopySelection, setCategoryCopySelection] = useState<
    Set<number>
  >(new Set())
  const importAttempt = useIdempotentCreate()
  const utils = trpc.useUtils()
  const importMutation = trpc.groups.expenses.importFile.useMutation()
  const duplicateMutation =
    trpc.groups.expenses.previewImportDuplicates.useMutation()

  // File-scoped decisions must reset the moment a (re)parse starts, not when
  // it finishes: otherwise choices made mid-parse are wiped by the late
  // response, and failed parses leave the previous file's decisions behind.
  const resetFileDecisions = () => {
    reviewRequest.current += 1
    duplicateRequest.current += 1
    reviewScrollPosition.current = 0
    editedRows.current.clear()
    draftsSettingsRef.current = null
    setSettingsRecomputed(false)
    setDetections([])
    setInferredMapping(null)
    setCategoryContext({ suggestUnmatched: true })
    setCategoryCopySource(null)
    setCategoryCopyOpen(false)
    setCategoryCopySelection(new Set())
    setDrafts([])
    setFilter('ALL')
    duplicateMutation.reset()
    setDuplicateReadySignature(null)
    setRequestedDuplicateSignature(null)
    setEditingField(null)
    setPreviewSourceKey(null)
    setSourceViewerOpen(false)
    setMappedViewerOpen(false)
    setOverrideRowId(null)
    setMappedPreviewRows([])
    setMappingPreviewSignature(null)
    setMappingPreviewStatus('initializing')
    setPublishedSettings(null)
    setMappedPreviewFilter('ALL')
    setMappedPreviewIssueField(null)
    setHeaderRowDraft(null)
    setError(null)
    setResultCount(0)
  }

  const group = groupData?.group
  const participants = useMemo(
    () => group?.participants.map(({ id, name }) => ({ id, name })) ?? [],
    [group?.participants],
  )
  const ledgerCurrencyCode = group?.currencyCode ?? 'USD'
  const localTimeZone = accountPreferences?.timeZone ?? detectLocalTimeZone()
  const effectiveBatchDefaults = useMemo(
    () =>
      batchDefaults ??
      createBatchDefaults(
        participants.map(({ id }) => id),
        groupData?.currentLedgerParticipantId || participants[0]?.id || '',
      ),
    [batchDefaults, participants, groupData?.currentLedgerParticipantId],
  )

  const batchDefaultsReady = (() => {
    const participantIds = new Set(participants.map(({ id }) => id))
    const validRows = (
      rows: Array<{ participant: string; shares: number }>,
      mode: 'EVENLY' | 'BY_SHARES' | 'BY_PERCENTAGE',
    ) => {
      if (
        !rows.length ||
        new Set(rows.map(({ participant }) => participant)).size !==
          rows.length ||
        rows.some(
          ({ participant, shares }) =>
            !participantIds.has(participant) ||
            !Number.isInteger(shares) ||
            shares <= 0,
        )
      )
        return false
      if (mode === 'BY_PERCENTAGE')
        return rows.reduce((sum, row) => sum + row.shares, 0) === 10_000
      return true
    }
    const paidBy = effectiveBatchDefaults.paidBy
    return (
      (paidBy.mode === 'SINGLE'
        ? participantIds.has(paidBy.participantId)
        : validRows(paidBy.shares, paidBy.mode)) &&
      validRows(
        effectiveBatchDefaults.paidFor.shares,
        effectiveBatchDefaults.paidFor.mode,
      )
    )
  })()

  useEffect(() => {
    if (
      !search.editRow ||
      drafts.some(({ mapped }) => mapped.rowId === search.editRow)
    )
      return
    void navigate({
      search: (previous) => ({ ...previous, editRow: undefined }),
      replace: true,
    })
  }, [drafts, navigate, search.editRow])

  const editRowId = search.editRow
  useEffect(() => {
    if (editRowId) return
    const trigger = lastEditTrigger.current
    if (!trigger) return
    lastEditTrigger.current = null
    const label = trigger.getAttribute('aria-label')
    const frame = requestAnimationFrame(() => {
      if (document.contains(trigger)) {
        trigger.focus()
        return
      }
      // The review list remounts for the full-page edit, so the stored button
      // is detached. Focus the remounted control for the same row instead,
      // scoped to the review list so a same-numbered control in another
      // dialog can never steal focus.
      if (label) {
        const fresh = document
          .getElementById('csv-import-review-list')
          ?.querySelector(`button[aria-label="${label}"]`) as HTMLElement | null
        fresh?.focus()
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [editRowId])

  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      Boolean(table && step !== 'done' && current.pathname !== next.pathname),
    enableBeforeUnload: () => Boolean(table && step !== 'done'),
    withResolver: true,
  })

  const parseBytes = async (
    bytes: ArrayBuffer,
    options: {
      delimiter: string
      headerRow: number
      encoding: DelimitedEncoding
    },
    requestId?: number,
  ): Promise<DelimitedTable | false> => {
    const request = requestId ?? ++parseRequest.current
    setIsParsing(true)
    try {
      const parsed = await parseExpenseFile(bytes, {
        encoding: options.encoding,
        headerRow: Math.max(0, options.headerRow - 1),
        ...(options.delimiter === 'AUTO'
          ? {}
          : { delimiter: options.delimiter }),
      })
      if (request !== parseRequest.current) return false
      if (!parsed.ok) {
        // The parser enforces the row cap without the actual count; enrich it
        // so the file-error Alert names both the limit and the file's rows.
        if (
          parsed.error.includes('more than') &&
          parsed.error.includes('rows')
        ) {
          try {
            const { text } = decodeDelimitedBytes(bytes, options.encoding)
            const approxRows =
              text.split(/\r?\n/).filter((line) => line.trim()).length - 1
            if (approxRows > MAX_FILE_ROWS) {
              throw new Error(
                t('ExpenseImport.wizard.fileTooLarge', {
                  max: MAX_FILE_ROWS.toLocaleString(),
                  found: approxRows.toLocaleString(),
                }),
              )
            }
          } catch (rowLimitError) {
            if (
              rowLimitError instanceof Error &&
              rowLimitError.message.includes('found')
            )
              throw rowLimitError
          }
        }
        throw new Error(parsed.error, {
          // Carry the stable code through the throw so the catch below can
          // translate it (`ExpenseImport.parseErrors.<code>`) with fallback
          // to this English message.
          cause: { code: parsed.code, params: parsed.params ?? {} },
        })
      }
      if (parsed.table.rows.length > MAX_FILE_ROWS) {
        throw new Error(
          t('ExpenseImport.wizard.fileTooLarge', {
            max: MAX_FILE_ROWS.toLocaleString(),
            found: parsed.table.rows.length.toLocaleString(),
          }),
        )
      }
      const inference = await inferExpenseFile(
        parsed.table,
        ledgerCurrencyCode,
        preferredDateOrder(),
      )
      if (request !== parseRequest.current) return false
      const inferred = inference.mapping
      setDetections(inference.detections)
      setInferredMapping(inference.mapping)
      setTable(parsed.table)
      setMapping(inferred)
      // A successful parse publishes a new table: invalidate any in-flight
      // review built from the previous file so it can never navigate with
      // old rows. Reviews already guard on parseRequest, but a review started
      // mid-parse captures the new counter and would otherwise slip through.
      reviewRequest.current += 1
      setCategoryCopySource(null)
      // File decisions were already reset synchronously when the parse
      // started; only merge history below without dropping mid-parse choices.
      if (
        !historyRequest.current ||
        historyRequest.current.groupId !== groupId
      ) {
        const pending = utils.groups.expenses.categoryMemory
          .fetch({ groupId }, { staleTime: Infinity, retry: false })
          .then((result) => {
            setHistoryUnavailable(false)
            return result.expenses
          })
          .catch(() => {
            // Do not cache the failure: a transient offline blip on the first
            // file must not disable suggestions for every later file.
            if (historyRequest.current?.promise === pending)
              historyRequest.current = null
            setHistoryUnavailable(true)
            return []
          })
        historyRequest.current = { groupId, promise: pending }
      }
      const history = await historyRequest.current.promise
      if (request !== parseRequest.current) return false
      const locale = document.documentElement.lang || navigator.language
      // History can arrive after the user already toggled suggestion settings
      // or ignored a source label for this file. Merge it in without dropping
      // those choices.
      setCategoryContext((current) => ({
        ...current,
        history,
        locale: current.locale ?? locale,
      }))
      setDateFormatConfirmed(
        !hasAmbiguousDate(parsed.table, inferred.mappings.dateTime),
      )
      setMappedPreviewRows([])
      setMappingPreviewSignature(null)
      setMappingPreviewStatus('initializing')
      setMappedPreviewFilter('ALL')
      setMappedPreviewIssueField(null)
      setDrafts([])
      return parsed.table
    } finally {
      if (request === parseRequest.current) setIsParsing(false)
    }
  }

  const chooseFile = async (file: File) => {
    setError(null)
    const compatible =
      /\.(csv|tsv|txt)$/i.test(file.name) || file.type.startsWith('text/')
    if (!compatible) return setError(t('ExpenseImport.wizard.invalidFileType'))
    if (file.size > MAX_FILE_BYTES)
      return setError(t('ExpenseImport.wizard.fileTooLargeBytes'))
    const request = ++parseRequest.current
    resetFileDecisions()
    try {
      const bytes = await file.arrayBuffer()
      const parsed = await parseBytes(
        bytes,
        {
          delimiter: 'AUTO',
          headerRow: 1,
          encoding: 'AUTO',
        },
        request,
      )
      if (!parsed) return
      setFileName(file.name)
      setFileBytes(bytes)
      setDelimiter(parsed.delimiter)
      setDetectedDelimiter(parsed.delimiter)
      setHeaderRow(1)
      setEncoding(parsed.encoding)
      setDetectedEncoding(parsed.encoding)
      setStep('file')
    } catch (fileError) {
      if (request !== parseRequest.current) return
      setError(
        translateImportError(
          fileError,
          t,
          t('ExpenseImport.wizard.fileParseFailed'),
        ),
      )
    }
  }

  const reparse = async (
    options: Partial<{
      delimiter: string
      headerRow: number
      encoding: DelimitedEncoding
    }> = {},
  ) => {
    if (!fileBytes) return
    const request = ++parseRequest.current
    resetFileDecisions()
    const previous = { delimiter, headerRow, encoding }
    const next = {
      delimiter: options.delimiter ?? delimiter,
      headerRow: options.headerRow ?? headerRow,
      encoding: options.encoding ?? encoding,
    }
    setError(null)
    try {
      const parsed = await parseBytes(fileBytes, next, request)
      if (!parsed) return
      // Keep controls synchronized with the parser's concrete values. This is
      // especially important when a user selects a header beyond the file's
      // available rows and the parser clamps it.
      setDelimiter(parsed.delimiter)
      setHeaderRow(parsed.headerRow + 1)
      setEncoding(parsed.encoding)
    } catch (parseError) {
      if (request !== parseRequest.current) return
      // Do not leave a failed setting displayed beside the previous table.
      setDelimiter(previous.delimiter)
      setHeaderRow(previous.headerRow)
      setEncoding(previous.encoding)
      setError(
        translateImportError(
          parseError,
          t,
          t('ExpenseImport.wizard.fileParseFailed'),
        ),
      )
    }
  }

  const previewFieldSignature = useMemo(() => {
    if (!mapping || !table) return null
    const { categoryBindings: _bindings, defaults, ...fields } = mapping
    const { categoryId: _category, ...fieldDefaults } = defaults
    return JSON.stringify({
      fields,
      defaults: fieldDefaults,
      dateFormatConfirmed,
      parsing: {
        delimiter: table.delimiter,
        headerRow: table.headerRow,
        encoding: table.encoding,
      },
    })
  }, [mapping, table, dateFormatConfirmed])

  const previewMappingSignature = useMemo(
    () =>
      table && mapping
        ? JSON.stringify({
            mapping,
            dateFormatConfirmed,
            categoryContext,
            parsing: {
              delimiter: table.delimiter,
              headerRow: table.headerRow,
              encoding: table.encoding,
            },
          })
        : null,
    [dateFormatConfirmed, mapping, table, categoryContext],
  )

  useEffect(() => {
    if (
      step !== 'mapping' ||
      !table ||
      !mapping ||
      !previewMappingSignature ||
      mappingPreviewSignature === previewMappingSignature ||
      // Stay errored until the user retries: a failure clears the signature
      // (null vs preview), which would otherwise retrigger an immediate
      // auto-retry loop. Manual retry flips status to initializing and bumps
      // the retry nonce to run again.
      mappingPreviewStatus === 'error'
    )
      return
    // Debounce rapid mapping edits so a burst of keystrokes issues one
    // preview instead of cloning the full table per change. The very first
    // preview after a file load runs immediately so the mapping step does not
    // idle with a spinner.
    const delayMs = mappingPreviewSignature === null ? 0 : 200
    const cancelled = { current: false }
    let request = 0
    const timer = setTimeout(() => {
      request = ++mappingPreviewRequest.current
      const run = async () => {
        const finalRows = await previewExpenseFile(table, mapping, {
          includeAmbiguousDateIssue: !dateFormatConfirmed,
          preferredDateOrder: preferredDateOrder(),
          categories: categoryContext,
        })
        if (cancelled.current || request !== mappingPreviewRequest.current)
          return
        setMappedPreviewRows(
          finalRows.map((row) => {
            const edited = editedRows.current.get(row.rowNumber)
            return edited ? { ...row, ...edited.mapped, rowId: row.rowId } : row
          }),
        )
        setMappingPreviewSignature(previewMappingSignature)
        setPublishedSettings({
          fieldSignature: previewFieldSignature,
          categories: categoryConfiguration(mapping, categoryContext),
        })
        setError(null)
        setMappingPreviewStatus('ready')
      }

      void run().catch((previewError) => {
        if (cancelled.current || request !== mappingPreviewRequest.current)
          return
        setMappingPreviewStatus('error')
        setMappingPreviewSignature(null)
        setError(
          translateImportError(
            previewError,
            t,
            t('ExpenseImport.wizard.mappingPreviewFailed'),
          ),
        )
      })
    }, delayMs)

    return () => {
      cancelled.current = true
      clearTimeout(timer)
      // Invalidate an in-flight worker when the file, mapping, or step changes.
      // A late response must never repopulate a preview for a newer file.
      mappingPreviewRequest.current += 1
    }
  }, [
    dateFormatConfirmed,
    groupId,
    mapping,
    mappingPreviewRetry,
    mappingPreviewSignature,
    mappingPreviewStatus,
    previewMappingSignature,
    previewFieldSignature,
    step,
    categoryContext,
    table,
    t,
  ])

  const mappingPreviewDisplayStatus: MappingPreviewStatus =
    mappingPreviewStatus === 'error'
      ? 'error'
      : mappingPreviewStatus === 'ready' &&
          mappingPreviewSignature !== previewMappingSignature
        ? 'updating'
        : mappingPreviewStatus
  const currentPreviewRows = mappedPreviewRows
  // Keep published values visible during category-only changes. Review still
  // waits for the current worker generation.
  const mappingPresentationStatus =
    mappingPreviewDisplayStatus === 'updating' &&
    publishedSettings?.fieldSignature === previewFieldSignature
      ? 'ready'
      : mappingPreviewDisplayStatus

  const changeCategoryAssignment = (
    key: string,
    assignment: CategoryAssignment,
  ) => {
    setCategoryContext((current) => {
      const ignored = current.ignoredSources ?? []
      if ((assignment.mode === 'title') === ignored.includes(key))
        return current
      return {
        ...current,
        ignoredSources:
          assignment.mode === 'title'
            ? [...ignored, key]
            : ignored.filter((source) => source !== key),
      }
    })
    setMapping((current) =>
      applyCategoryBindingAssignment(current, key, assignment),
    )
  }
  const categoryPreviewIssues = useMemo(
    () =>
      currentPreviewRows.flatMap((row) =>
        row.issues.filter(({ field }) => field === 'category'),
      ),
    [currentPreviewRows],
  )
  const previewSource = useMemo(() => {
    if (!previewSourceKey || !mapping) return null
    const rows = currentPreviewRows.filter(
      (row) =>
        row.categorySource &&
        importCategorySourceKey(row.categorySource) === previewSourceKey,
    )
    const source =
      rows.find((row) => row.categorySource?.trim())?.categorySource?.trim() ??
      previewSourceKey
    const titleMode = (categoryContext.ignoredSources ?? []).includes(
      previewSourceKey,
    )
    const detectedCategory = rows.find(
      (row) => row.categoryProvenance === 'source',
    )?.category
    const categoryId =
      mapping.categoryBindings[previewSourceKey] ??
      detectedCategory ??
      mapping.defaults.categoryId
    return { key: previewSourceKey, source, titleMode, categoryId, rows }
  }, [previewSourceKey, currentPreviewRows, mapping, categoryContext])

  const categoryCopyCandidates = useMemo(() => {
    if (
      !categoryCopySource ||
      isSettlementCategory(categoryCopySource.category) ||
      categoryCopySource.category === 'income'
    )
      return []
    const eligible = drafts.filter(
      (row) =>
        row.mapped.rowNumber !== categoryCopySource.rowNumber &&
        row.expense.category !== categoryCopySource.category &&
        row.expense.amount >= 0 &&
        !isSettlementCategory(row.expense.category) &&
        !categoryContext.explicitRows?.[row.mapped.rowNumber] &&
        !(
          row.mapped.categorySource &&
          mapping?.categoryBindings[
            importCategorySourceKey(row.mapped.categorySource)
          ]
        ),
    )
    const matches = createImportTitleIndex(
      eligible,
      (row) => row.expense.title,
    )(categoryCopySource.title)
    return [
      ...matches.exact.map((row) => ({ row, exact: true })),
      ...matches.fuzzy.map((row) => ({ row, exact: false })),
    ]
  }, [categoryCopySource, drafts, categoryContext.explicitRows, mapping])

  const startReview = async () => {
    if (
      mappingPreviewDisplayStatus !== 'ready' ||
      isParsing ||
      !table ||
      !mapping ||
      !batchDefaultsReady
    )
      return
    // Guard against slow mappings resolving after a file change (or a second
    // click superseding the first): stale results must not overwrite the new
    // file's drafts or navigate to review.
    const review = ++reviewRequest.current
    const parse = parseRequest.current
    const tableSnapshot = table
    setError(null)
    try {
      const mappedRows = await mapExpenseFile(table, mapping, categoryContext, {
        preferredDateOrder: preferredDateOrder(),
      })
      if (
        review !== reviewRequest.current ||
        parse !== parseRequest.current ||
        tableSnapshot !== table
      )
        return
      const previousByRow = new Map(
        draftsRef.current.map((row) => [row.mapped.rowNumber, row]),
      )
      const nextDrafts = mappedRows.map((mapped) => {
        const edited = editedRows.current.get(mapped.rowNumber)
        if (edited) {
          const current = previousByRow.get(mapped.rowNumber) ?? edited
          return {
            ...current,
            mapped: {
              ...current.mapped,
              source: mapped.source,
              externalId: mapped.externalId,
              sourceAccount: mapped.sourceAccount,
            },
          }
        }
        return {
          mapped,
          expense: buildExpense(mapped, {
            defaults: effectiveBatchDefaults,
            timeZone: localTimeZone,
            ledgerCurrencyCode,
            fallbackTitle: t('ExpenseImport.wizard.invalidRowTitle'),
          }),
          selected: !mapped.error,
          approvedDuplicateKeys: [],
        }
      })
      if (nextDrafts.every((row) => row.mapped.error))
        throw new Error(t('ExpenseImport.wizard.noValidExpenses'))
      setDrafts(nextDrafts)
      draftsSettingsRef.current = {
        currency: ledgerCurrencyCode,
        timeZone: localTimeZone,
      }
      setSettingsRecomputed(false)
      duplicateMutation.reset()
      setDuplicateReadySignature(null)
      setRequestedDuplicateSignature(null)
      setFilter('ALL')
      reviewScrollPosition.current = 0
      setStep('review')
    } catch (mappingError) {
      if (
        review !== reviewRequest.current ||
        parse !== parseRequest.current ||
        tableSnapshot !== table
      )
        return
      setError(
        translateImportError(
          mappingError,
          t,
          t('ExpenseImport.wizard.mappingFailed'),
        ),
      )
    }
  }

  const previewRows = useMemo(
    () =>
      drafts
        .filter(({ mapped }) => !mapped.error)
        .map(({ mapped, expense }) => ({
          rowId: mapped.rowId,
          rowNumber: mapped.rowNumber,
          source: mapped.source,
          // Preserve the optional provider identity for the server-side
          // duplicate check. Fingerprints remain the canonical replay keys;
          // these values only let the API match a bank transaction ID when a
          // source mapping supplied one.
          externalId: mapped.externalId,
          sourceAccount: mapped.sourceAccount,
          expense,
        })),
    [drafts],
  )
  const previewSignature = useMemo(
    () => duplicateCheckSignature(previewRows, ledgerCurrencyCode),
    [previewRows, ledgerCurrencyCode],
  )
  const [duplicateReadySignature, setDuplicateReadySignature] = useState<
    string | null
  >(null)
  // Snapshot of the signature the in-flight (or last completed) duplicate
  // request was sent with. Deliberately state, not derived from
  // duplicateMutation.variables with live values: recomputing with a
  // mid-review group-currency change would make requested and preview look
  // equal without ever sending a check for the new currency, leaving the
  // import disabled with no spinner and no error.
  const [requestedDuplicateSignature, setRequestedDuplicateSignature] =
    useState<string | null>(null)
  useEffect(() => {
    if (
      step !== 'review' ||
      !previewRows.length ||
      requestedDuplicateSignature === previewSignature
    )
      return
    // Concurrent checks can resolve out of order; only the latest response
    // may touch drafts, approvals, and the ready signature.
    const request = ++duplicateRequest.current
    const sentSignature = previewSignature
    setRequestedDuplicateSignature(sentSignature)
    duplicateMutation.mutate(
      { groupId, rows: previewRows },
      {
        onSuccess: ({ rows }) => {
          if (request !== duplicateRequest.current) return
          setDuplicateReadySignature(sentSignature)
          const matchesByRow = new Map(
            rows.map((row) => [row.rowId, row.matches]),
          )
          setDrafts((current) =>
            current.map((row) => {
              const matches = matchesByRow.get(row.mapped.rowId) ?? []
              const approved = new Set(row.approvedDuplicateKeys)
              return matches.length &&
                matches.some(({ key }) => !approved.has(key))
                ? { ...row, selected: false }
                : row
            }),
          )
        },
        onError: () => {
          if (request !== duplicateRequest.current) return
          setDuplicateReadySignature(null)
        },
      },
    )
  }, [
    duplicateMutation,
    groupId,
    previewRows,
    previewSignature,
    requestedDuplicateSignature,
    step,
  ])

  const duplicateByRow = useMemo(
    () =>
      new Map(
        (duplicateMutation.data?.rows ?? []).map((row) => [
          row.rowId,
          row.matches as DuplicateMatch[],
        ]),
      ),
    [duplicateMutation.data?.rows],
  )
  const duplicateCheckReady = Boolean(
    duplicateMutation.data &&
    duplicateReadySignature === previewSignature &&
    !duplicateMutation.error,
  )

  const statusFor = (row: DraftRow) =>
    reviewStatusFor(
      row.mapped,
      duplicateByRow.get(row.mapped.rowId)?.length ?? 0,
    )
  const filteredDrafts = useMemo(() => {
    const getStatus = (row: DraftRow) =>
      reviewStatusFor(
        row.mapped,
        duplicateByRow.get(row.mapped.rowId)?.length ?? 0,
      )
    return sortReviewRows(
      drafts.filter((row) => filter === 'ALL' || getStatus(row) === filter),
      getStatus,
    )
  }, [drafts, filter, duplicateByRow])
  const selectedRows = drafts.filter((row) => row.selected && !row.mapped.error)
  const ambiguousDate = Boolean(
    table && mapping && hasAmbiguousDate(table, mapping.mappings.dateTime),
  )
  // Inline reasons for disabled continue actions: the distant Alerts explain,
  // but the buttons themselves must say what is missing.
  const fileBlockers = (
    [
      !table ? t('ExpenseImport.wizard.blockerFileParsed') : null,
      isParsing ? t('ExpenseImport.wizard.blockerFileParsing') : null,
    ] as (string | null)[]
  ).filter((blocker): blocker is string => Boolean(blocker))
  const reviewBlockers = (
    [
      isParsing ? t('ExpenseImport.wizard.blockerFileParsing') : null,
      mappingPreviewDisplayStatus !== 'ready'
        ? t('ExpenseImport.wizard.blockerMappedUpdating')
        : null,
      !batchDefaultsReady
        ? t('ExpenseImport.wizard.blockerDefaultsComplete')
        : null,
      detections.some((entry) => entry.requiresConfirmation)
        ? t('ExpenseImport.wizard.blockerConfirmations')
        : null,
      ambiguousDate && !dateFormatConfirmed
        ? t('ExpenseImport.wizard.blockerDateConfirmed')
        : null,
    ] as (string | null)[]
  ).filter((blocker): blocker is string => Boolean(blocker))
  const importBlockers = (
    [
      !selectedRows.length
        ? t('ExpenseImport.wizard.blockerExpenseSelected')
        : null,
      !duplicateCheckReady
        ? t('ExpenseImport.wizard.blockerDuplicateCheck')
        : null,
    ] as (string | null)[]
  ).filter((blocker): blocker is string => Boolean(blocker))
  // Currency and timezone are baked into drafts at review time. Recompute them
  // when either changes mid-review so commit never uses stale conversion or
  // dates; edited rows stay pinned to their full-form overrides.
  useEffect(() => {
    if (step !== 'review' || draftsRef.current.length === 0) return
    const baseline = draftsSettingsRef.current
    if (!baseline) {
      draftsSettingsRef.current = {
        currency: ledgerCurrencyCode,
        timeZone: localTimeZone,
      }
      return
    }
    if (
      baseline.currency === ledgerCurrencyCode &&
      baseline.timeZone === localTimeZone
    )
      return
    const rebuilt = rebuildDraftsForSettingsChange(
      draftsRef.current,
      editedRows.current,
      {
        defaults: effectiveBatchDefaults,
        timeZone: localTimeZone,
        ledgerCurrencyCode,
        fallbackTitle: t('ExpenseImport.wizard.invalidRowTitle'),
      },
    )
    draftsSettingsRef.current = {
      currency: ledgerCurrencyCode,
      timeZone: localTimeZone,
    }
    setDrafts(rebuilt)
    duplicateMutation.reset()
    setDuplicateReadySignature(null)
    setRequestedDuplicateSignature(null)
    setSettingsRecomputed(true)
  }, [
    duplicateMutation,
    effectiveBatchDefaults,
    ledgerCurrencyCode,
    localTimeZone,
    step,
    t,
  ])
  const editingRow = search.editRow
    ? drafts.find(({ mapped }) => mapped.rowId === search.editRow)
    : undefined
  const overrideRow = overrideRowId
    ? drafts.find(({ mapped }) => mapped.rowId === overrideRowId)
    : undefined

  const setSelected = (row: DraftRow, selected: boolean) => {
    if (selected && (duplicateByRow.get(row.mapped.rowId)?.length ?? 0) > 0) {
      setOverrideRowId(row.mapped.rowId)
      return
    }
    setDrafts((current) =>
      current.map((candidate) =>
        candidate.mapped.rowId === row.mapped.rowId
          ? { ...candidate, selected }
          : candidate,
      ),
    )
  }

  const commit = async () => {
    if (!selectedRows.length)
      return setError(t('ExpenseImport.wizard.selectExpense'))
    if (!duplicateCheckReady)
      return setError(t('ExpenseImport.wizard.waitDuplicate'))
    setError(null)
    try {
      const result = await importAttempt.run((requestId) =>
        importMutation.mutateAsync({
          requestId,
          groupId,
          rows: selectedRows.map(
            ({ mapped, expense, approvedDuplicateKeys }) => ({
              rowId: mapped.rowId,
              rowNumber: mapped.rowNumber,
              source: mapped.source,
              externalId: mapped.externalId,
              sourceAccount: mapped.sourceAccount,
              expense,
              approvedDuplicateKeys,
            }),
          ),
        }),
      )
      if (!result) return
      setResultCount(result.importedCount)
      setStep('done')
      await Promise.all([
        utils.groups.expenses.list.invalidate({ groupId }),
        utils.groups.balances.list.invalidate({ groupId }),
        utils.groups.activities.list.invalidate({ groupId }),
        utils.groups.get.invalidate({ groupId }),
      ])
    } catch (commitError) {
      duplicateMutation.reset()
      setDuplicateReadySignature(null)
      setRequestedDuplicateSignature(null)
      // tRPC failures carry a stable `data.importCode` (forwarded by the API
      // error formatter) translated via `ExpenseImport.apiErrors.<code>`;
      // anything else falls back to the English message.
      setError(
        translateImportError(
          commitError,
          t,
          t('ExpenseImport.wizard.importFailed'),
        ),
      )
    }
  }

  if (groupPending) {
    return (
      <Card>
        <CardContent className="flex items-center gap-3 p-8 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          {t('ExpenseImport.wizard.loadingGroup')}
        </CardContent>
      </Card>
    )
  }
  if (groupError || !group) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertTitle>
          {t('ExpenseImport.wizard.groupUnavailableTitle')}
        </AlertTitle>
        <AlertDescription>
          {groupError?.message ??
            t('ExpenseImport.wizard.groupUnavailableFallback')}
        </AlertDescription>
      </Alert>
    )
  }
  if (!groupData.viewer?.canMutate || group.archived) {
    return (
      <Alert>
        <AlertCircle className="size-4" />
        <AlertTitle>
          {t('ExpenseImport.wizard.importUnavailableTitle')}
        </AlertTitle>
        <AlertDescription>
          {group.archived
            ? t('ExpenseImport.wizard.archivedMessage')
            : t('ExpenseImport.wizard.notMemberMessage')}
        </AlertDescription>
      </Alert>
    )
  }
  if (!group.currencyCode) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertTitle>
          {t('ExpenseImport.wizard.currencyRequiredTitle')}
        </AlertTitle>
        <AlertDescription>
          {t('ExpenseImport.wizard.currencyRequiredDescription')}
        </AlertDescription>
      </Alert>
    )
  }

  if (editingRow) {
    return (
      <ExpenseForm
        key={editingRow.mapped.rowId}
        group={group}
        draftExpense={editingRow.expense}
        heading={t('ExpenseImport.wizard.editRowHeading', {
          rowNumber: editingRow.mapped.rowNumber,
        })}
        cancelLink={{
          to: '/groups/$groupId/tools/import',
          params: { groupId },
          search: { ...search, editRow: undefined },
        }}
        currentLedgerParticipantId={groupData.currentLedgerParticipantId}
        onSubmit={async (expense) => {
          setCategoryContext((current) => ({
            ...current,
            explicitRows: {
              ...current.explicitRows,
              [editingRow.mapped.rowNumber]: expense.category,
            },
            reviewedRows: {
              ...current.reviewedRows,
              [editingRow.mapped.rowNumber]: {
                title: expense.title,
                amount: expense.amount,
              },
            },
          }))
          if (expense.category !== editingRow.expense.category)
            setCategoryCopySource({
              rowNumber: editingRow.mapped.rowNumber,
              title: expense.title,
              category: expense.category,
            })
          const updatedDrafts = draftsRef.current.map((row) =>
            row.mapped.rowId === editingRow.mapped.rowId
              ? (() => {
                  const wallTime = utcToWallTime(
                    expense.expenseDate,
                    expense.expenseTimeZone,
                  )
                  const currency =
                    expense.conversion?.currency ?? ledgerCurrencyCode
                  const updated: DraftRow = {
                    ...row,
                    expense,
                    // Error rows can never be selected, so an edit (which
                    // always clears importer issues) makes the fixed row
                    // importable instead of silently leaving it out.
                    selected: row.mapped.error ? true : row.selected,
                    // The full form is authoritative for edited rows. Keep
                    // the source identity, but refresh the review values and
                    // clear importer issues that the user fixed manually.
                    mapped: {
                      ...row.mapped,
                      title: expense.title,
                      expenseDate: wallTime.dateIso,
                      expenseTimeMinutes: wallTime.timeMinutes,
                      amount: expense.amount,
                      currency,
                      category: expense.category,
                      categoryProvenance: 'manual',
                      notes: expense.notes ?? null,
                      issues: [],
                      warning: null,
                      error: null,
                    },
                  }
                  editedRows.current.set(row.mapped.rowNumber, updated)
                  return updated
                })()
              : row,
          )
          setDrafts(updatedDrafts)
          duplicateMutation.reset()
          setDuplicateReadySignature(null)
          setRequestedDuplicateSignature(null)
          return 'saved'
        }}
        onSaved={async () => {
          window.history.back()
        }}
        runtimeFeatureFlags={runtimeFeatureFlags}
      />
    )
  }

  const stepHeader = {
    file: {
      title: t('ExpenseImport.wizard.stepFileTitle'),
      description: t('ExpenseImport.wizard.stepFileDescription'),
    },
    mapping: {
      title: t('ExpenseImport.wizard.stepMappingTitle'),
      description: t('ExpenseImport.wizard.stepMappingDescription'),
    },
    review: {
      title: t('ExpenseImport.wizard.stepReviewTitle'),
      description: t('ExpenseImport.wizard.stepReviewDescription'),
    },
    done: {
      title: t('ExpenseImport.wizard.stepDoneTitle'),
      description: t('ExpenseImport.wizard.stepDoneDescription'),
    },
  }[step]

  return (
    <div
      className={`mx-auto flex w-full max-w-6xl min-w-0 flex-col gap-5 ${step === 'done' ? 'pb-8' : 'pb-24'}`}
    >
      <div>
        <WizardStepHeader
          eyebrow={t('ExpenseImport.wizard.eyebrow')}
          title={stepHeader.title}
          description={stepHeader.description}
          focusOnChange
        />
      </div>

      <WizardProgress
        steps={[
          { id: 'file', label: t('ExpenseImport.wizard.stepFileTitle') },
          { id: 'mapping', label: t('ExpenseImport.wizard.stepMappingTitle') },
          { id: 'review', label: t('ExpenseImport.wizard.progressReview') },
        ]}
        currentStep={step === 'done' ? 'review' : step}
        completed={step === 'done'}
        ariaLabel={t('ExpenseImport.wizard.progressAriaLabel')}
        className="w-full"
      />

      {!mobileNoteDismissed ? (
        <Alert className="relative pe-12 md:hidden">
          <AlertCircle className="size-4" />
          <AlertTitle>
            {t('ExpenseImport.wizard.desktopRecommendedTitle')}
          </AlertTitle>
          <AlertDescription>
            {t('ExpenseImport.wizard.desktopRecommendedDescription')}
          </AlertDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute end-2 top-2 size-9 text-muted-foreground hover:text-foreground"
            aria-label={t('ExpenseImport.wizard.dismissDesktopRecommendation')}
            onClick={() => {
              try {
                window.sessionStorage.setItem(
                  MOBILE_DESKTOP_NOTE_KEY,
                  'dismissed',
                )
              } catch {
                // Storage can be unavailable in private browsing; dismissal
                // still applies for this mounted wizard.
              }
              setMobileNoteDismissed(true)
            }}
          >
            <X className="size-5" strokeWidth={2.25} />
          </Button>
        </Alert>
      ) : null}

      {editUrlNotice ? (
        <Alert>
          <AlertCircle className="size-4" />
          <AlertTitle>
            {t('ExpenseImport.wizard.draftUnavailableTitle')}
          </AlertTitle>
          <AlertDescription>
            {t('ExpenseImport.wizard.draftUnavailableDescription')}
          </AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>{t('ExpenseImport.wizard.errorTitle')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {step === 'file' ? (
        <>
          <Input
            ref={fileInput}
            type="file"
            aria-label={t('ExpenseImport.wizard.fileInputLabel')}
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void chooseFile(file)
              event.target.value = ''
            }}
          />
          {!table ? (
            <>
              <FileUploadCard
                disabled={isParsing}
                isDragging={isDraggingFile}
                onDragOver={(event) => {
                  event.preventDefault()
                  if (!isParsing) setIsDraggingFile(true)
                }}
                onDragLeave={() => setIsDraggingFile(false)}
                onDrop={(event) => {
                  event.preventDefault()
                  setIsDraggingFile(false)
                  const file = event.dataTransfer.files?.[0]
                  if (file) void chooseFile(file)
                }}
                onFilesSelected={(files) => {
                  const file = files[0]
                  if (file) void chooseFile(file)
                }}
                accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
                labels={{
                  dropFile: t('ExpenseImport.wizard.dropFile'),
                  dropFileDescription: t(
                    'ExpenseImport.wizard.dropFileDescription',
                  ),
                }}
              />
              {isParsing ? (
                <output className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {t('ExpenseImport.wizard.parsingFile')}
                </output>
              ) : null}
            </>
          ) : (
            <Card className="min-w-0 overflow-hidden">
              <CardHeader className="gap-4">
                <div className="space-y-1.5">
                  <CardTitle>
                    {t('ExpenseImport.wizard.filePreviewTitle')}
                  </CardTitle>
                  <CardDescription>
                    {t('ExpenseImport.wizard.filePreviewDescription', {
                      fileName,
                      count: table.rows.length,
                    })}
                  </CardDescription>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isParsing}
                  onClick={() => fileInput.current?.click()}
                >
                  {t('ExpenseImport.wizard.chooseAnotherFile')}
                </Button>
              </CardHeader>
              <CardContent className="min-w-0 space-y-5">
                <RawPreview
                  table={table}
                  visibleRows={COMPACT_PREVIEW_ROWS}
                  onShowAll={() => setSourceViewerOpen(true)}
                />
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-2 text-sm">
                    <Label id={delimiterLabelId}>
                      {t('ExpenseImport.wizard.delimiterLabel')}
                      {detectedDelimiter ? (
                        <span className="ms-1 text-xs font-normal text-muted-foreground">
                          {t('ExpenseImport.wizard.delimiterDetectedAs', {
                            name:
                              detectedDelimiter === '\t'
                                ? t('ExpenseImport.wizard.delimiterNameTab')
                                : detectedDelimiter === ','
                                  ? t('ExpenseImport.wizard.delimiterNameComma')
                                  : detectedDelimiter === ';'
                                    ? t(
                                        'ExpenseImport.wizard.delimiterNameSemicolon',
                                      )
                                    : t(
                                        'ExpenseImport.wizard.delimiterNamePipe',
                                      ),
                          })}
                        </span>
                      ) : null}
                    </Label>
                    <Select
                      disabled={isParsing}
                      value={delimiter}
                      onValueChange={(nextDelimiter) => {
                        if (!nextDelimiter) return
                        void reparse({ delimiter: nextDelimiter })
                      }}
                    >
                      <SelectTrigger aria-labelledby={delimiterLabelId}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value=",">
                          {t('ExpenseImport.wizard.delimiterNameComma')}
                          {detectedDelimiter === ','
                            ? t('ExpenseImport.wizard.detectedSuffix')
                            : ''}
                        </SelectItem>
                        <SelectItem value=";">
                          {t('ExpenseImport.wizard.delimiterNameSemicolon')}
                          {detectedDelimiter === ';'
                            ? t('ExpenseImport.wizard.detectedSuffix')
                            : ''}
                        </SelectItem>
                        <SelectItem value={'\t'}>
                          {t('ExpenseImport.wizard.delimiterNameTab')}
                          {detectedDelimiter === '\t'
                            ? t('ExpenseImport.wizard.detectedSuffix')
                            : ''}
                        </SelectItem>
                        <SelectItem value="|">
                          {t('ExpenseImport.wizard.delimiterNamePipe')}
                          {detectedDelimiter === '|'
                            ? t('ExpenseImport.wizard.detectedSuffix')
                            : ''}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2 text-sm">
                    <Label htmlFor="import-header-row">
                      {t('ExpenseImport.wizard.headerRowLabel')}
                    </Label>
                    <Input
                      id="import-header-row"
                      type="number"
                      min={1}
                      disabled={isParsing}
                      value={headerRowDraft ?? String(headerRow)}
                      onChange={(event) => {
                        // Commit on blur/Enter instead of reparsing per
                        // keystroke.
                        setHeaderRowDraft(event.target.value)
                      }}
                      onBlur={(event) => {
                        if (headerRowDraft === null) return
                        const nextHeaderRow = Math.max(
                          1,
                          Number(event.target.value) || 1,
                        )
                        setHeaderRowDraft(null)
                        if (nextHeaderRow !== headerRow)
                          void reparse({ headerRow: nextHeaderRow })
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur()
                      }}
                    />
                  </div>
                  <div className="space-y-2 text-sm">
                    <Label id={encodingLabelId}>
                      {t('ExpenseImport.wizard.encodingLabel')}
                      <span className="ms-1 text-xs font-normal text-muted-foreground">
                        {t('ExpenseImport.wizard.encodingDetectedAs', {
                          encoding: detectedEncoding,
                        })}
                      </span>
                    </Label>
                    <Select
                      disabled={isParsing}
                      value={encoding}
                      onValueChange={(value) => {
                        if (!value) return
                        const nextEncoding = value as DelimitedEncoding
                        void reparse({ encoding: nextEncoding })
                      }}
                    >
                      <SelectTrigger aria-labelledby={encodingLabelId}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="UTF-8">
                          UTF-8
                          {detectedEncoding === 'UTF-8'
                            ? t('ExpenseImport.wizard.detectedSuffix')
                            : ''}
                        </SelectItem>
                        <SelectItem value="WINDOWS-1252">
                          Windows-1252
                          {detectedEncoding === 'WINDOWS-1252'
                            ? t('ExpenseImport.wizard.detectedSuffix')
                            : ''}
                        </SelectItem>
                        <SelectItem value="UTF-16">
                          UTF-16
                          {detectedEncoding === 'UTF-16'
                            ? t('ExpenseImport.wizard.detectedSuffix')
                            : ''}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
          <WizardNav
            back={{
              label: t('ExpenseImport.wizard.backToTools'),
              onClick: () =>
                void navigate({
                  to: '/groups/$groupId/tools',
                  params: { groupId },
                }),
            }}
            continue={{
              label: t('ExpenseImport.wizard.continueToMapping'),
              disabled: !table || isParsing,
              onClick: () => setStep('mapping'),
              describedBy: fileBlockers.length ? 'file-blockers' : undefined,
            }}
          />
          {fileBlockers.length ? (
            <output
              id="file-blockers"
              className="-mt-2 block text-sm text-muted-foreground"
            >
              {t('ExpenseImport.wizard.fileBlockersHint', {
                blockers: fileBlockers.join(', '),
              })}
            </output>
          ) : null}
        </>
      ) : null}

      {step === 'mapping' && table && mapping ? (
        <>
          <MappedPreview
            rows={mappedPreviewRows}
            status={mappingPresentationStatus}
            onViewSource={() => setSourceViewerOpen(true)}
            onViewAll={() => {
              setMappedPreviewFilter('ALL')
              setMappedPreviewIssueField(null)
              setMappedViewerOpen(true)
            }}
          />
          {mappingPreviewDisplayStatus === 'initializing' ||
          mappingPreviewDisplayStatus === 'error' ? (
            <Card>
              <CardContent className="flex flex-wrap items-center gap-3 py-8 text-sm text-muted-foreground">
                {mappingPreviewDisplayStatus === 'initializing' ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('ExpenseImport.wizard.preparingMappings')}
                  </>
                ) : (
                  <>
                    <span>
                      {t('ExpenseImport.wizard.mappingPreviewRetryHint')}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setMappingPreviewSignature(null)
                        setMappingPreviewStatus('initializing')
                        setError(null)
                        mappingPreviewRequest.current += 1
                        setMappingPreviewRetry((current) => current + 1)
                      }}
                    >
                      {t('ExpenseImport.wizard.retryPreview')}
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="space-y-3">
                <div>
                  <h2 className="text-lg font-semibold">
                    {t('ExpenseImport.wizard.requiredMappingsTitle')}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {t('ExpenseImport.wizard.requiredMappingsDescription')}
                  </p>
                </div>
                {(['dateTime', 'title'] as MappingFieldKey[]).map((field) => (
                  <MappingCard
                    key={field}
                    field={field}
                    table={table}
                    mapping={mapping.mappings[field]}
                    previewRows={currentPreviewRows}
                    dateConfirmationPending={
                      field === 'dateTime' &&
                      ambiguousDate &&
                      !dateFormatConfirmed
                    }
                    onConfirmDate={
                      field === 'dateTime'
                        ? () => setDateFormatConfirmed(true)
                        : undefined
                    }
                    isUpdating={mappingPresentationStatus === 'updating'}
                    onShowIssues={(issueField) => {
                      setMappedPreviewIssueField(issueField)
                      setMappedPreviewFilter('ISSUES')
                      setMappedViewerOpen(true)
                    }}
                    required
                    detectionFeedback={
                      <DetectionFeedback
                        entries={detections.filter(
                          (entry) => entry.field === field,
                        )}
                        onConfirm={() =>
                          setDetections((current) =>
                            current.filter((entry) => entry.field !== field),
                          )
                        }
                      />
                    }
                    onEdit={() => setEditingField(field)}
                  />
                ))}
                <MoneyMappingCard
                  table={table}
                  previewRows={currentPreviewRows}
                  defaultCurrencyCode={mapping.defaults.currencyCode}
                  onShowIssues={(issueField) => {
                    setMappedPreviewIssueField(issueField)
                    setMappedPreviewFilter('ISSUES')
                    setMappedViewerOpen(true)
                  }}
                  isUpdating={mappingPresentationStatus === 'updating'}
                  mapping={mapping.mappings.money}
                  detectionFeedback={
                    <DetectionFeedback
                      entries={detections.filter(
                        (entry) => entry.field === 'money',
                      )}
                      onConfirm={() =>
                        setDetections((current) =>
                          current.filter(
                            (entry) =>
                              entry.field !== 'money' ||
                              entry.candidates.length === 0,
                          ),
                        )
                      }
                    />
                  }
                  onEdit={() => setEditingField('money')}
                />
              </div>
              <Collapsible className="rounded-lg border bg-card">
                <CollapsibleTrigger className="group flex w-full cursor-pointer items-center justify-between px-4 py-4 text-start font-medium sm:px-6">
                  <span>
                    {t('ExpenseImport.wizard.optionalMappingsTitle')}
                    <span className="mt-0.5 block text-sm font-normal text-muted-foreground">
                      {t('ExpenseImport.wizard.optionalMappingsDescription')}
                    </span>
                  </span>
                  <ChevronDown className="size-4 transition-transform group-data-panel-open:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-3 border-t p-4 sm:p-6">
                  {(
                    [
                      'categorySource',
                      'notes',
                      'externalId',
                      'sourceAccount',
                    ] as MappingFieldKey[]
                  ).map((field) => (
                    <MappingCard
                      key={field}
                      field={field}
                      table={table}
                      mapping={mapping.mappings[field]}
                      previewRows={currentPreviewRows}
                      isUpdating={mappingPresentationStatus === 'updating'}
                      onShowIssues={(issueField) => {
                        setMappedPreviewIssueField(issueField)
                        setMappedPreviewFilter('ISSUES')
                        setMappedViewerOpen(true)
                      }}
                      onEdit={() => setEditingField(field)}
                      onRemove={() =>
                        setMapping((current) =>
                          current
                            ? {
                                ...current,
                                mappings: {
                                  ...current.mappings,
                                  [field]: undefined,
                                },
                              }
                            : current,
                        )
                      }
                    />
                  ))}
                </CollapsibleContent>
              </Collapsible>

              <ImportCategoryMapping
                mapping={mapping}
                context={categoryContext}
                rows={mappedPreviewRows}
                published={publishedSettings?.categories ?? null}
                updating={mappingPreviewDisplayStatus === 'updating'}
                historyUnavailable={historyUnavailable}
                onPreviewSource={setPreviewSourceKey}
                onSuggestUnmatched={(suggestUnmatched) =>
                  setCategoryContext((current) => ({
                    ...current,
                    suggestUnmatched,
                  }))
                }
                onFallbackChange={(categoryId) =>
                  setMapping((current) =>
                    current
                      ? {
                          ...current,
                          defaults: { ...current.defaults, categoryId },
                        }
                      : current,
                  )
                }
                onAssignment={changeCategoryAssignment}
              >
                {categoryPreviewIssues.length ? (
                  <Alert className="mt-4">
                    <AlertCircle className="size-4" />
                    <AlertTitle>
                      {t('ExpenseImport.wizard.categoryIssuesTitle', {
                        summary: issueSummary(categoryPreviewIssues, t),
                      })}
                    </AlertTitle>
                    <AlertDescription>
                      {t('ExpenseImport.wizard.categoryIssuesDescription')}
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        className="ms-1 h-auto p-0"
                        onClick={() => {
                          setMappedPreviewIssueField('category')
                          setMappedPreviewFilter('ISSUES')
                          setMappedViewerOpen(true)
                        }}
                      >
                        {t('ExpenseImport.wizard.inspectRows')}
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : null}
              </ImportCategoryMapping>

              <BatchDefaultsCard
                participants={participants}
                currencyCode={ledgerCurrencyCode}
                defaults={effectiveBatchDefaults}
                onDefaultsChange={setBatchDefaults}
              />
            </>
          )}
          <WizardNav
            back={{
              label: t('ExpenseImport.wizard.backToFile'),
              onClick: () => setStep('file'),
            }}
            continue={{
              label: t('ExpenseImport.wizard.stepReviewTitle'),
              disabled:
                isParsing ||
                mappingPreviewDisplayStatus !== 'ready' ||
                !batchDefaultsReady ||
                detections.some((entry) => entry.requiresConfirmation) ||
                (ambiguousDate && !dateFormatConfirmed),
              onClick: () => void startReview(),
              describedBy: reviewBlockers.length
                ? 'review-blockers'
                : undefined,
            }}
          />
          {reviewBlockers.length ? (
            <output
              id="review-blockers"
              className="-mt-2 block text-sm text-muted-foreground"
            >
              {t('ExpenseImport.wizard.reviewBlockersHint', {
                blockers: reviewBlockers.join(', '),
              })}
            </output>
          ) : null}
        </>
      ) : null}

      {step === 'review' ? (
        <>
          {settingsRecomputed ? (
            <Alert>
              <AlertCircle className="size-4" />
              <AlertTitle>
                {t('ExpenseImport.wizard.valuesRecomputedTitle')}
              </AlertTitle>
              <AlertDescription>
                {t('ExpenseImport.wizard.valuesRecomputedDescription')}
              </AlertDescription>
            </Alert>
          ) : null}
          {categoryCopySource && categoryCopyCandidates.length > 0 ? (
            <Alert>
              <AlertTitle>
                {t('ExpenseImport.wizard.applyCategoryTitle')}
              </AlertTitle>
              <AlertDescription>
                {t('ExpenseImport.wizard.matchingExpensesNotice', {
                  count: categoryCopyCandidates.length,
                })}
                <Button
                  type="button"
                  variant="link"
                  onClick={() => {
                    setCategoryCopySelection(
                      new Set(
                        categoryCopyCandidates
                          .filter((candidate) => candidate.exact)
                          .map((candidate) => candidate.row.mapped.rowNumber),
                      ),
                    )
                    setCategoryCopyOpen(true)
                  }}
                >
                  {t('ExpenseImport.wizard.chooseMatchingExpenses')}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
          <Card id="csv-import-review-list">
            <CardHeader>
              <CardTitle>{t('ExpenseImport.wizard.stepReviewTitle')}</CardTitle>
              <CardDescription>
                {t('ExpenseImport.wizard.reviewCardDescription')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    'ALL',
                    'READY',
                    'WARNINGS',
                    'DUPLICATES',
                    'ERRORS',
                  ] as ReviewFilter[]
                ).map((value) => {
                  const count = drafts.filter(
                    (row) => value === 'ALL' || statusFor(row) === value,
                  ).length
                  const label =
                    value === 'ALL'
                      ? t('ExpenseImport.wizard.filterAll', { count })
                      : value === 'READY'
                        ? t('ExpenseImport.wizard.filterReady', { count })
                        : value === 'WARNINGS'
                          ? t('ExpenseImport.wizard.filterWarnings', {
                              count,
                            })
                          : value === 'DUPLICATES'
                            ? t('ExpenseImport.wizard.filterDuplicates', {
                                count,
                              })
                            : t('ExpenseImport.wizard.filterErrors', {
                                count,
                              })
                  return (
                    <Button
                      key={value}
                      type="button"
                      size="sm"
                      variant={filter === value ? 'default' : 'outline'}
                      aria-pressed={filter === value}
                      onClick={() => setFilter(value)}
                    >
                      {label}
                    </Button>
                  )
                })}
              </div>
              {duplicateMutation.isPending ? (
                <output
                  aria-live="polite"
                  className="flex items-center gap-2 text-sm text-muted-foreground"
                >
                  <Loader2 className="size-4 animate-spin" />
                  {t('ExpenseImport.wizard.checkingDuplicates')}
                </output>
              ) : null}
              {duplicateMutation.error ? (
                <Alert variant="destructive">
                  <AlertCircle className="size-4" />
                  <AlertTitle>
                    {t('ExpenseImport.wizard.duplicateUnavailableTitle')}
                  </AlertTitle>
                  <AlertDescription className="flex flex-wrap items-center gap-3">
                    <span>
                      {t(
                        'ExpenseImport.wizard.duplicateUnavailableDescription',
                      )}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        duplicateMutation.reset()
                        setDuplicateReadySignature(null)
                        setRequestedDuplicateSignature(null)
                      }}
                    >
                      {t('ExpenseImport.wizard.retryDuplicateCheck')}
                    </Button>
                  </AlertDescription>
                </Alert>
              ) : null}

              <ReviewExpensesList
                rows={filteredDrafts}
                duplicateByRow={duplicateByRow}
                scrollPosition={reviewScrollPosition}
                scrollResetKey={filter}
                onSelectedChange={setSelected}
                onEdit={(row, trigger) => {
                  if (trigger) lastEditTrigger.current = trigger
                  void navigate({
                    search: (previous) => ({
                      ...previous,
                      editRow: row.mapped.rowId,
                    }),
                  })
                }}
              />
            </CardContent>
          </Card>
          <WizardNav
            back={{
              label: t('ExpenseImport.wizard.backToMapping'),
              onClick: () => setStep('mapping'),
            }}
            continue={{
              label: (
                <>
                  {importMutation.isPending ? (
                    <Loader2 className="me-2 size-4 animate-spin" />
                  ) : (
                    <Check className="me-2 size-4" />
                  )}
                  {t('ExpenseImport.wizard.importExpenses', {
                    count: selectedRows.length,
                  })}
                </>
              ),
              disabled:
                !selectedRows.length ||
                !duplicateCheckReady ||
                importMutation.isPending,
              onClick: () => void commit(),
              describedBy: importBlockers.length
                ? 'import-blockers'
                : undefined,
            }}
          />
          {!importMutation.isPending && importBlockers.length ? (
            <output
              id="import-blockers"
              className="-mt-2 block text-sm text-muted-foreground"
            >
              {t('ExpenseImport.wizard.importBlockersHint', {
                blockers: importBlockers.join(', '),
              })}
            </output>
          ) : null}
        </>
      ) : null}

      {step === 'done' ? (
        <Card className="overflow-hidden">
          <CardContent className="flex flex-col items-center gap-6 px-6 pt-10 pb-10 text-center sm:px-10 sm:pt-14 sm:pb-14">
            <div className="flex size-16 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Check className="size-7" />
            </div>
            <div className="max-w-2xl space-y-2">
              <h2 className="text-2xl font-semibold">
                {t('ExpenseImport.wizard.importedCount', {
                  count: resultCount,
                })}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t('ExpenseImport.wizard.doneCardDescription')}
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-3">
              <Button
                nativeButton={false}
                render={
                  <Link to="/groups/$groupId/expenses" params={{ groupId }} />
                }
              >
                {t('ExpenseImport.wizard.viewExpenses')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setStep('file')
                  setFileBytes(null)
                  setFileName('')
                  setTable(null)
                  setMapping(null)
                  setBatchDefaults(null)
                  setDateFormatConfirmed(false)
                  resetFileDecisions()
                }}
              >
                {t('ExpenseImport.wizard.importAnotherFile')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {editingField && table && mapping
        ? (() => {
            if (editingField === 'money') {
              return (
                <MoneyMappingEditor
                  table={table}
                  initialMapping={mapping.mappings.money}
                  defaultMapping={(inferredMapping ?? mapping).mappings.money}
                  defaultCurrencyCode={mapping.defaults.currencyCode}
                  groupCurrencyCode={ledgerCurrencyCode}
                  onClose={() => setEditingField(null)}
                  onSave={(nextMapping, currencyCode) => {
                    setDetections((current) =>
                      remainingMoneyDetections(current, nextMapping, table),
                    )
                    setMapping({
                      ...mapping,
                      mappings: { ...mapping.mappings, money: nextMapping },
                      defaults: { ...mapping.defaults, currencyCode },
                    })
                    setEditingField(null)
                  }}
                />
              )
            }
            const current = mapping.mappings[editingField]
            const fallback = visualMapping(table.columns[0]!)
            const inferred = (inferredMapping ?? mapping).mappings[editingField]
            const defaultMapping =
              inferred?.mode === 'VISUAL' ? inferred : fallback
            return (
              <MappingEditor
                field={editingField}
                table={table}
                mappingDocument={mapping}
                initialMapping={current ?? defaultMapping}
                defaultMapping={defaultMapping}
                previewRows={currentPreviewRows}
                onClose={() => setEditingField(null)}
                onSave={(nextMapping) => {
                  setDetections((current) =>
                    current.filter((entry) => entry.field !== editingField),
                  )
                  setMapping({
                    ...mapping,
                    mappings: {
                      ...mapping.mappings,
                      [editingField]: nextMapping,
                    },
                  })
                  if (editingField === 'dateTime') {
                    setDateFormatConfirmed(
                      isConfirmedDateMapping(nextMapping) ||
                        (table ? !hasAmbiguousDate(table, nextMapping) : false),
                    )
                  }
                  setEditingField(null)
                }}
              />
            )
          })()
        : null}

      <ResponsiveDialog
        open={categoryCopyOpen}
        onOpenChange={setCategoryCopyOpen}
      >
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              {t('ExpenseImport.wizard.applyCategoryTitle')}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {t('ExpenseImport.wizard.categoryDialogDescription')}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody>
            <div className="max-h-[50vh] space-y-3 overflow-y-auto">
              {categoryCopyCandidates.map(({ row, exact }) => (
                <Label
                  key={row.mapped.rowId}
                  className="flex items-start gap-3 border-b py-3"
                >
                  <Checkbox
                    checked={categoryCopySelection.has(row.mapped.rowNumber)}
                    onCheckedChange={(checked) =>
                      setCategoryCopySelection((current) => {
                        const next = new Set(current)
                        if (checked) next.add(row.mapped.rowNumber)
                        else next.delete(row.mapped.rowNumber)
                        return next
                      })
                    }
                  />
                  <span>
                    <span className="block">
                      {t('ExpenseImport.wizard.categoryRowLabel', {
                        title: row.expense.title,
                        rowNumber: row.mapped.rowNumber,
                      })}
                    </span>
                    <span className="block text-sm font-normal text-muted-foreground">
                      {getCategoryById(row.expense.category)?.name} →{' '}
                      {categoryCopySource &&
                        getCategoryById(categoryCopySource.category)?.name}{' '}
                      ·{' '}
                      {exact
                        ? t('ExpenseImport.wizard.exactTitle')
                        : t('ExpenseImport.wizard.similarTitle')}
                    </span>
                  </span>
                </Label>
              ))}
            </div>
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button variant="ghost" onClick={() => setCategoryCopyOpen(false)}>
              {t('ExpenseImport.wizard.cancel')}
            </Button>
            <Button
              disabled={!categoryCopySelection.size}
              onClick={() => {
                if (!categoryCopySource) return
                const category = categoryCopySource.category
                const eligible = new Set(
                  categoryCopyCandidates.map(
                    (candidate) => candidate.row.mapped.rowNumber,
                  ),
                )
                const nextDrafts = draftsRef.current.map((row) => {
                  if (
                    !categoryCopySelection.has(row.mapped.rowNumber) ||
                    !eligible.has(row.mapped.rowNumber)
                  )
                    return row
                  const issues = row.mapped.issues.filter(
                    (issue) =>
                      issue.code !== 'CATEGORY_FALLBACK' &&
                      issue.code !== 'CATEGORY_NO_CONFIDENT_MATCH',
                  )
                  const updated: DraftRow = {
                    ...row,
                    expense: { ...row.expense, category },
                    mapped: {
                      ...row.mapped,
                      category,
                      categoryProvenance: 'manual',
                      issues,
                      warning:
                        issues.find((issue) => issue.severity === 'warning')
                          ?.message ?? null,
                    },
                  }
                  // A category-only choice must not pin date, money or batch
                  // splits. Update full overrides only if the form was edited.
                  if (editedRows.current.has(row.mapped.rowNumber))
                    editedRows.current.set(row.mapped.rowNumber, updated)
                  return updated
                })
                setDrafts(nextDrafts)
                setCategoryContext((current) => {
                  const nextExplicitRows = { ...current.explicitRows }
                  for (const row of nextDrafts) {
                    if (
                      categoryCopySelection.has(row.mapped.rowNumber) &&
                      eligible.has(row.mapped.rowNumber)
                    )
                      nextExplicitRows[row.mapped.rowNumber] = category
                  }
                  return { ...current, explicitRows: nextExplicitRows }
                })
                duplicateMutation.reset()
                setDuplicateReadySignature(null)
                setRequestedDuplicateSignature(null)
                setCategoryCopyOpen(false)
                setCategoryCopySource(null)
              }}
            >
              {t('ExpenseImport.wizard.applyToExpenses', {
                count: categoryCopySelection.size,
              })}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <ResponsiveDialog
        open={Boolean(overrideRow)}
        onOpenChange={(open) => !open && setOverrideRowId(null)}
      >
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              {t('ExpenseImport.wizard.duplicateDialogTitle')}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {t('ExpenseImport.wizard.duplicateDialogDescription')}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody className="space-y-2">
            {overrideRow
              ? (duplicateByRow.get(overrideRow.mapped.rowId) ?? []).map(
                  (match) => (
                    <p
                      key={match.key}
                      className="rounded-md border p-3 text-sm"
                    >
                      {duplicateReason(match)}
                    </p>
                  ),
                )
              : null}
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOverrideRowId(null)}
            >
              {t('ExpenseImport.wizard.keepUnselected')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (overrideRow) {
                  const keys = (
                    duplicateByRow.get(overrideRow.mapped.rowId) ?? []
                  ).map(({ key }) => key)
                  setDrafts((current) =>
                    current.map((row) =>
                      row.mapped.rowId === overrideRow.mapped.rowId
                        ? {
                            ...row,
                            selected: true,
                            approvedDuplicateKeys: keys,
                          }
                        : row,
                    ),
                  )
                }
                setOverrideRowId(null)
              }}
            >
              {t('ExpenseImport.wizard.importAnyway')}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      <ResponsiveDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => !open && blocker.reset?.()}
      >
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              {t('ExpenseImport.wizard.leaveImportTitle')}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {t('ExpenseImport.wizard.leaveImportDescription')}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => blocker.reset?.()}
            >
              {t('ExpenseImport.wizard.stayHere')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => blocker.proceed?.()}
            >
              {t('ExpenseImport.wizard.leaveAndDiscard')}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>

      {table ? (
        <>
          <SourceFileDialog
            table={table}
            open={sourceViewerOpen}
            onOpenChange={setSourceViewerOpen}
          />
          <MappedExpensesDialog
            rows={mappedPreviewRows}
            open={mappedViewerOpen}
            status={mappingPresentationStatus}
            filter={mappedPreviewFilter}
            issueField={mappedPreviewIssueField}
            onOpenChange={setMappedViewerOpen}
            onFilterChange={(nextFilter, field) => {
              setMappedPreviewFilter(nextFilter)
              setMappedPreviewIssueField(field ?? null)
            }}
          />
          {previewSource ? (
            <SourceCategoryPreviewDialog
              sourceName={previewSource.source}
              titleMode={previewSource.titleMode}
              categoryName={
                getCategoryById(previewSource.categoryId)?.name ??
                previewSource.categoryId
              }
              rows={previewSource.rows}
              status={mappingPresentationStatus}
              open={previewSourceKey !== null}
              onOpenChange={(open) => {
                if (!open) setPreviewSourceKey(null)
              }}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )
}
