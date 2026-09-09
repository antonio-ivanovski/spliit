import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { getExpense } from '../../../../lib/api'
import { expensePermissions } from '../../../../lib/api/resource-permissions'
import {
  groupAccessFields,
  scopedGroupReadProcedure,
  groupViewerArgs,
  loadGroupViewer,
} from '../../../init'
import { getExpenseOutputSchema } from '../../../outputs/expenses'

export const getGroupExpenseProcedure = scopedGroupReadProcedure(
  'spliit:expenses:read',
)
  .input(
    z.object({
      groupId: z.string().min(1),
      expenseId: z.string().min(1),
      ...groupAccessFields,
    }),
  )
  .output(getExpenseOutputSchema)
  .query(async ({ input, ctx }) => {
    const { expenseId } = input
    const { group, member, viewer } = await loadGroupViewer(
      groupViewerArgs(input, ctx),
    )
    const expense = await getExpense(group.id, expenseId)
    if (!expense) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Expense not found',
      })
    }
    const { createdByAccountId, ...publicExpense } = expense
    return {
      expense: {
        ...publicExpense,
        permissions:
          viewer.kind === 'ACTIVE' && member
            ? expensePermissions({
                role: member.role,
                accountId: ctx.auth?.user.id ?? '',
                createdByAccountId,
                recurringSeries: expense.recurringSeries,
                archived: group.archived,
              })
            : {
                canEdit: false,
                canDelete: false,
                canManageRecurrence: false,
              },
      },
    }
  })
