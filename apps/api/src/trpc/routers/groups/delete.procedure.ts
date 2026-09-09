import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { GroupType } from '@spliit/db'

import { deleteGroup } from '../../../lib/api'
import { loadGroupMutationContext, apiProcedure } from '../../init'
import { deleteGroupOutputSchema } from '../../outputs/groups'

/**
 * Permanently delete a group, its ledger, expenses, invitations, and attached
 * S3 documents. ADMIN-only: surfaced on the group settings page, gated to
 * admins by the surrounding UI.
 *
 * The procedure does not take a `confirmDelete` flag: the surrounding dialog
 * requires the caller to check an "I understand" box before it enables the
 * destructive button, so the confirmation lives in the UI rather than the API.
 * Keeping the API narrow also lets any future cleanup jobs reuse `deleteGroup`
 * directly without changing the mutation shape.
 *
 * Archived groups are rejected: there is nothing left to delete and the setting
 * already shows the group as read-only.
 */
export const deleteGroupProcedure = apiProcedure('spliit:groups:delete')
  .input(
    z.object({
      groupId: z.string().min(1),
    }),
  )
  .output(deleteGroupOutputSchema)
  .mutation(async ({ input: { groupId }, ctx }) => {
    const { group, member } = await loadGroupMutationContext({
      groupId,
      accountId: ctx.auth.user.id,
    })
    if (member.role !== 'ADMIN') {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Only admins can delete a group',
      })
    }
    if (group.archived) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This group is already archived',
      })
    }
    if (group.groupType === GroupType.FRIEND) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'friendLedgerNotDeletable',
      })
    }

    try {
      return await deleteGroup({
        groupId,
        actor: { accountId: ctx.auth.user.id },
      })
    } catch (err) {
      if (err instanceof TRPCError) throw err
      const message =
        err instanceof Error ? err.message : 'Unable to delete the group'
      if (/invalid group id/i.test(message)) {
        throw new TRPCError({ code: 'NOT_FOUND', message })
      }
      throw new TRPCError({ code: 'BAD_REQUEST', message })
    }
  })
