import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { expenseApiSchema } from '@spliit/domain'

import {
  createExpense,
  prepareExpenseCreate,
} from '../../../../lib/api/expenses/create-expense'
import {
  CREATE_OPERATIONS,
  createRequestIdSchema,
  runIdempotentCreate,
} from '../../../../lib/api/idempotency'
import { enqueueBudgetEvaluation } from '../../../../lib/budgets/enqueue'
import { ConversionError } from '../../../../lib/expense-conversion'
import { loadGroupMutationContext, apiProcedure } from '../../../init'
import { createExpenseOutputSchema } from '../../../outputs/expenses'

export const createGroupExpenseProcedure = apiProcedure(
  'spliit:expenses:manage',
)
  .input(
    z.object({
      groupId: z.string().min(1),
      requestId: createRequestIdSchema,
      expense: expenseApiSchema,
    }),
  )
  .output(createExpenseOutputSchema)
  .mutation(async ({ input: { groupId, requestId, expense }, ctx }) => {
    const { group } = await loadGroupMutationContext({
      groupId,
      accountId: ctx.auth.user.id,
    })
    if (group.archived) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This group is archived and no new expenses can be added',
      })
    }
    const account = ctx.auth.user
    try {
      const { value, replayed } = await runIdempotentCreate({
        accountId: account.id,
        operation: CREATE_OPERATIONS.expense,
        requestId,
        input: { groupId, expense },
        prepare: () => prepareExpenseCreate(expense, groupId),
        execute: async (tx, prepared) => {
          const created = await createExpense(
            expense,
            groupId,
            { accountId: account.id },
            { prepared, tx },
          )
          return {
            expenseId: created.id,
            recurringSeriesId: created.recurringSeriesId ?? null,
          }
        },
      })
      if (!replayed) await enqueueBudgetEvaluation(groupId)
      return value
    } catch (err) {
      if (err instanceof ConversionError) {
        throw new TRPCError({
          code:
            err.code === 'PROVIDER_UNAVAILABLE' ? 'BAD_GATEWAY' : 'BAD_REQUEST',
          message: err.message,
        })
      }
      throw err
    }
  })
