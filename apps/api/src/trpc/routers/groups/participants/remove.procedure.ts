import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { GroupRole, GroupType, prisma } from '@spliit/db'

import { RemoveMemberPreconditionError } from '../../../../lib/api/members'
import { canRevokeInvitation } from '../../../../lib/api/resource-permissions'
import {
  SoftRemoveParticipantPreconditionError,
  getSoftRemoveParticipantPreview,
  softRemoveParticipant,
} from '../../../../lib/api/soft-remove-participant'
import { SPLIIT_SCOPES } from '../../../../lib/auth/scopes'
import { RevokeInvitationPreconditionError } from '../../../../lib/invitations'
import { isInvitationParticipantUnused } from '../../../../lib/invitations/email-invitations'
import {
  apiProcedure,
  assertOAuthScope,
  loadGroupMutationContext,
} from '../../../init'
import {
  participantRemovalOutputSchema,
  participantRemovalPreviewOutputSchema,
} from '../../../outputs/members'

async function assertParticipantManagementAllowed(
  groupType: GroupType,
  role: GroupRole,
  args: {
    groupId: string
    accountId: string
    ledgerParticipantId: string
  },
) {
  if (groupType === GroupType.FRIEND) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Friend ledger participant management is not allowed',
    })
  }
  if (role === GroupRole.ADMIN) return

  const invitation = await prisma.groupInvitation.findFirst({
    where: {
      groupId: args.groupId,
      ledgerParticipantId: args.ledgerParticipantId,
      status: 'PENDING',
    },
    select: { invitedById: true, ledgerParticipantId: true },
  })
  const isUnused = invitation
    ? await isInvitationParticipantUnused({
        groupId: args.groupId,
        ledgerParticipantId: invitation.ledgerParticipantId,
      })
    : false
  if (
    !invitation ||
    !canRevokeInvitation({
      role,
      accountId: args.accountId,
      invitedById: invitation.invitedById,
      isUnused,
    })
  ) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message:
        invitation?.invitedById === args.accountId
          ? 'Only an admin can remove an invitation already used in expenses'
          : 'Only admins can manage participants',
    })
  }
}

function mapRemoveError(error: unknown): never {
  if (
    error instanceof SoftRemoveParticipantPreconditionError ||
    error instanceof RemoveMemberPreconditionError ||
    error instanceof RevokeInvitationPreconditionError
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: error.message,
    })
  }
  if (error instanceof Error) {
    if (error.message === 'Participant not found') {
      throw new TRPCError({ code: 'NOT_FOUND', message: error.message })
    }
    if (
      error.message === 'Member not found in this group' ||
      error.message === 'Member is not active' ||
      error.message.includes('cannot remove yourself') ||
      error.message === 'Group must keep at least one admin' ||
      error.message === 'Friend ledger participant management is not allowed'
    ) {
      throw new TRPCError({
        code:
          error.message ===
          'Friend ledger participant management is not allowed'
            ? 'FORBIDDEN'
            : 'BAD_REQUEST',
        message: error.message,
      })
    }
  }
  throw error
}

export const removeParticipantPreviewProcedure = apiProcedure(
  'spliit:groups:read',
)
  .input(
    z.object({
      groupId: z.string().min(1),
      ledgerParticipantId: z.string().min(1),
    }),
  )
  .output(participantRemovalPreviewOutputSchema)
  .query(async ({ input: { groupId, ledgerParticipantId }, ctx }) => {
    const { group, member } = await loadGroupMutationContext({
      groupId,
      accountId: ctx.auth.user.id,
    })
    await assertParticipantManagementAllowed(group.groupType, member.role, {
      groupId,
      accountId: ctx.auth.user.id,
      ledgerParticipantId,
    })

    try {
      return await getSoftRemoveParticipantPreview({
        groupId,
        ledgerId: group.ledgerId,
        ledgerParticipantId,
      })
    } catch (error) {
      mapRemoveError(error)
    }
  })

/**
 * Remove a participant. OAuth callers that ask to settle balances also need
 * `spliit:expenses:manage`, because settlement materializes expenses.
 */
export const removeParticipantProcedure = apiProcedure('spliit:groups:delete')
  .input(
    z.object({
      groupId: z.string().min(1),
      ledgerParticipantId: z.string().min(1),
      settleBalances: z.boolean().optional(),
    }),
  )
  .output(participantRemovalOutputSchema)
  .mutation(async ({ input, ctx }) => {
    const { group, member } = await loadGroupMutationContext({
      groupId: input.groupId,
      accountId: ctx.auth.user.id,
    })
    await assertParticipantManagementAllowed(group.groupType, member.role, {
      groupId: input.groupId,
      accountId: ctx.auth.user.id,
      ledgerParticipantId: input.ledgerParticipantId,
    })
    if (group.archived) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This group is archived; participant management is disabled',
      })
    }
    if (input.settleBalances) {
      // Settlement creates expenses; keep that authority separate from the
      // permission to remove a participant.
      assertOAuthScope(ctx.auth, SPLIIT_SCOPES.expensesManage)
    }

    try {
      return await softRemoveParticipant({
        groupId: input.groupId,
        ledgerId: group.ledgerId,
        ledgerParticipantId: input.ledgerParticipantId,
        settleBalances: input.settleBalances,
        actor: { accountId: ctx.auth.user.id },
        groupType: group.groupType,
      })
    } catch (error) {
      mapRemoveError(error)
    }
  })
