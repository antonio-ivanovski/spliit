import { zodResolver } from '@hookform/resolvers/zod'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  useForm,
  useFormState,
  useWatch,
  type FieldErrors,
  type FieldPath,
  type Resolver,
  type UseFormReturn,
} from 'react-hook-form'
import { useTranslation } from 'react-i18next'

import { useSyncedAccountPreferences } from '@/components/account-preferences-sync'
import { Button } from '@/components/ui/button'
import { Form } from '@/components/ui/form'
import { detectDeviceTimeZone } from '@/lib/account-preferences'
import { getCurrency } from '@/lib/currency'
import {
  expenseFormCancelLink,
  type ExpenseCancelLink,
} from '@/lib/expense-navigation'
import type { RuntimeFeatureFlags } from '@/lib/featureFlags'
import {
  expenseFormInputSchema,
  type Expense,
  type ExpenseFormInputValues,
} from '@/lib/schemas'
import { dateOnlyInAccountTimeZone, getCurrencyFromGroup } from '@/lib/utils'
import type { CreateExpenseSearch } from '@/router/schemas'
import { trpc } from '@/trpc/client'
import type { AppRouterOutput } from '@spliit/api/router'
import {
  INCOME_CATEGORY_ID,
  amountAsDecimal,
  isExpenseDocumentImage,
  isSettlementCategory,
  type Currency,
} from '@spliit/domain'

import type {
  ReceiptDocument,
  ReceiptExtractedInfo,
  ReceiptScanContext,
} from '../create-from-receipt-button'
import { BasicDetailsCard } from './basic-details-card'
import { isValidExpenseDate } from './currency-utils'
import {
  buildExpenseFormDefaults,
  importDraftAsLoadedExpense,
} from './default-values'
import { DocumentsCard } from './documents-card'
import { ExpenseItemsCard } from './expense-items-card'
import { useExpenseFormTabNavigation } from './focus-navigation'
import { FormActions } from './form-actions'
import { ItemParticipantsModal } from './item-participants-modal'
import { PaidByCard } from './paid-by-card'
import { PaidForCard } from './paid-for-card'
import type { ShareArrayName, ShareInputKey } from './share-row-input'
import {
  presetToFormPaidBySplit,
  presetToFormSplit,
  type LoadedPresetSource,
  type SplitPreset,
} from './split-presets'
import { buildSubmitValues } from './submit-values'
import { useExpenseCurrencyConversion } from './use-expense-currency-conversion'
import { useExpenseFormBalancing } from './use-expense-form-balancing'

function firstErrorPath(errors: FieldErrors, prefix = ''): string | undefined {
  if (!errors || typeof errors !== 'object') return undefined
  for (const [key, value] of Object.entries(errors)) {
    if (key === 'ref' || key === 'types') continue
    const path = prefix ? `${prefix}.${key}` : key
    if (
      value &&
      typeof value === 'object' &&
      'message' in value &&
      (value as { message?: unknown }).message != null
    ) {
      return path
    }
    const childPath = firstErrorPath(value as FieldErrors, path)
    if (childPath) return childPath
  }
  return undefined
}

function focusableErrorPath(path: string): string {
  const itemMatch = path.match(/^items(?:\.(\d+))?/)
  if (itemMatch) return `items.${itemMatch[1] ?? 0}.title`
  return path
}

function searchParamsHasValue(value: string | undefined | null): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Resolve a share error path (`paidFor`, `paidFor.root`, `paidFor.2.shares`, …)
 * to the owning array and participant of the first affected row, or `null` when
 * the error cannot be mapped to a row (e.g. an empty `paidFor` list). Focus
 * then targets the section-qualified input registry instead of an array index,
 * which is unstable while rows are being added/removed — and instead of a bare
 * participant id, which is ambiguous because the same participant has inputs in
 * both `paidFor` and `paidByList`.
 */
function shareErrorTarget(
  path: string,
  form: UseFormReturn<ExpenseFormInputValues>,
): { arrayName: ShareArrayName; participantId: string } | null {
  const paidForMatch = path.match(/^paidFor(?:\.(\d+))?/)
  if (paidForMatch) {
    const rows = form.getValues('paidFor')
    const participantId = rows[Number(paidForMatch[1] ?? 0)]?.participant
    return participantId ? { arrayName: 'paidFor', participantId } : null
  }
  const paidByMatch = path.match(/^paidByList(?:\.(\d+))?/)
  if (paidByMatch) {
    const rows = form.getValues('paidByList')
    const participantId = rows[Number(paidByMatch[1] ?? 0)]?.participant
    return participantId ? { arrayName: 'paidByList', participantId } : null
  }
  return null
}

/**
 * Outcome of an `ExpenseForm` submit:
 *
 * - `'saved'` — the expense was persisted; post-save work (`onSaved`) may run.
 * - `'deferred'` — the flow suspended the save (e.g. a recurring-edit scope
 *   dialog will perform it later); no post-save work should run.
 */
export type ExpenseSubmitOutcome = 'saved' | 'deferred'

export function ExpenseForm(props: {
  group: NonNullable<AppRouterOutput['groups']['get']['group']>
  expense?: AppRouterOutput['groups']['expenses']['get']['expense']
  /** Complete expense data held only by the file-import review flow. */
  draftExpense?: Expense
  isCopy?: boolean
  searchParams?: CreateExpenseSearch
  heading?: string
  /** Internal path to return to when the form was opened from another feed. */
  cancelLink?: ExpenseCancelLink
  /**
   * Persistence callback. Resolves `'saved'` once the expense is persisted and
   * `'deferred'` when the flow only suspends the save (see
   * {@link ExpenseSubmitOutcome}). A rejection is a persistence failure: nothing
   * was saved, the mutation hooks already surface it through their error toast,
   * and a manual retry is safe — the form stays enabled.
   */
  onSubmit: (value: Expense) => Promise<ExpenseSubmitOutcome>
  /**
   * Optional post-save work (typically navigation), awaited only after a
   * `'saved'` outcome. A rejection here is NOT a persistence failure — the
   * expense already exists — so the form surfaces a dedicated notice with a
   * leave-again action instead of reporting a save failure (which would invite
   * a duplicate retry). After a `'saved'` outcome the form is terminal: the
   * submit action is disabled and only this callback may run.
   */
  onSaved?: () => Promise<void>
  onDelete?: () => Promise<void>
  runtimeFeatureFlags: RuntimeFeatureFlags
  currentLedgerParticipantId?: string | null
  readOnly?: boolean
  /** Locked series edit scope when editing a recurring expense. */
  editScope?: 'OCCURRENCE' | 'THIS_AND_FUTURE' | null
}) {
  const { t } = useTranslation(undefined, { keyPrefix: 'ExpenseForm' })
  const accountPreferences = useSyncedAccountPreferences()
  const accountTimeZone =
    accountPreferences?.timeZone ?? detectDeviceTimeZone() ?? 'UTC'
  const [formNow] = useState(() => new Date())
  // Set when `onSubmit` resolved 'saved' but `onSaved` (post-save work such
  // as navigation) failed: the expense already exists, so this must not be
  // reported as a save failure (that would invite a duplicate retry).
  const [postSaveFailure, setPostSaveFailure] = useState(false)
  // True once persistence succeeded. 'saved' is a terminal outcome: the
  // expense exists, so the submit action is disabled (a retry would
  // duplicate it) and the only escape is the leave-again action, which
  // invokes `onSaved` without re-persisting.
  const [persisted, setPersisted] = useState(false)
  const [retryingNav, setRetryingNav] = useState(false)
  // Copy and fresh-create both surface as a Create flow even though
  // props.expense is set in copy mode (for field prefill).
  const isCreate =
    (props.expense === undefined && props.draftExpense === undefined) ||
    props.isCopy === true
  const initialExpense = useMemo(
    () =>
      props.expense ??
      (props.draftExpense
        ? importDraftAsLoadedExpense(props.draftExpense)
        : undefined),
    [props.draftExpense, props.expense],
  )

  const splitPresetsQuery = trpc.groups.splitPresets.list.useQuery(
    { groupId: props.group.id },
    { enabled: !props.readOnly },
  )
  const splitPresets: SplitPreset[] = useMemo(
    () => splitPresetsQuery.data?.presets ?? [],
    [splitPresetsQuery.data?.presets],
  )
  const canManageSharedSplitPresets =
    splitPresetsQuery.data?.canManageShared ??
    (splitPresetsQuery.data as { canManage?: boolean } | undefined)
      ?.canManage ??
    false
  const canManagePersonalSplitPresets =
    splitPresetsQuery.data?.canManagePersonal ?? false
  const suggestCategoryMutation =
    trpc.groups.expenses.suggestCategory.useMutation()

  const form = useForm<ExpenseFormInputValues>({
    resolver: zodResolver(
      expenseFormInputSchema,
    ) as Resolver<ExpenseFormInputValues>,
    // Focus choreography is handled by `handleInvalidSubmit` below, which
    // maps array/items roots onto real inputs; the default walker cannot
    // reach the nested share fields and would fight the explicit setFocus.
    shouldFocusError: false,
    defaultValues: buildExpenseFormDefaults({
      isCreate,
      expense: initialExpense,
      isCopy: props.isCopy,
      searchParams: props.searchParams ?? {},
      group: props.group,
      groupCurrency: getCurrencyFromGroup(props.group),
      currentLedgerParticipantId: props.currentLedgerParticipantId,
      settlementTitle: t('settlementTitle'),
      today: dateOnlyInAccountTimeZone(formNow, accountTimeZone),
      now: formNow,
      timeZone: accountTimeZone,
    }),
  })

  // Defaults are resolved independently for payer and participants. They are
  // applied once to a fresh form after the preset library arrives; edit, copy,
  // settlement, and explicit URL values retain their existing distributions.
  const automaticDefaultsApplied = useRef({ paidBy: false, paidFor: false })
  const [appliedAutomaticDefaults, setAppliedAutomaticDefaults] = useState<{
    paidBy: { preset: SplitPreset; source: LoadedPresetSource } | null
    paidFor: { preset: SplitPreset; source: LoadedPresetSource } | null
  }>({ paidBy: null, paidFor: null })
  // oxlint-disable react/react-compiler -- record which async defaults were applied; this state must remain stable after the user edits the draft.
  useEffect(() => {
    if (!isCreate || props.expense || props.isCopy || !splitPresetsQuery.data) {
      return
    }
    const allPresets = splitPresets
    const defaults = splitPresetsQuery.data.effectiveDefaults ?? {
      paidByPresetId: null,
      paidForPresetId: null,
    }
    const defaultSource = (
      target: 'paidBy' | 'paidFor',
      presetId: string,
    ): LoadedPresetSource => {
      const personal = splitPresetsQuery.data.personalDefaults[target]
      if (personal.mode === 'PRESET' && personal.presetId === presetId) {
        return 'MY_DEFAULT'
      }
      return 'GROUP_DEFAULT'
    }
    const explicitPaidFor =
      !!searchParamsHasValue(props.searchParams?.participants) ||
      !!searchParamsHasValue(props.searchParams?.items) ||
      props.searchParams?.settlement === 'yes' ||
      props.searchParams?.reimbursement === 'yes'
    const explicitPaidBy =
      !!searchParamsHasValue(props.searchParams?.payer) ||
      !!searchParamsHasValue(props.searchParams?.from) ||
      props.searchParams?.settlement === 'yes' ||
      props.searchParams?.reimbursement === 'yes'
    const dirtyFields = form.formState.dirtyFields
    const touchedFields = form.formState.touchedFields
    const paidForEdited = !!dirtyFields.paidFor || !!touchedFields.paidFor
    const paidByEdited =
      !!dirtyFields.paidByList ||
      !!dirtyFields.paidBySplitMode ||
      !!dirtyFields.isMultiPayer ||
      !!touchedFields.paidByList ||
      !!touchedFields.paidBySplitMode ||
      !!touchedFields.isMultiPayer
    if (!automaticDefaultsApplied.current.paidFor) {
      if (explicitPaidFor || paidForEdited) {
        automaticDefaultsApplied.current.paidFor = true
      } else {
        automaticDefaultsApplied.current.paidFor = true
        const preset = allPresets.find(
          (candidate) => candidate.id === defaults.paidForPresetId,
        )
        setAppliedAutomaticDefaults((current) => ({
          ...current,
          paidFor: preset
            ? { preset, source: defaultSource('paidFor', preset.id) }
            : null,
        }))
        if (preset?.participants) {
          const next = presetToFormSplit(preset)
          form.setValue('splitMode', next.splitMode, { shouldValidate: true })
          form.setValue('paidFor', next.paidFor, { shouldValidate: true })
        }
      }
    }
    if (!automaticDefaultsApplied.current.paidBy) {
      if (explicitPaidBy || paidByEdited) {
        automaticDefaultsApplied.current.paidBy = true
      } else {
        automaticDefaultsApplied.current.paidBy = true
        const preset = allPresets.find(
          (candidate) => candidate.id === defaults.paidByPresetId,
        )
        setAppliedAutomaticDefaults((current) => ({
          ...current,
          paidBy: preset
            ? { preset, source: defaultSource('paidBy', preset.id) }
            : null,
        }))
        const next = preset ? presetToFormPaidBySplit(preset) : null
        if (next) {
          form.setValue('isMultiPayer', next.isMultiPayer, {
            shouldValidate: true,
          })
          form.setValue('paidBySplitMode', next.paidBySplitMode, {
            shouldValidate: true,
          })
          form.setValue('paidByList', next.paidByList, {
            shouldValidate: true,
          })
        }
      }
    }
  }, [
    form,
    form.formState.dirtyFields,
    form.formState.touchedFields,
    isCreate,
    props.expense,
    props.isCopy,
    props.searchParams,
    splitPresets,
    splitPresetsQuery.data,
  ])
  // oxlint-enable react/react-compiler

  const automaticDefaultPaidForPreset =
    appliedAutomaticDefaults.paidFor?.preset ?? null
  const automaticDefaultPaidByPreset =
    appliedAutomaticDefaults.paidBy?.preset ?? null
  const automaticDefaultPaidForSource =
    appliedAutomaticDefaults.paidFor?.source ?? null
  const automaticDefaultPaidBySource =
    appliedAutomaticDefaults.paidBy?.source ?? null

  // Section-qualified registry (`paidFor:lp-1` / `paidByList:lp-1`) of the
  // paid-for / paid-by share inputs. Focus for share errors goes through it —
  // the participant id alone would be ambiguous across the two sections.
  const shareInputRefs = useRef(new Map<ShareInputKey, HTMLInputElement>())
  const formElementRef = useRef<HTMLFormElement>(null)
  const tabNavigation = useExpenseFormTabNavigation(formElementRef)

  const groupCurrency = getCurrencyFromGroup(props.group)

  const conversion = useExpenseCurrencyConversion({
    form,
    group: props.group,
    groupCurrency,
  })

  const isIncome = conversion.isIncome

  // Income expenses cannot stay on Settlement; move off it automatically
  // so saving an income expense doesn't accidentally settle a balance.
  useEffect(() => {
    if (isIncome && isSettlementCategory(form.getValues('category'))) {
      form.setValue('category', INCOME_CATEGORY_ID)
    }
  }, [isIncome, form])

  const originalCurrencyValue = useWatch({
    control: form.control,
    name: 'originalCurrency',
  })
  // Narrowed watches: only the fields the receipt-scan context consumes
  // (a whole-form useWatch re-renders the entire form on every keystroke).
  const watchedTitle = useWatch({ control: form.control, name: 'title' })
  const watchedAmount = useWatch({ control: form.control, name: 'amount' })
  const watchedExpenseDay = useWatch({
    control: form.control,
    name: 'expenseDay',
  })
  const watchedCategory = useWatch({ control: form.control, name: 'category' })
  const watchedItems = useWatch({ control: form.control, name: 'items' })
  const payerCurrency: Currency = originalCurrencyValue
    ? (getCurrency(originalCurrencyValue) ?? groupCurrency)
    : groupCurrency

  const { setManuallyEditedParticipants, setManuallyEditedPayers } =
    useExpenseFormBalancing({ form, payerCurrency })

  const sExpense = (isIncome ? 'Income' : 'Expense') as 'Expense' | 'Income'

  const receiptScanContext: ReceiptScanContext = {
    title: watchedTitle || undefined,
    amount: Number(watchedAmount) || undefined,
    date: isValidExpenseDate(new Date(`${watchedExpenseDay}T00:00:00.000Z`))
      ? watchedExpenseDay
      : undefined,
    currencyCode: originalCurrencyValue || groupCurrency.code,
    categoryId: watchedCategory || undefined,
    items: (watchedItems ?? []).map((item) => ({
      title: item.title ?? '',
      unitPrice: Number(item.unitPrice) || 0,
      quantity: Number(item.quantity) || 1,
    })),
  }

  const applyReceiptResult = ({
    info,
    document,
  }: {
    info: ReceiptExtractedInfo
    document: ReceiptDocument
  }) => {
    const receiptCurrency = info.currencyCode
      ? (getCurrency(info.currencyCode) ?? groupCurrency)
      : groupCurrency
    if (info.title) {
      form.setValue('title', info.title, { shouldDirty: true })
    }
    if (info.amount > 0) {
      form.setValue('amount', amountAsDecimal(info.amount, receiptCurrency), {
        shouldDirty: true,
        shouldValidate: true,
      })
    }
    if (info.date) {
      form.setValue('expenseDay', info.date, {
        shouldDirty: true,
      })
    }
    if (info.currencyCode) {
      form.setValue('originalCurrency', receiptCurrency.code, {
        shouldDirty: true,
      })
    }
    if (info.categoryId) {
      form.setValue('category', info.categoryId as never, {
        shouldDirty: true,
      })
    }
    if (info.items.length) {
      form.setValue(
        'items',
        info.items.map((item) => ({
          id: crypto.randomUUID(),
          title: item.title,
          // Receipt line-item prices are returned as major-unit numbers;
          // only the total is normalized to minor units by the API.
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          splitMode: 'EVENLY' as const,
          paidFor: props.group.participants.map((participant) => ({
            participant: participant.id,
            shares: 1,
          })),
        })),
        { shouldDirty: true },
      )
    }
    if (
      !form
        .getValues('documents')
        .some((existing) => existing.url === document.url)
    ) {
      form.setValue('documents', [...form.getValues('documents'), document], {
        shouldDirty: true,
      })
    }
  }

  const submit = async (values: ExpenseFormInputValues) => {
    if (props.readOnly || persisted) return
    setPostSaveFailure(false)
    const rate = Number(values.conversionRate)
    if (
      conversion.conversionRequired &&
      (!rate || Number.isNaN(rate) || rate <= 0)
    ) {
      form.setError('conversionRate', {
        type: 'manual',
        message: 'ratePositive',
      })
      return
    }
    let outcome: ExpenseSubmitOutcome | null = null
    try {
      outcome = await props.onSubmit(
        buildSubmitValues(values, {
          groupCurrency,
          conversionRequired: conversion.conversionRequired,
        }),
      )
    } catch {
      // Persistence failure: nothing was saved, the mutation hooks already
      // surfaced it through their error toast, and a manual retry is safe —
      // so the form stays enabled and no inline error is claimed.
    }
    if (outcome !== 'saved') return
    // The expense exists now; persistence is terminal (see `persisted`).
    setPersisted(true)
    if (!props.onSaved) return
    try {
      await props.onSaved()
    } catch {
      // Post-save work failed (e.g. navigation) AFTER the expense was
      // persisted. Resubmitting would duplicate the expense, so surface a
      // dedicated notice with a leave-again action instead of a
      // save-failure message.
      setPostSaveFailure(true)
    }
  }

  // Retries only the post-save work: persistence already happened and must
  // not run again.
  const tryLeavingAgain = async () => {
    if (!props.onSaved || retryingNav) return
    setRetryingNav(true)
    try {
      await props.onSaved()
      setPostSaveFailure(false)
    } catch {
      setPostSaveFailure(true)
    } finally {
      setRetryingNav(false)
    }
  }

  const handleInvalidSubmit = (errors: FieldErrors<ExpenseFormInputValues>) => {
    const path = firstErrorPath(errors)
    if (!path) return
    // Share errors focus through the section-qualified input registry;
    // everything else falls back to RHF's setFocus.
    const target = shareErrorTarget(path, form)
    if (target) {
      const shareInput = shareInputRefs.current.get(
        `${target.arrayName}:${target.participantId}`,
      )
      if (shareInput) {
        shareInput.focus()
        return
      }
    }
    // Some valid form states (for example single-payer paid-by mode) have a
    // share error path but intentionally render no share input. Do not stop
    // after a missing registry entry; retain RHF's normal fallback behavior.
    form.setFocus(focusableErrorPath(path) as FieldPath<ExpenseFormInputValues>)
  }

  return (
    <Form {...form}>
      <form
        ref={formElementRef}
        data-expense-form
        // oxlint-disable-next-line react/react-compiler -- handleInvalidSubmit reads shareInputRefs at submit time (event handler, never during render); the section-qualified registry replaces array-index focus for position-shifting rows.
        onSubmit={form.handleSubmit(submit, handleInvalidSubmit)}
        onFocusCapture={tabNavigation.onFocusCapture}
        onKeyDownCapture={tabNavigation.onKeyDownCapture}
        noValidate
        className="min-w-0 overflow-x-hidden pb-24 sm:pb-20"
      >
        {props.readOnly && <ReadOnlyNotice />}
        <BasicDetailsCard
          form={form}
          group={props.group}
          accountTimeZone={accountTimeZone}
          readOnly={!!props.readOnly}
          sExpense={sExpense}
          isCreate={isCreate}
          isCopy={props.isCopy}
          recurrenceSequence={
            !props.isCopy
              ? (initialExpense?.recurrenceSequence ?? undefined)
              : undefined
          }
          editScope={props.editScope}
          cancelLink={props.cancelLink}
          initialRecurrence={
            !isCreate ? (initialExpense?.recurrence ?? null) : undefined
          }
          suggestCategoryMutation={suggestCategoryMutation}
          runtimeFeatureFlags={props.runtimeFeatureFlags}
          receiptDocuments={form.getValues('documents').flatMap((document) => {
            if (
              !isExpenseDocumentImage(document.contentType) &&
              document.contentType
            ) {
              return []
            }
            if (document.width == null || document.height == null) return []
            return [
              {
                id: document.id,
                url: document.url,
                width: document.width,
                height: document.height,
                fileName: document.fileName,
                contentType: document.contentType,
              },
            ]
          })}
          receiptScanContext={receiptScanContext}
          onReceiptAccepted={applyReceiptResult}
          heading={props.heading}
          {...conversion}
          groupCurrency={groupCurrency}
        />
        <ExpenseItemsCard
          form={form}
          group={props.group}
          groupCurrency={payerCurrency}
          readOnly={!!props.readOnly}
          presets={splitPresets}
          presetsLoading={splitPresetsQuery.isLoading}
          canManage={
            canManageSharedSplitPresets || canManagePersonalSplitPresets
          }
          canManageShared={canManageSharedSplitPresets}
          canManagePersonal={canManagePersonalSplitPresets}
          renderItemParticipantsModal={({
            itemIndex,
            item,
            open,
            onClose,
            onSaveItem,
            titleOverride,
            hideAmountDescription,
            hideAmountMode,
            presetsLoading,
            canManageShared,
            canManagePersonal,
          }) => (
            <ItemParticipantsModal
              open={open}
              onOpenChange={(v) => !v && onClose()}
              form={form}
              itemIndex={itemIndex}
              group={props.group}
              groupCurrency={payerCurrency}
              item={item}
              onSaveItem={onSaveItem}
              readOnly={!!props.readOnly}
              titleOverride={titleOverride}
              hideAmountDescription={hideAmountDescription}
              hideAmountMode={hideAmountMode}
              presets={splitPresets}
              presetsLoading={presetsLoading}
              canManage={
                canManageSharedSplitPresets || canManagePersonalSplitPresets
              }
              canManageShared={canManageShared ?? canManageSharedSplitPresets}
              canManagePersonal={
                canManagePersonal ?? canManagePersonalSplitPresets
              }
            />
          )}
        />
        <PaidForCard
          form={form}
          group={props.group}
          groupCurrency={groupCurrency}
          payerCurrency={payerCurrency}
          readOnly={!!props.readOnly}
          sExpense={sExpense}
          setManuallyEditedParticipants={setManuallyEditedParticipants}
          presets={splitPresets}
          presetsLoading={splitPresetsQuery.isLoading}
          canManageShared={canManageSharedSplitPresets}
          canManagePersonal={canManagePersonalSplitPresets}
          initialLoadedPreset={automaticDefaultPaidForPreset}
          initialLoadedSource={automaticDefaultPaidForSource}
          isCreate={isCreate}
          inputRefs={shareInputRefs}
        />
        <PaidByCard
          form={form}
          group={props.group}
          groupCurrency={groupCurrency}
          payerCurrency={payerCurrency}
          readOnly={!!props.readOnly}
          sExpense={sExpense}
          setManuallyEditedPayers={setManuallyEditedPayers}
          presets={splitPresets}
          presetsLoading={splitPresetsQuery.isLoading}
          canManageShared={canManageSharedSplitPresets}
          canManagePersonal={canManagePersonalSplitPresets}
          initialLoadedPreset={automaticDefaultPaidByPreset}
          initialLoadedSource={automaticDefaultPaidBySource}
          inputRefs={shareInputRefs}
        />
        {props.runtimeFeatureFlags.enableExpenseDocuments && (
          <DocumentsCard
            form={form}
            group={props.group}
            readOnly={!!props.readOnly}
            sExpense={sExpense}
            enableReceiptExtract={
              props.runtimeFeatureFlags.enableReceiptExtract
            }
            receiptContext={receiptScanContext}
            onReceiptAccepted={applyReceiptResult}
          />
        )}
        <ValidationSummary form={form} />
        {postSaveFailure && props.onSaved && (
          <div
            role="alert"
            className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
          >
            <p>{t('savedButNotNavigated')}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={retryingNav}
              onClick={() => void tryLeavingAgain()}
            >
              {t('tryLeavingAgain')}
            </Button>
          </div>
        )}
        <FormActions
          isCreate={isCreate}
          readOnly={!!props.readOnly}
          onDelete={props.onDelete}
          expenseTitle={props.expense?.title ?? props.draftExpense?.title}
          cancelLink={props.cancelLink ?? expenseFormCancelLink(props.group.id)}
          submitDisabled={persisted}
        />
      </form>
    </Form>
  )
}

function ReadOnlyNotice() {
  const { t } = useTranslation(undefined, { keyPrefix: 'ExpenseForm' })
  return (
    <p className="mb-4 text-sm text-muted-foreground">{t('readOnlyNotice')}</p>
  )
}

/**
 * Inline "correct the highlighted fields" summary, derived from RHF's own state
 * through an isolated `useFormState` subscription instead of a local flag: a
 * mirrored `hasValidationError` state could only be cleared by another submit,
 * so the banner would keep claiming errors after every field was fixed. RHF
 * revalidates errored fields on change once a submit happened, so this clears
 * as soon as `errors` empties.
 */
function ValidationSummary({
  form,
}: {
  form: UseFormReturn<ExpenseFormInputValues>
}) {
  const { t } = useTranslation(undefined, { keyPrefix: 'ExpenseForm' })
  const { isSubmitted, errors } = useFormState({ control: form.control })
  if (!isSubmitted || Object.keys(errors).length === 0) return null
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
    >
      <p>{t('validationSummary')}</p>
    </div>
  )
}
