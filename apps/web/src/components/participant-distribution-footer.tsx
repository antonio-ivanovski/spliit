import { useTranslation } from 'react-i18next'

import { useLocale } from '@/i18n/react'
import { cn, formatCurrency, formatNumber } from '@/lib/utils'
import type { Currency, SplitMode } from '@spliit/domain'
import { formatDisplayShares } from '@spliit/domain'

/**
 * Footer summary for the "Paid by" and "Paid for" participant lists. For
 * `BY_AMOUNT` and `BY_PERCENTAGE` it tells the user how much is missing or
 * overflowing vs the expense target; for `EVENLY` and `BY_SHARES` it shows a
 * static muted label.
 *
 * Call sites are responsible for normalising shares to the unit the component
 * expects per mode: minor units for BY_AMOUNT, percent for BY_PERCENTAGE,
 * display shares for BY_SHARES (1 = 1 share), irrelevant for EVENLY.
 */
export function ParticipantDistributionFooter({
  splitMode,
  targetAmount,
  shares,
  currency,
  paidByCount,
  dataTestId,
}: {
  splitMode: SplitMode
  targetAmount?: number
  shares: number[]
  currency: Currency
  paidByCount: number
  dataTestId?: string
}) {
  const { t } = useTranslation(undefined, {
    keyPrefix: 'ExpenseForm.ParticipantDistribution',
  })
  const locale = useLocale()

  let message: string | null = null
  let colorClass = ''

  if (splitMode === 'BY_AMOUNT') {
    const amountTarget = targetAmount ?? 0
    const sum = shares.reduce((s, x) => s + x, 0)
    const diff = amountTarget - sum
    const formattedTotal = formatCurrency(currency, amountTarget, locale)
    if (Math.abs(diff) < 0.5) {
      message = t('matches', { total: formattedTotal })
      colorClass = 'text-emerald-600'
    } else if (diff > 0) {
      const formattedMissing = formatCurrency(currency, diff, locale)
      message = t('missing', {
        missing: formattedMissing,
        total: formattedTotal,
      })
      colorClass = 'text-red-600'
    } else {
      const formattedExtra = formatCurrency(currency, -diff, locale)
      message = t('surplus', {
        extra: formattedExtra,
        total: formattedTotal,
      })
      colorClass = 'text-red-600'
    }
  } else if (splitMode === 'BY_PERCENTAGE') {
    const sum = shares.reduce((s, x) => s + x, 0)
    const diff = 100 - sum
    if (Math.abs(diff) < 0.001) {
      message = t('percentageMatches')
      colorClass = 'text-emerald-600'
    } else {
      const pct = formatNumber(Math.abs(diff), locale, {
        maximumFractionDigits: 2,
        useGrouping: false,
      })
      message =
        diff > 0
          ? t('percentageMissing', { pct })
          : t('percentageSurplus', { pct })
      colorClass = 'text-red-600'
    }
  } else if (
    splitMode === 'EVENLY' &&
    targetAmount != null &&
    paidByCount > 0
  ) {
    const evenAmount = targetAmount / paidByCount
    const formattedAmount = formatCurrency(
      currency,
      Math.round(evenAmount),
      locale,
    )
    message = t('evenlySplit', {
      amount: formattedAmount,
      count: paidByCount,
    })
    colorClass = 'text-muted-foreground'
  } else if (splitMode === 'BY_SHARES') {
    // Shares arrive as display values (e.g. 0.5, 1.1, 25.75) and may
    // still be raw input strings while the user is typing. Coerce to
    // numbers before summing so "0.5" + 1 cannot string-concatenate.
    // Format the sum with the shared helper so the user never sees the
    // fixed-unit form.
    const sum = shares.reduce((s, x) => s + Number(x), 0)
    message = t('sharesTotal', { sum: formatDisplayShares(sum, locale) })
    colorClass = 'text-muted-foreground'
  }

  if (!message) return null

  return (
    <output
      data-testid={dataTestId}
      aria-live="polite"
      aria-atomic="true"
      className={cn(
        'mt-3 flex items-baseline justify-between gap-2 rounded-md bg-muted/50 px-3 py-2 text-sm font-medium',
        colorClass,
      )}
    >
      <span>{message}</span>
    </output>
  )
}
