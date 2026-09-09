import { z } from 'zod'

import { getGroupExpenses } from '../../../../lib/api'
import { expensePermissions } from '../../../../lib/api/resource-permissions'
import { redactExpenseListShares } from '../../../../lib/group-view-redaction'
import {
  groupAccessFields,
  scopedGroupReadProcedure,
  groupViewerArgs,
  loadGroupViewer,
} from '../../../init'
import { listExpensesOutputSchema } from '../../../outputs/expenses'

const matchModeSchema = z
  .enum(['any', 'all', 'exact'])
  .optional()
  .catch(undefined)

const listExpensesInputSchema = z.object({
  groupId: z.string().min(1),
  cursor: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  filter: z.string().optional(),
  locale: z.string().optional(),
  hideSettlements: z.boolean().optional(),
  categories: z.array(z.string()).optional(),
  paidBy: z.array(z.string()).optional(),
  paidByMatch: matchModeSchema,
  paidFor: z.array(z.string()).optional(),
  paidForMatch: matchModeSchema,
  dateFrom: z.date().optional(),
  dateTo: z.date().optional(),
  minAmount: z.number().optional(),
  maxAmount: z.number().optional(),
  currencies: z.array(z.string()).optional(),
  sortBy: z
    .enum(['expenseDate', 'createdAt', 'amount'])
    .optional()
    .catch(undefined),
  sortDir: z.enum(['asc', 'desc']).optional().catch(undefined),
  ...groupAccessFields,
})

export const listGroupExpensesProcedure = scopedGroupReadProcedure(
  'spliit:expenses:read',
)
  .input(listExpensesInputSchema)
  .output(listExpensesOutputSchema)
  .query(async ({ input, ctx }) => {
    const {
      cursor = 0,
      limit = 10,
      filter,
      locale,
      hideSettlements,
      categories,
      paidBy,
      paidByMatch,
      paidFor,
      paidForMatch,
      dateFrom,
      dateTo,
      minAmount,
      maxAmount,
      currencies,
      sortBy,
      sortDir,
    } = input
    const { group, ledger, member, viewer } = await loadGroupViewer(
      groupViewerArgs(input, ctx),
    )
    const expenses = await getGroupExpenses(group.id, {
      ledgerId: ledger.id,
      offset: cursor,
      length: limit + 1,
      filter,
      locale,
      hideSettlements,
      categories,
      paidBy,
      paidByMatch,
      paidFor,
      paidForMatch,
      dateFrom,
      dateTo,
      minAmount,
      maxAmount,
      currencies,
      sortBy,
      sortDir,
    })
    return {
      expenses: expenses.slice(0, limit).map((expense) => {
        const {
          recurringSeriesCreatorAccountId,
          createdByAccountId,
          ...publicExpense
        } = expense
        const viewerExpense =
          viewer.kind === 'ACTIVE'
            ? publicExpense
            : redactExpenseListShares(publicExpense)
        return {
          ...viewerExpense,
          createdAt: new Date(expense.createdAt),
          expenseDate: new Date(expense.expenseDate),
          permissions:
            viewer.kind === 'ACTIVE' && member
              ? expensePermissions({
                  role: member.role,
                  accountId: ctx.auth?.user.id ?? '',
                  createdByAccountId,
                  recurringSeries: expense.recurringSeriesId
                    ? {
                        creatorAccountId: recurringSeriesCreatorAccountId,
                      }
                    : null,
                  archived: group.archived,
                })
              : {
                  canEdit: false,
                  canDelete: false,
                  canManageRecurrence: false,
                },
        }
      }),
      hasMore: !!expenses[limit],
      nextCursor: cursor + limit,
    }
  })
