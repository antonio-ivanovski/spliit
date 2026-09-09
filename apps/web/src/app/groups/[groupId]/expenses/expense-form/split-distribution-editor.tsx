import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ParticipantDistributionFooter } from '@/components/participant-distribution-footer'
import { ParticipantSelector } from '@/components/participant-selector'
import { Button } from '@/components/ui/button'
import type { Currency, SplitMode } from '@spliit/domain'

import type { RowShareError } from './get-row-share-errors'
import { RowErrorSummary } from './row-error-summary'

type DistributionMode = Exclude<SplitMode, 'ITEMIZED'>

export type DistributionParticipant = {
  id: string
  name: string
  pending?: boolean
  unlinked?: boolean
  account?: {
    id: string
    name?: string | null
    image?: string | null
  } | null
}

/**
 * Shared selected-card content for expense and reusable-preset distributions.
 * Callers adapt their own state (RHF or controlled) at the row boundary while
 * this component owns the visible controls, participant order, validation
 * placement, and footer.
 */
export function SplitDistributionEditor(props: {
  participants: DistributionParticipant[]
  selectedCount: number
  mode: DistributionMode
  targetAmount?: number
  shares: number[]
  currency: Currency
  readOnly?: boolean
  errors?: RowShareError[]
  onReset: () => void
  onToggleAll: () => void
  renderRow: (participant: DistributionParticipant) => ReactNode
  afterRows?: ReactNode
  dataTestId?: string
}) {
  const { t } = useTranslation(undefined, { keyPrefix: 'ExpenseForm' })

  return (
    <>
      <div className="mb-2 flex flex-wrap justify-end gap-x-1 gap-y-0.5">
        <Button
          variant="link"
          type="button"
          className="-my-2 -me-2"
          disabled={props.readOnly}
          onClick={props.onReset}
        >
          {t('resetDistribution')}
        </Button>
        <Button
          variant="link"
          type="button"
          className="-my-2 -me-2"
          disabled={props.readOnly}
          onClick={props.onToggleAll}
        >
          {props.selectedCount === props.participants.length
            ? t('selectNone')
            : t('selectAll')}
        </Button>
      </div>
      <RowErrorSummary
        errors={props.errors ?? []}
        participantName={(id) =>
          props.participants.find((participant) => participant.id === id)
            ?.name ?? id
        }
      />
      <div className="w-full min-w-0 space-y-0">
        {props.participants.map(props.renderRow)}
        {props.afterRows}
      </div>
      <ParticipantDistributionFooter
        splitMode={props.mode}
        targetAmount={props.targetAmount}
        shares={props.shares}
        currency={props.currency}
        paidByCount={props.selectedCount}
        dataTestId={props.dataTestId}
      />
    </>
  )
}

export function SinglePayerDistributionEditor(props: {
  participants: DistributionParticipant[]
  value: string
  onValueChange: (value: string) => void
  placeholder: string
  mobileTitle: string
  disabled?: boolean
  className?: string
}) {
  return (
    <ParticipantSelector
      participants={props.participants}
      mode="single"
      defaultValue={props.value}
      onValueChange={props.onValueChange}
      disabled={props.disabled}
      className={props.className ?? 'w-full'}
      singlePlaceholder={props.placeholder}
      mobileTitle={props.mobileTitle}
    />
  )
}
