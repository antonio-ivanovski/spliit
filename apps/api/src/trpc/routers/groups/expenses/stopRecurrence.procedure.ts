import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { stopRecurrence } from '../../../../lib/api'
import { getExpense } from '../../../../lib/api/expenses/queries'
import {
  assertCanManageOwnedResource,
  expenseOwnerAccountId,
} from '../../../../lib/api/resource-permissions'
import { loadGroupMutationContext, apiProcedure } from '../../../init'
import { deleteExpenseOutputSchema } from '../../../outputs/expenses'

export const stopRecurrenceProcedure = apiProcedure('spliit:expenses:manage')
  .input(
    z.object({
      expenseId: z.string().min(1),
      groupId: z.string().min(1),
    }),
  )
  .output(deleteExpenseOutputSchema)
  .mutation(async ({ input: { expenseId, groupId }, ctx }) => {
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
      'You can only manage recurring expenses you created',
    )
    await stopRecurrence(groupId, expenseId, { accountId: ctx.auth.user.id })
    return {}
  })
