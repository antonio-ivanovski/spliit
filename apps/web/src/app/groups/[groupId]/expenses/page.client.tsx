import { useTranslation } from 'react-i18next'

import { ExpenseList } from '@/app/groups/[groupId]/expenses/expense-list'
import { ScanSurface } from '@/components/layout/scan-surface'
import { CardContent, CardDescription, CardTitle } from '@/components/ui/card'

export default function GroupExpensesPageClient() {
  const { t } = useTranslation(undefined, { keyPrefix: 'Expenses' })

  return (
    <ScanSurface className="mb-4">
      <div className="flex flex-row flex-wrap items-center gap-4 p-4 sm:justify-between sm:gap-x-6 sm:p-6">
        <div className="min-w-0 flex-1">
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </div>
      </div>

      <CardContent className="relative flex flex-col gap-4 p-0 pt-2 pb-4 sm:pb-6">
        <ExpenseList />
      </CardContent>
    </ScanSurface>
  )
}
