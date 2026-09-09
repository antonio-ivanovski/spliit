import { useTranslation } from 'react-i18next'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { getCurrency, type SplitMode } from '@spliit/domain'
import type { ExpenseImportBatchDefaults } from '@spliit/domain/import'

import { ParticipantShareRow } from './expense-form/participant-share-row'
import {
  SinglePayerDistributionEditor,
  SplitDistributionEditor,
  type DistributionParticipant,
} from './expense-form/split-distribution-editor'
import {
  PaidBySplitOptionCards,
  PaidForSplitOptionCards,
} from './expense-form/split-option-cards'

function splitRows(
  mode: 'EVENLY' | 'BY_SHARES' | 'BY_PERCENTAGE',
  participantIds: string[],
) {
  if (mode === 'EVENLY') {
    return participantIds.map((participant) => ({ participant, shares: 1 }))
  }
  if (mode === 'BY_SHARES') {
    return participantIds.map((participant) => ({ participant, shares: 100 }))
  }
  const base = Math.trunc(10_000 / participantIds.length)
  let remainder = 10_000 - base * participantIds.length
  return participantIds.map((participant) => {
    const extra = remainder > 0 ? 1 : 0
    remainder -= extra
    return { participant, shares: base + extra }
  })
}

export function createBatchDefaults(
  participantIds: string[],
  payerId: string,
): ExpenseImportBatchDefaults {
  return {
    paidBy: {
      mode: 'SINGLE',
      participantId: payerId,
    },
    paidFor: {
      mode: 'EVENLY',
      shares: splitRows('EVENLY', participantIds),
    },
  }
}

function proportionalShareRows(
  participants: DistributionParticipant[],
  mode: 'EVENLY' | 'BY_SHARES' | 'BY_PERCENTAGE',
  current: Array<{ participant: string; shares: number }> = [],
) {
  const currentByParticipant = new Map(
    current.map((row) => [row.participant, row.shares]),
  )
  const selected = participants.filter((participant) =>
    currentByParticipant.has(participant.id),
  )
  const source = selected.length ? selected : participants
  if (mode === 'EVENLY') {
    return source.map(({ id }) => ({ participant: id, shares: 1 }))
  }
  if (mode === 'BY_SHARES') {
    return source.map(({ id }) => ({
      participant: id,
      shares: currentByParticipant.get(id) ?? 100,
    }))
  }
  if (!source.length) return []
  const base = Math.trunc(10_000 / source.length)
  let remainder = 10_000 - base * source.length
  return source.map(({ id }) => {
    const extra = remainder > 0 ? 1 : 0
    remainder -= extra
    return {
      participant: id,
      shares: currentByParticipant.get(id) ?? base + extra,
    }
  })
}

function BatchDistributionRows({
  participants,
  currencyCode,
  mode,
  rows,
  onChange,
  variant,
}: {
  participants: DistributionParticipant[]
  currencyCode: string
  mode: 'EVENLY' | 'BY_SHARES' | 'BY_PERCENTAGE'
  rows: Array<{ participant: string; shares: number }>
  onChange: (rows: Array<{ participant: string; shares: number }>) => void
  variant: 'paidBy' | 'paidFor'
}) {
  const { t } = useTranslation()
  const currency = getCurrency(currencyCode) ?? getCurrency('USD')!
  const selected = new Set(rows.map(({ participant }) => participant))
  const sharesByParticipant = new Map(
    rows.map(({ participant, shares }) => [participant, shares]),
  )
  const distribution =
    variant === 'paidBy'
      ? t('ExpenseImport.defaults.distributionPaidBy')
      : t('ExpenseImport.defaults.distributionPaidFor')
  const setSelected = (participantId: string, checked: boolean) => {
    if (checked) {
      const next = rows.some((row) => row.participant === participantId)
        ? rows
        : [
            ...rows,
            {
              participant: participantId,
              shares:
                mode === 'BY_PERCENTAGE' ? 0 : mode === 'BY_SHARES' ? 100 : 1,
            },
          ]
      onChange(next)
    } else {
      onChange(rows.filter((row) => row.participant !== participantId))
    }
  }
  const setAll = () =>
    onChange(
      selected.size === participants.length
        ? []
        : proportionalShareRows(participants, mode, rows),
    )
  const updateValue = (participantId: string, value: number) =>
    onChange(
      rows.map((row) =>
        row.participant === participantId ? { ...row, shares: value } : row,
      ),
    )

  return (
    <SplitDistributionEditor
      participants={participants}
      selectedCount={rows.length}
      mode={mode}
      targetAmount={undefined}
      shares={rows.map(({ shares }) =>
        mode === 'BY_PERCENTAGE'
          ? shares / 100
          : mode === 'BY_SHARES'
            ? shares / 100
            : shares,
      )}
      currency={currency}
      onReset={() => onChange(proportionalShareRows(participants, mode, rows))}
      onToggleAll={setAll}
      afterRows={
        <p className="pt-2 text-xs text-muted-foreground">
          {variant === 'paidBy'
            ? t('ExpenseImport.defaults.sharesNotePaidBy')
            : t('ExpenseImport.defaults.sharesNotePaidFor')}
        </p>
      }
      renderRow={(participant) => {
        const checked = selected.has(participant.id)
        return (
          <ParticipantShareRow
            key={participant.id}
            participant={participant}
            checked={checked}
            onCheckedChange={(next) => setSelected(participant.id, next)}
            preview={
              checked && mode === 'EVENLY'
                ? t('ExpenseImport.defaults.equalShare')
                : checked && mode === 'BY_PERCENTAGE'
                  ? `${((sharesByParticipant.get(participant.id) ?? 0) / 100).toFixed(2)}%`
                  : undefined
            }
            shareInput={
              checked && mode !== 'EVENLY' ? (
                <Input
                  type="number"
                  min={0}
                  max={mode === 'BY_PERCENTAGE' ? 100 : undefined}
                  step={0.01}
                  aria-label={t('ExpenseImport.defaults.shareInputLabel', {
                    distribution,
                    name: participant.name,
                  })}
                  className="h-9 w-24"
                  value={
                    mode === 'BY_PERCENTAGE'
                      ? (sharesByParticipant.get(participant.id) ?? 0) / 100
                      : mode === 'BY_SHARES'
                        ? (sharesByParticipant.get(participant.id) ?? 0) / 100
                        : (sharesByParticipant.get(participant.id) ?? '')
                  }
                  onChange={(event) =>
                    updateValue(
                      participant.id,
                      mode === 'BY_PERCENTAGE' || mode === 'BY_SHARES'
                        ? (Number(event.target.value) || 0) * 100
                        : Number(event.target.value) || 0,
                    )
                  }
                />
              ) : undefined
            }
          />
        )
      }}
    />
  )
}

export function BatchDefaultsCard({
  participants,
  currencyCode,
  defaults,
  onDefaultsChange,
}: {
  participants: DistributionParticipant[]
  currencyCode: string
  defaults: ExpenseImportBatchDefaults
  onDefaultsChange: (defaults: ExpenseImportBatchDefaults) => void
}) {
  const { t } = useTranslation()
  const groupCurrency = getCurrency(currencyCode) ?? getCurrency('USD')!
  const paidByMode =
    defaults.paidBy.mode === 'SINGLE'
      ? { isMultiPayer: false, splitMode: 'BY_AMOUNT' as const }
      : { isMultiPayer: true, splitMode: defaults.paidBy.mode as SplitMode }
  const paidByProportionalMode =
    defaults.paidBy.mode === 'SINGLE' ? 'EVENLY' : defaults.paidBy.mode
  const paidForRows = defaults.paidFor.shares
  const setPaidByMode = (next: {
    isMultiPayer: boolean
    splitMode: SplitMode
  }) => {
    if (!next.isMultiPayer) {
      const participantId =
        defaults.paidBy.mode === 'SINGLE'
          ? defaults.paidBy.participantId
          : (participants[0]?.id ?? '')
      onDefaultsChange({
        ...defaults,
        paidBy: { mode: 'SINGLE', participantId },
      })
      return
    }
    const mode = next.splitMode as 'EVENLY' | 'BY_SHARES' | 'BY_PERCENTAGE'
    const currentRows =
      defaults.paidBy.mode === mode ? defaults.paidBy.shares : []
    onDefaultsChange({
      ...defaults,
      paidBy: {
        mode,
        shares: proportionalShareRows(participants, mode, currentRows),
      },
    })
  }
  const setPaidForMode = (mode: SplitMode) => {
    if (mode === 'ITEMIZED' || mode === 'BY_AMOUNT') return
    onDefaultsChange({
      ...defaults,
      paidFor: {
        mode,
        shares: proportionalShareRows(
          participants,
          mode,
          defaults.paidFor.mode === mode ? paidForRows : [],
        ),
      },
    })
  }
  return (
    <section className="space-y-3" aria-labelledby="batch-defaults-heading">
      <div>
        <h2 id="batch-defaults-heading" className="text-lg font-semibold">
          {t('ExpenseImport.defaults.sectionTitle')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('ExpenseImport.defaults.sectionDescription')}
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('ExpenseImport.defaults.paidByTitle')}
          </CardTitle>
          <CardDescription>
            {t('ExpenseImport.defaults.paidByDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PaidBySplitOptionCards
            value={paidByMode}
            hiddenOptionIds={['multi-amount']}
            onChange={setPaidByMode}
            renderContent={(option) =>
              option.id === 'single' ? (
                <SinglePayerDistributionEditor
                  participants={participants}
                  value={
                    defaults.paidBy.mode === 'SINGLE'
                      ? defaults.paidBy.participantId
                      : (participants[0]?.id ?? '')
                  }
                  onValueChange={(participantId) =>
                    onDefaultsChange({
                      ...defaults,
                      paidBy: { mode: 'SINGLE', participantId },
                    })
                  }
                  placeholder={t('ExpenseImport.defaults.payerPlaceholder')}
                  mobileTitle={t('ExpenseImport.defaults.paidByTitle')}
                />
              ) : defaults.paidBy.mode === 'SINGLE' ? null : (
                <BatchDistributionRows
                  participants={participants}
                  currencyCode={currencyCode}
                  mode={paidByProportionalMode}
                  rows={defaults.paidBy.shares}
                  onChange={(shares) =>
                    onDefaultsChange({
                      ...defaults,
                      paidBy: { mode: paidByProportionalMode, shares },
                    })
                  }
                  variant="paidBy"
                />
              )
            }
            contentClassName="pt-3"
          />
          <p className="mt-4 text-xs text-muted-foreground">
            {t('ExpenseImport.defaults.paidByFootnote', {
              currencyCode: groupCurrency.code,
            })}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t('ExpenseImport.defaults.paidForTitle')}
          </CardTitle>
          <CardDescription>
            {t('ExpenseImport.defaults.paidForDescription')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PaidForSplitOptionCards
            value={defaults.paidFor.mode}
            hiddenModes={['BY_AMOUNT']}
            onChange={setPaidForMode}
            renderContent={(mode) => (
              <BatchDistributionRows
                participants={participants}
                currencyCode={currencyCode}
                mode={mode === 'BY_AMOUNT' ? 'EVENLY' : mode}
                rows={defaults.paidFor.shares}
                onChange={(shares) =>
                  onDefaultsChange({
                    ...defaults,
                    paidFor: {
                      mode: mode === 'BY_AMOUNT' ? 'EVENLY' : mode,
                      shares,
                    },
                  })
                }
                variant="paidFor"
              />
            )}
            contentClassName="pt-3"
          />
        </CardContent>
      </Card>
    </section>
  )
}
