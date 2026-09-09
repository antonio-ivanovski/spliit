import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { deleteExpense } from '../../../../lib/api/expenses/delete-expense'
import { getExpense } from '../../../../lib/api/expenses/queries'
import {
  assertCanManageOwnedResource,
  expenseOwnerAccountId,
} from '../../../../lib/api/resource-permissions'
import { enqueueBudgetEvaluation } from '../../../../lib/budgets/enqueue'
import { loadGroupMutationContext, apiProcedure } from '../../../init'
import { deleteExpenseOutputSchema } from '../../../outputs/expenses'

export const deleteGroupExpenseProcedure = apiProcedure(
  'spliit:expenses:delete',
)
  .input(
    z
      .object({
        expenseId: z.string().min(1),
        groupId: z.string().min(1),
        scope: z.enum(['OCCURRENCE', 'THIS_AND_FUTURE']).optional(),
        stopRecurrence: z.boolean().optional(),
      })
      .superRefine((input, ctx) => {
        if (
          input.stopRecurrence !== undefined &&
          input.scope !== 'THIS_AND_FUTURE'
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['stopRecurrence'],
            message: 'stopRecurrence is only valid with THIS_AND_FUTURE scope',
          })
        }
      }),
  )
  .output(deleteExpenseOutputSchema)
  .mutation(
    async ({ input: { expenseId, groupId, scope, stopRecurrence }, ctx }) => {
      const { group, member } = await loadGroupMutationContext({
        groupId,
        accountId: ctx.auth.user.id,
      })
      if (group.archived) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'This group is archived and expenses cannot be modified',
        })
      }
      const existingExpense = await getExpense(groupId, expenseId)
      if (!existingExpense) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Expense not found' })
      }
      assertCanManageOwnedResource(
        {
          role: member.role,
          accountId: ctx.auth.user.id,
          createdByAccountId: expenseOwnerAccountId(existingExpense),
        },
        'You can only delete expenses you created',
      )
      await deleteExpense(
        groupId,
        expenseId,
        {
          accountId: ctx.auth.user.id,
        },
        { scope, stopRecurrence },
      )
      await enqueueBudgetEvaluation(groupId)
      return {}
    },
  )
