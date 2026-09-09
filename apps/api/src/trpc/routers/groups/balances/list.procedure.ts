import { z } from 'zod'

import { prisma } from '@spliit/db'
import {
  getBalances,
  getCurrencyBalanceSummaries,
  getPublicBalances,
  getSuggestedSettlements,
} from '@spliit/domain'
import {
  getIndividualSettlementPlan,
  getSubgroupSettlementPlan,
} from '@spliit/domain/subgroup-settlements'

import { getGroupBalanceExpenses } from '../../../../lib/api/expenses/queries'
import { toBalanceExpense } from '../../../../lib/api/selects/balance-expense'
import { participantDisplayNameSelect } from '../../../../lib/api/selects/participant-display-name'
import {
  mapSubgroup,
  subgroupWithMembersSelect,
} from '../../../../lib/api/subgroups'
import { redactViewerDisplayName } from '../../../../lib/group-view'
import { resolveParticipantDisplayName } from '../../../../lib/invitations/display'
import {
  groupAccessFields,
  scopedGroupReadProcedure,
  groupViewerArgs,
  loadGroupViewer,
} from '../../../init'
import { listBalancesOutputSchema } from '../../../outputs/balances'

export const listGroupBalancesProcedure = scopedGroupReadProcedure(
  'spliit:groups:read',
)
  .input(
    z.object({
      groupId: z.string().min(1),
      ...groupAccessFields,
    }),
  )
  .output(listBalancesOutputSchema)
  .query(async ({ input, ctx }) => {
    const { group, ledger, viewer } = await loadGroupViewer(
      groupViewerArgs(input, ctx),
    )
    const rows = await getGroupBalanceExpenses(group.id, ledger.id)
    const expenses = rows.map(toBalanceExpense)
    const participantIds = Array.from(
      new Set(
        expenses.flatMap((expense) =>
          [...expense.paidByList, ...expense.paidFor].map(
            (share) => share.participant.id,
          ),
        ),
      ),
    )
    const participants =
      participantIds.length === 0
        ? []
        : await prisma.ledgerParticipant.findMany({
            where: { id: { in: participantIds } },
            // A participant can have older accepted/revoked invitations. For
            // the live balances screen, prefer the current pending invite so
            // its temporary name remains visible before acceptance.
            select: participantDisplayNameSelect({
              pendingInvitationsOnly: true,
            }),
          })
    const balances = getBalances(expenses)
    const globalSuggestedSettlements = getSuggestedSettlements(balances)
    const publicBalances = getPublicBalances(globalSuggestedSettlements)
    const subgroupRows = group.subgroupsEnabled
      ? ((await prisma.subgroup.findMany({
          where: { groupId: group.id },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: subgroupWithMembersSelect,
        })) ?? [])
      : []
    const subgroupDefinitions = subgroupRows.map(mapSubgroup)
    const settlementParticipantIds = [
      ...new Set([
        ...participantIds,
        ...subgroupDefinitions.flatMap((subgroup) => subgroup.participantIds),
      ]),
    ]
    const subgroupSettlement = getSubgroupSettlementPlan(
      balances,
      settlementParticipantIds,
      subgroupDefinitions.map((subgroup) => ({
        id: subgroup.id,
        name: subgroup.name,
        memberIds: subgroup.participantIds,
      })),
    )
    const individualSettlement = getIndividualSettlementPlan(
      balances,
      subgroupDefinitions.map((subgroup) => ({
        id: subgroup.id,
        name: subgroup.name,
        memberIds: subgroup.participantIds,
      })),
      settlementParticipantIds,
    )
    const currencyBalances = getCurrencyBalanceSummaries(
      expenses,
      ledger.currencyCode,
    )

    // Soft-removed participants stay in expense history (and thus in balance
    // math) but are excluded from groups.get.participants. Surface them here
    // so the balances UI can label settlement counterparties correctly.
    const publicParticipants = participants.map((participant) => ({
      id: participant.id,
      name:
        viewer.kind === 'ACTIVE'
          ? resolveParticipantDisplayName(participant)
          : redactViewerDisplayName(resolveParticipantDisplayName(participant)),
      removed: participant.removedAt != null,
    }))

    return {
      balances: publicBalances,
      // Keep the root field aligned with the individual settlement
      // projection. Consumers that need subgroup-unit legs should use the
      // structured `settlement` payload below.
      suggestedSettlements: individualSettlement.suggestedSettlements,
      currencyBalances,
      participants: publicParticipants,
      settlement: {
        subgroup: subgroupSettlement,
        individual: individualSettlement,
      },
    }
  })
