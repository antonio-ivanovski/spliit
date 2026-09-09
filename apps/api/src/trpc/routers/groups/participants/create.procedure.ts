import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { GroupType, LedgerParticipantKind } from '@spliit/db'

import {
  CREATE_OPERATIONS,
  createRequestIdSchema,
  runIdempotentCreate,
} from '../../../../lib/api/idempotency'
import { randomId } from '../../../../lib/api/shared'
import { loadGroupMutationContext, apiProcedure } from '../../../init'
import { createParticipantOutputSchema } from '../../../outputs/members'

/**
 * Create a name-only participant. This is intentionally available to every
 * active member: it creates a ledger row, not a membership or invitation.
 */
export const createParticipantProcedure = apiProcedure('spliit:groups:manage')
  .input(
    z.object({
      groupId: z.string().min(1),
      requestId: createRequestIdSchema,
      displayName: z.string().trim().min(1).max(120),
    }),
  )
  .output(createParticipantOutputSchema)
  .mutation(async ({ input, ctx }) => {
    const { group } = await loadGroupMutationContext({
      groupId: input.groupId,
      accountId: ctx.auth.user.id,
    })

    if (group.archived) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Archived groups cannot add participants',
      })
    }
    if (group.groupType === GroupType.FRIEND) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Friend ledger participants cannot be added here',
      })
    }
    if (!group.ledgerId) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'This group has no ledger',
      })
    }

    const { value } = await runIdempotentCreate({
      accountId: ctx.auth.user.id,
      operation: CREATE_OPERATIONS.participant,
      requestId: input.requestId,
      input: { groupId: input.groupId, displayName: input.displayName },
      execute: (tx) =>
        tx.ledgerParticipant
          .create({
            data: {
              id: randomId(),
              ledgerId: group.ledgerId,
              kind: LedgerParticipantKind.UNLINKED_PARTICIPANT,
              displayName: input.displayName,
            },
            select: { id: true, displayName: true },
          })
          .then((participant) => ({
            ledgerParticipantId: participant.id,
            displayName: participant.displayName!,
          })),
    })
    return value
  })
