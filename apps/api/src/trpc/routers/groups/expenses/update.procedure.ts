import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { expenseApiSchema } from '@spliit/domain'

import { getExpense } from '../../../../lib/api/expenses/queries'
import {
  ExpenseVersionConflictError,
  updateExpense,
} from '../../../../lib/api/expenses/update-expense'
import {
  assertCanManageOwnedResource,
  expenseOwnerAccountId,
} from '../../../../lib/api/resource-permissions'
import { enqueueBudgetEvaluation } from '../../../../lib/budgets/enqueue'
import { ConversionError } from '../../../../lib/expense-conversion'
import {
  apiProcedure,
  assertScopeForDestructiveEdit,
  loadGroupMutationContext,
} from '../../../init'
import { updateExpenseOutputSchema } from '../../../outputs/expenses'

export const updateGroupExpenseProcedure = apiProcedure(
  'spliit:expenses:manage',
)
  .input(
    z.object({
      expenseId: z.string().min(1),
      groupId: z.string().min(1),
      expectedVersion: z.number().int().positive(),
      expense: expenseApiSchema,
      scope: z.enum(['OCCURRENCE', 'THIS_AND_FUTURE']).optional(),
    }),
  )
  .output(updateExpenseOutputSchema)
  .mutation(
    async ({
      input: { expenseId, groupId, expectedVersion, expense, scope },
      ctx,
    }) => {
      // A `THIS_AND_FUTURE` edit reshapes the series: occurrences that no
      // longer fit the new schedule are dropped, along with their documents in
      // object storage. That is a deletion whatever the verb on the procedure
      // says, so a token has to hold the delete scope to ask for it.
      if (scope === 'THIS_AND_FUTURE') {
        assertScopeForDestructiveEdit(ctx.auth)
      }
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
        'You can only edit expenses you created',
      )
      try {
        const { id, version } = await updateExpense(
          groupId,
          expenseId,
          expense,
          {
            accountId: ctx.auth.user.id,
          },
          { expectedVersion, scope },
        )
        await enqueueBudgetEvaluation(groupId)
        return { expenseId: id, version }
      } catch (err) {
        if (err instanceof ConversionError) {
          throw new TRPCError({
            code:
              err.code === 'PROVIDER_UNAVAILABLE'
                ? 'BAD_GATEWAY'
                : 'BAD_REQUEST',
            message: err.message,
          })
        }
        if (err instanceof ExpenseVersionConflictError) {
          throw new TRPCError({ code: 'CONFLICT', message: err.message })
        }
        throw err
      }
    },
  )
