import { z } from 'zod'

import { prisma } from '@spliit/db'
import {
  getTotalActiveUserPaidFor,
  getTotalActiveUserShare,
  getTotalGroupSpending,
  type TotalsExpense,
} from '@spliit/domain'

import { getGroupBalanceExpenses } from '../../../../lib/api'
import { narrowCategoryId } from '../../../../lib/api/expenses/helpers'
import { toBalanceExpense } from '../../../../lib/api/selects/balance-expense'
import {
  participantDisplayNameSelect,
  type ParticipantDisplayName,
} from '../../../../lib/api/selects/participant-display-name'
import { redactViewerDisplayName } from '../../../../lib/group-view'
import { resolveParticipantDisplayName } from '../../../../lib/invitations'
import {
  groupAccessFields,
  scopedGroupReadProcedure,
  groupViewerArgs,
  loadGroupViewer,
} from '../../../init'
import { getStatsOutputSchema } from '../../../outputs/stats'
import {
  buildGroupStatsDashboard,
  statsPeriods,
  type StatsExpense,
} from './dashboard'

/**
 * The new "active user" is the signed-in account. We resolve it from the
 * server-side membership/ledger participant mapping so the totals no longer
 * depend on the browser's localStorage active-participant selection. For
 * pending invitees (PENDING GroupInvitation, no membership yet), there is no
 * `activeParticipantId` and the per-user totals are 0 — the FE surfaces the
 * Accept/Decline banner in that case.
 */
export const getGroupStatsProcedure = scopedGroupReadProcedure(
  'spliit:groups:read',
)
  .input(
    z.object({
      groupId: z.string().min(1),
      period: z.enum(statsPeriods).default('LATEST_ACTIVITY'),
      customRange: z
        .object({
          from: z.coerce.date(),
          to: z.coerce.date(),
        })
        .refine((range) => range.from <= range.to, {
          message: 'Custom range must end after it starts',
        })
        .describe('Required when period is CUSTOM. Inclusive date range.')
        .optional(),
      ...groupAccessFields,
    }),
  )
  .output(getStatsOutputSchema)
  .query(async ({ input, ctx }) => {
    const { period, customRange } = input
    const { group, member, ledger, viewer } = await loadGroupViewer(
      groupViewerArgs(input, ctx),
    )

    const activeParticipantId = member?.ledgerParticipant?.id ?? null

    const rows = await getGroupBalanceExpenses(group.id, ledger.id)
    const expenses: TotalsExpense[] = rows.map((row) => ({
      ...toBalanceExpense(row),
      expenseDate: row.expenseDate,
    }))

    const totalGroupSpendings = getTotalGroupSpending(expenses)
    const totalParticipantSpendings = getTotalActiveUserPaidFor(
      activeParticipantId,
      expenses,
    )
    const totalParticipantShare = getTotalActiveUserShare(
      activeParticipantId,
      expenses,
    )

    // The lean `BalanceExpense` shape only carries `participant.id`; the
    // dashboard needs `name` + `account` for the participant breakdown UI.
    // Resolve them in a single follow-up `ledgerParticipant.findMany` so the
    // lean main query stays cheap.
    const participantIds = Array.from(
      new Set(
        rows.flatMap((row) => [
          ...row.paidByList.map((share) => share.ledgerParticipantId),
          ...row.paidFor.map((share) => share.ledgerParticipantId),
          ...row.items.flatMap((item) =>
            item.paidFor.map((share) => share.ledgerParticipantId),
          ),
          ...(row.itemizedRemainder?.paidFor.map(
            (share) => share.ledgerParticipantId,
          ) ?? []),
        ]),
      ),
    )
    const participants =
      participantIds.length === 0
        ? ([] as ParticipantDisplayName[])
        : await prisma.ledgerParticipant.findMany({
            where: { id: { in: participantIds } },
            select: participantDisplayNameSelect(),
          })
    const participantDisplay = new Map<string, ParticipantDisplayName>(
      participants.map((participant) => [participant.id, participant]),
    )
    const enrichParticipant = (
      id: string,
    ): {
      id: string
      name?: string
      account?: { id: string; name: string; image: string | null } | null
    } => {
      const participant = participantDisplay.get(id)
      if (!participant) return { id }
      const account = participant.groupMember?.account ?? null
      return {
        id: participant.id,
        name:
          viewer.kind === 'ACTIVE'
            ? resolveParticipantDisplayName(participant)
            : redactViewerDisplayName(
                resolveParticipantDisplayName(participant),
              ),
        account: account
          ? {
              id:
                viewer.kind === 'ACTIVE'
                  ? account.id
                  : `public_${participant.id}`,
              name:
                viewer.kind === 'ACTIVE'
                  ? account.name
                  : redactViewerDisplayName(account.name),
              image: account.image,
            }
          : null,
      }
    }

    const dashboardExpenses: StatsExpense[] = rows.map((row) => ({
      ...toBalanceExpense(row),
      expenseDate: new Date(row.expenseDate),
      expenseTimeZone: row.expenseTimeZone,
      categoryId: narrowCategoryId(row.categoryId),
      paidByList: row.paidByList.map((share) => ({
        shares: share.shares,
        participant: enrichParticipant(share.ledgerParticipantId),
      })),
      paidFor: row.paidFor.map((share) => ({
        shares: share.shares,
        participant: enrichParticipant(share.ledgerParticipantId),
      })),
    }))

    return {
      totalGroupSpendings,
      totalParticipantSpendings,
      totalParticipantShare,
      activeParticipantId,
      dashboard: buildGroupStatsDashboard(
        dashboardExpenses,
        period,
        customRange,
      ),
    }
  })
