import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { GroupType } from '@spliit/db'
import { groupUpdateFormSchema } from '@spliit/domain'

import { updateGroup } from '../../../lib/api'
import { loadGroupMutationContext, apiProcedure } from '../../init'

export const updateGroupProcedure = apiProcedure('spliit:groups:manage')
  .input(
    z.object({
      groupId: z.string().min(1),
      groupFormValues: groupUpdateFormSchema,
    }),
  )
  .output(z.void())
  .mutation(async ({ input: { groupId, groupFormValues }, ctx }) => {
    const { group, member } = await loadGroupMutationContext({
      groupId,
      accountId: ctx.auth.user.id,
    })
    if (member.role !== 'ADMIN') {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Only admins can change group settings',
      })
    }
    if (group.archived) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This group is archived and its settings cannot be modified',
      })
    }
    if (
      group.groupType === GroupType.FRIEND &&
      groupFormValues.name !== group.name
    ) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'friendLedgerNotRenamable',
      })
    }
    await updateGroup(groupId, groupFormValues, {
      accountId: ctx.auth.user.id,
    })
  })
