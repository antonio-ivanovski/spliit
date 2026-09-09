import type { Prisma } from '@spliit/db'

import { expenseParticipantSharesSelect } from './expense-participant-shares'
import { expenseParticipantWithDisplayNameSelect } from './expense-participant-with-display-name'

export const groupExpenseListCardSelect = {
  id: true,
  createdByAccountId: true,
  title: true,
  amount: true,
  createdAt: true,
  expenseDate: true,
  expenseTimeZone: true,
  categoryId: true,
  splitMode: true,
  paidBySplitMode: true,
  originalAmount: true,
  originalCurrency: true,
  conversionRate: true,
  conversionSource: true,
  fileImportSource: { select: { provider: true } },
  recurrenceSequence: true,
  paidByList: { select: expenseParticipantWithDisplayNameSelect },
  paidFor: { select: expenseParticipantWithDisplayNameSelect },
  recurringSeries: {
    select: {
      id: true,
      status: true,
      creatorAccountId: true,
    },
  },
  items: {
    select: {
      id: true,
      title: true,
      amount: true,
    },
  },
  _count: { select: { documents: true } },
} satisfies Prisma.ExpenseSelect

/** CSV export expense projection (net-share columns only need share rows). */
export const expenseCsvExportSelect = {
  id: true,
  expenseDate: true,
  expenseTimeZone: true,
  title: true,
  categoryId: true,
  amount: true,
  originalAmount: true,
  originalCurrency: true,
  conversionRate: true,
  conversionSource: true,
  paidBySplitMode: true,
  splitMode: true,
  paidByList: { select: expenseParticipantSharesSelect },
  paidFor: { select: expenseParticipantSharesSelect },
} satisfies Prisma.ExpenseSelect
