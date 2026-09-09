import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  GroupInvitationStatus,
  GroupInvitationType,
  GroupType,
  prisma,
} from '@spliit/db'

import { getGroup } from '../../../lib/api/groups'
import { redactViewerDisplayName } from '../../../lib/group-view'
import { redactGroupForViewer } from '../../../lib/group-view-redaction'
import { getInvitationDisplayName } from '../../../lib/invitations/display'
import {
  acceptLinkInvitation,
  hashLinkToken,
} from '../../../lib/invitations/link-invitations'
import {
  groupAccessFields,
  scopedGroupReadProcedure,
  groupViewerArgs,
  loadGroupMutationContext,
  loadGroupViewer,
} from '../../init'
import { getGroupOutputSchema } from '../../outputs/groups'

export type LinkInviteState =
  | 'PENDING'
  | 'ACCEPTED'
  | 'REVOKED'
  | 'DECLINED'
  | 'EXPIRED'

export const getGroupProcedure = scopedGroupReadProcedure('spliit:groups:read')
  .input(
    z.object({
      groupId: z.string().min(1),
      ...groupAccessFields,
    }),
  )
  .output(getGroupOutputSchema)
  .query(async ({ input, ctx }) => {
    const account = ctx.auth?.user
    const isOAuth =
      ctx.auth != null &&
      'credentialKind' in ctx.auth &&
      ctx.auth.credentialKind === 'oauth'
    let access = await loadGroupViewer(groupViewerArgs(input, ctx))

    if (
      account &&
      !isOAuth &&
      input.linkInviteToken &&
      access.group.groupType === GroupType.FRIEND &&
      access.viewer.kind === 'PENDING_INVITEE'
    ) {
      try {
        await acceptLinkInvitation({
          token: input.linkInviteToken,
          accountId: account.id,
        })
        access = await loadGroupViewer(groupViewerArgs(input, ctx))
      } catch {
        // A concurrent request may have consumed or revoked the invitation.
      }
    }

    const group = await getGroup(access.group.id)
    if (!group) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Group not found' })
    }

    const hasSavedView = await accountHasSavedView(account?.id, group.id)

    if (access.viewer.kind === 'ACTIVE' && account) {
      const { member } = await loadGroupMutationContext({
        groupId: access.group.id,
        accountId: account.id,
      })
      const linkInviteState = input.linkInviteToken
        ? await resolveLinkInviteState(access.group.id, input.linkInviteToken)
        : null
      return {
        group,
        displayName: resolveDisplayName(group, account.id),
        currentLedgerParticipantId: member.ledgerParticipant?.id ?? null,
        currentMember: {
          id: member.id,
          role: member.role,
          status: member.status,
        },
        currentInvitation: null,
        linkInviteState,
        viewer: {
          source: 'MEMBER' as const,
          access: 'READ_WRITE' as const,
          canMutate: true,
          canAcceptInvitation: false,
        },
        hasSavedView,
      }
    }

    const invitation =
      access.viewer.kind === 'PENDING_INVITEE' ? access.viewer.invitation : null
    const shouldRedact = !account || access.viewer.kind === 'PUBLIC_VIEW'
    const displayName = resolveDisplayName(group, account?.id ?? '')

    return {
      group: shouldRedact ? redactGroupForViewer(group) : group,
      displayName: shouldRedact
        ? redactViewerDisplayName(displayName)
        : displayName,
      currentLedgerParticipantId: null,
      currentMember: null,
      currentInvitation: invitation,
      linkInviteState:
        invitation?.type === 'LINK' ? ('PENDING' as const) : null,
      viewer: {
        source:
          access.viewer.kind === 'PUBLIC_VIEW'
            ? ('PUBLIC_LINK' as const)
            : ('PENDING_INVITATION' as const),
        access: 'READ_ONLY' as const,
        canMutate: false,
        canAcceptInvitation: invitation != null && !isOAuth,
      },
      hasSavedView,
    }
  })

async function accountHasSavedView(
  accountId: string | undefined,
  groupId: string,
) {
  if (!accountId) return false
  const row = await prisma.accountSavedView.findUnique({
    where: { accountId_groupId: { accountId, groupId } },
    select: { id: true },
  })
  return row != null
}

function resolveDisplayName(
  group: NonNullable<Awaited<ReturnType<typeof getGroup>>>,
  viewerAccountId: string,
): string {
  if (group.groupType !== GroupType.FRIEND) return group.name
  const peerMember = group.members.find((m) => m.accountId !== viewerAccountId)
  if (peerMember?.account.name) return peerMember.account.name
  const pendingInv = group.invitations[0]
  if (pendingInv?.temporaryName) return pendingInv.temporaryName
  if (pendingInv?.email) return getInvitationDisplayName(pendingInv)
  return ''
}

async function resolveLinkInviteState(
  groupId: string,
  linkInviteToken: string,
): Promise<LinkInviteState | null> {
  const tokenHash = await hashLinkToken(linkInviteToken)
  const row = await prisma.groupInvitation.findFirst({
    where: { groupId, type: GroupInvitationType.LINK, tokenHash },
    select: { status: true, expiresAt: true },
  })
  if (!row) return null
  if (row.status === GroupInvitationStatus.PENDING) {
    if (row.expiresAt && row.expiresAt < new Date()) return 'EXPIRED'
    return 'PENDING'
  }
  if (row.status === GroupInvitationStatus.ACCEPTED) return 'ACCEPTED'
  if (row.status === GroupInvitationStatus.REVOKED) return 'REVOKED'
  if (row.status === GroupInvitationStatus.DECLINED) return 'DECLINED'
  return null
}
