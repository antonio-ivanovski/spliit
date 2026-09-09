import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { prisma } from '@spliit/db'

import { getGroup, getGroupExpensesParticipants } from '../../../lib/api'
import { redactGroupForViewer } from '../../../lib/group-view-redaction'
import {
  groupAccessFields,
  scopedGroupReadProcedure,
  groupViewerArgs,
  loadGroupViewer,
} from '../../init'
import { getGroupDetailsOutputSchema } from '../../outputs/groups'

export const getGroupDetailsProcedure = scopedGroupReadProcedure(
  'spliit:groups:read',
)
  .input(
    z.object({
      groupId: z.string().min(1),
      ...groupAccessFields,
    }),
  )
  .output(getGroupDetailsOutputSchema)
  .query(async ({ input, ctx }) => {
    const { group: accessGroup, viewer } = await loadGroupViewer(
      groupViewerArgs(input, ctx),
    )
    const group = await getGroup(accessGroup.id)
    if (!group) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Group not found.',
      })
    }

    const participantsWithExpenses = await getGroupExpensesParticipants(
      accessGroup.id,
    )
    const hasExpenses = group.ledgerId
      ? (await prisma.expense.count({ where: { ledgerId: group.ledgerId } })) >
        0
      : false
    return {
      group: viewer.kind === 'ACTIVE' ? group : redactGroupForViewer(group),
      participantsWithExpenses,
      hasExpenses,
    }
  })
