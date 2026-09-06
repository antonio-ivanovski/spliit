import { Calendar, Globe } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { AppRouterOutput } from '@spliit/api/router'
import type { NormalizedSource, RecurrenceConfig } from '@spliit/domain/import'
import {
  collapseExpenseFromNormalized,
  summarizeLegacyRecurringImport,
} from '@spliit/domain/import'

import type {
  ConversionMode,
  ParticipantMappingState,
} from './import-wizard-state'
import { WizardNav } from './wizard-nav'

type ImportInvite = NonNullable<
  AppRouterOutput['groups']['import']
>['invites'][number]

type Props = {
  source: NormalizedSource
  mode: 'NEW_GROUP' | 'EXISTING_GROUP'
  targetGroupId: string | null
  groupFormValues: {
    name: string
    information: string
    currency: string
    currencyCode: string
  }
  participants: ParticipantMappingState[]
  resolvedExpenses: NormalizedSource['expenses']
  invites?: ImportInvite[]
  isSubmitting: boolean
  conversionModes: Record<string, ConversionMode>
  recoveredDocumentCount?: number
  skippedDocumentCount?: number
  documentRecoverySkipped?: boolean
  showDocumentSummary?: boolean
  rates: Record<string, number> | null | undefined
  onBack: () => void
  onSubmit: () => void
  importError?: string | null
  onSkip?: () => void
  cloudSummary?: {
    archived: boolean
    activeRecurrenceCount: number
    expenseCount: number
  }
}

function formatRate(n: number): string {
  return n.toFixed(4)
}

export function ConfirmStep({
  source,
  mode,
  groupFormValues,
  participants,
  resolvedExpenses,
  isSubmitting,
  conversionModes,
  recoveredDocumentCount = 0,
  skippedDocumentCount = 0,
  documentRecoverySkipped = false,
  showDocumentSummary = false,
  rates,
  onBack,
  onSubmit,
  cloudSummary,
  importError = null,
  onSkip,
}: Props) {
  const { t } = useTranslation()
  const linkedCount = participants.filter(
    (p) => p.mode === 'LINK_ACCOUNT',
  ).length
  const inviteLinkCount = participants.filter(
    (p) => p.mode === 'INVITE_BY_LINK',
  ).length
  const inviteEmailCount = participants.filter(
    (p) => p.mode === 'INVITE_BY_EMAIL',
  ).length
  const existingCount = participants.filter(
    (p) => p.mode === 'LINK_EXISTING_PARTICIPANT',
  ).length
  const unlinkedCount = participants.filter(
    (p) => p.mode === 'UNLINKED_PARTICIPANT',
  ).length

  // Group rates by pair ("BASE|TARGET") so the confirm card can render one
  // block per pair with its mode + entries.
  type RateRow = { date: string; rate: number }
  const ratesByPair: Record<string, RateRow[]> = {}
  if (rates) {
    for (const key of Object.keys(rates)) {
      const [date, base, target] = key.split('|')
      const pairKey = `${base}|${target}`
      const list = ratesByPair[pairKey] ?? (ratesByPair[pairKey] = [])
      list.push({ date, rate: rates[key] })
    }
  }
  // Stable order by date within each pair.
  for (const key of Object.keys(ratesByPair)) {
    ratesByPair[key].sort((a, b) => a.date.localeCompare(b.date))
  }
  const conversionPairs = cloudSummary ? [] : Object.keys(conversionModes)
  // Cloud restore is lossless and uses the inspected manifest at submit
  // time. Its display source intentionally omits recurrence/itemization
  // details, so only render recurrence information from the raw Cloud
  // summary rather than implying the normalized preview is authoritative.
  const recurringSchedules = cloudSummary
    ? []
    : summarizeLegacyRecurringImport(
        resolvedExpenses.map((expense) =>
          collapseExpenseFromNormalized(expense),
        ),
      )

  const recurrenceConfigLabel = (config: RecurrenceConfig) => {
    if (config.interval === 1) {
      switch (config.frequency) {
        case 'DAILY':
          return t('Groups.Import.Confirm.recurrenceRule.daily')
        case 'WEEKLY':
          return t('Groups.Import.Confirm.recurrenceRule.weekly')
        case 'MONTHLY':
          return t('Groups.Import.Confirm.recurrenceRule.monthly')
        case 'YEARLY':
          return t('Groups.Import.Confirm.recurrenceRule.yearly')
      }
    }
    let frequency: string
    switch (config.frequency) {
      case 'DAILY':
        frequency = t(
          'Groups.Import.Confirm.recurrenceSchedule.frequency.daily',
        )
        break
      case 'WEEKLY':
        frequency = t(
          'Groups.Import.Confirm.recurrenceSchedule.frequency.weekly',
        )
        break
      case 'MONTHLY':
        frequency = t(
          'Groups.Import.Confirm.recurrenceSchedule.frequency.monthly',
        )
        break
      case 'YEARLY':
        frequency = t(
          'Groups.Import.Confirm.recurrenceSchedule.frequency.yearly',
        )
        break
    }
    return t('Groups.Import.Confirm.recurrenceSchedule.every', {
      interval: config.interval,
      frequency,
    })
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Destination */}
      <Card>
        <CardContent className="flex flex-col gap-2 p-4">
          <p className="text-sm font-medium">
            {t('Groups.Import.Confirm.destinationLabel')}
          </p>
          <p className="text-sm text-muted-foreground">
            {mode === 'EXISTING_GROUP'
              ? t('Groups.Import.Confirm.existingGroupFormat')
              : t('Groups.Import.Confirm.newGroupFormat', {
                  name: groupFormValues.name,
                  currency: groupFormValues.currencyCode,
                })}
          </p>
        </CardContent>
      </Card>

      {/* Summary */}
      <Card>
        <CardContent className="flex flex-col gap-2 p-4">
          <p className="text-sm font-medium">
            {t('Groups.Import.Confirm.summaryLabel')}
          </p>
          <ul className="space-y-2 text-sm">
            <li>
              {t('Groups.Import.Confirm.sourceParticipants', {
                count: participants.length,
              })}
            </li>
            <li>
              {t('Groups.Import.Confirm.participantBreakdown', {
                linked: linkedCount,
                email: inviteEmailCount,
                link: inviteLinkCount,
                existing: existingCount,
                unlinked: unlinkedCount,
              })}
            </li>
            <li>
              {t('Groups.Import.Confirm.expenseCount', {
                count: cloudSummary?.expenseCount ?? resolvedExpenses.length,
              })}
            </li>
            {showDocumentSummary && (
              <li>
                {documentRecoverySkipped
                  ? t('Groups.Import.Documents.skipTitle')
                  : t('Groups.Import.Confirm.documentCount', {
                      imported: recoveredDocumentCount,
                      skipped: skippedDocumentCount,
                    })}
              </li>
            )}
            {recurringSchedules.length > 0 && (
              <li className="flex flex-col gap-1.5">
                <span>
                  {t('Groups.Import.Confirm.recurringSchedulesLabel')}
                </span>
                <ul className="ms-4 list-disc space-y-1 text-muted-foreground">
                  {recurringSchedules.map((schedule, index) => (
                    <li
                      key={`${index}:${schedule.title}:${schedule.config.frequency}:${schedule.config.interval}`}
                    >
                      {t('Groups.Import.Confirm.recurringScheduleItem', {
                        title: schedule.title,
                        rule: recurrenceConfigLabel(schedule.config),
                      })}
                    </li>
                  ))}
                </ul>
              </li>
            )}
            {cloudSummary?.activeRecurrenceCount ? (
              <li>
                {t('Groups.Import.Cloud.confirmActiveRecurrence', {
                  count: cloudSummary.activeRecurrenceCount,
                })}
              </li>
            ) : null}
            {cloudSummary?.archived && (
              <li>{t('Groups.Import.Cloud.confirmArchived')}</li>
            )}
            <li>
              {t('Groups.Import.Confirm.sourceName', { name: source.name })}
            </li>
          </ul>
        </CardContent>
      </Card>

      {/* Conversion summary */}
      {conversionPairs.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-3 p-4">
            <p className="text-sm font-medium">
              {t('Groups.Import.Confirm.appliedExchangeRatesLabel')}
            </p>
            <ul className="flex flex-col gap-3 text-sm">
              {conversionPairs.map((pairKey) => {
                const [base, target] = pairKey.split('|')
                const pairMode = conversionModes[pairKey]
                const isPerDate = pairMode === 'perDate'
                const rows = ratesByPair[pairKey] ?? []
                return (
                  <li key={pairKey} className="flex flex-col gap-1.5">
                    <div className="flex items-center gap-2 text-foreground">
                      {isPerDate ? (
                        <Calendar className="h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <Globe className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className="font-medium tracking-tight">
                        {t('Groups.Import.CurrencyConversion.pairSection', {
                          source: base,
                          target,
                        })}
                      </span>
                      <span className="ms-auto rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] tracking-wider text-muted-foreground uppercase">
                        {isPerDate
                          ? t('Groups.Import.Confirm.conversionPerDate')
                          : t('Groups.Import.Confirm.conversionFixed')}
                      </span>
                    </div>
                    {isPerDate ? (
                      rows.length > 0 ? (
                        <ul className="ms-6 flex flex-col gap-1 text-xs">
                          {rows.map((row) => (
                            <li
                              key={row.date}
                              className="flex items-baseline gap-3 text-muted-foreground"
                            >
                              <span className="font-mono tabular-nums">
                                {row.date}
                              </span>
                              <span className="font-mono text-foreground tabular-nums">
                                {t(
                                  'Groups.Import.CurrencyConversion.fixedRateRow',
                                  {
                                    source: base,
                                    rate: formatRate(row.rate),
                                    target,
                                  },
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="ms-6 text-xs text-muted-foreground">—</p>
                      )
                    ) : rows.length > 0 ? (
                      <p className="ms-6 font-mono text-xs text-foreground tabular-nums">
                        {t('Groups.Import.CurrencyConversion.fixedRateRow', {
                          source: base,
                          rate: formatRate(rows[0].rate),
                          target,
                        })}
                      </p>
                    ) : (
                      <p className="ms-6 text-xs text-muted-foreground">—</p>
                    )}
                  </li>
                )
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      <p className="text-xs text-muted-foreground">
        {t('Groups.Import.Confirm.footer')}
      </p>

      {importError ? (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{importError}</span>
            {onSkip ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onSkip}
              >
                {t('Groups.Import.Cloud.skipGroup')}
              </Button>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <WizardNav
        step="confirm"
        includeDocuments={showDocumentSummary}
        onBack={onBack}
        onContinue={onSubmit}
        continueDisabled={isSubmitting}
        customContinueLabel={
          isSubmitting
            ? 'Groups.Import.Confirm.importingButton'
            : 'Groups.Import.Confirm.executeImport'
        }
      />
    </div>
  )
}
