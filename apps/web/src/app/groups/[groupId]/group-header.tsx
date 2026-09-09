import {
  Link,
  useLocation,
  useNavigate,
  useSearch,
} from '@tanstack/react-router'
import { ArrowLeft, Check, Info, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { GroupTabs } from '@/app/groups/[groupId]/group-tabs'
import { CreateExpenseFab } from '@/app/groups/create-expense-fab'
import { ViewOnlyBadge } from '@/app/groups/view-only-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { invalidateAccountGroupLists } from '@/lib/invalidate-account-groups'
import { isFocusedMobilePath, isMobileGroupTabPath } from '@/lib/mobile-nav'
import { useCurrentAccount } from '@/lib/use-current-account'
import { trpc } from '@/trpc/client'

import { useCurrentGroup } from './current-group-context'
import { useSavedViewBookmark } from './use-saved-view-bookmark'
import { ViewOnlyBanner } from './view-only-save-offer'

export const GroupHeader = ({
  enableReceiptExtract,
  enableVoiceExpense,
}: {
  enableReceiptExtract: boolean
  enableVoiceExpense: boolean
}) => {
  const {
    isLoading,
    groupId,
    group,
    displayName,
    currentMember,
    currentInvitation,
    linkInviteState,
    viewer,
  } = useCurrentGroup()
  const { t: tGroups } = useTranslation(undefined, { keyPrefix: 'Groups' })
  const { toast } = useToast()
  const { data: account } = useCurrentAccount()
  const persistToAccount = Boolean(account && !account.isAnonymous)
  const savedView = useSavedViewBookmark({
    onSaved: () =>
      toast({
        description: persistToAccount
          ? tGroups('viewOnlyBannerSavedAccount')
          : tGroups('viewOnlyBannerSavedDevice'),
      }),
    onError: (message) =>
      toast({
        description: message,
        variant: 'destructive',
      }),
  })
  const navigate = useNavigate({ from: '/groups/$groupId' })
  const utils = trpc.useUtils()
  const pathname = useLocation({ select: (location) => location.pathname })
  const searchStr = useLocation({ select: (location) => location.searchStr })
  const focusedMobileRoute = isFocusedMobilePath(pathname)
  const mobileGroupTabRoute = isMobileGroupTabPath(pathname)
  const isEditingImportedRow =
    pathname.endsWith('/tools/import') &&
    new URLSearchParams(searchStr).has('editRow')
  const { invite: inviteToken } = useSearch({
    from: '/groups/$groupId',
  })

  const acceptLinkMutation = trpc.invitations.acceptLink.useMutation({
    onSuccess: () => {
      toast({
        description: tGroups('invitationAccepted'),
        variant: 'success',
      })
      void navigate({
        search: (prev) => ({ ...prev, invite: undefined }),
        replace: true,
      })
      void utils.groups.get.invalidate({ groupId })
      void invalidateAccountGroupLists(utils)
      void utils.invitations.listForAccount.invalidate()
      void utils.invitations.list.invalidate({ groupId })
    },
    onError: (err) => {
      toast({
        description: err.message,
        variant: 'destructive',
      })
    },
  })
  const acceptMutation = trpc.invitations.accept.useMutation({
    onSuccess: () => {
      toast({
        description: tGroups('invitationAccepted'),
        variant: 'success',
      })
      void utils.groups.get.invalidate({ groupId })
      void invalidateAccountGroupLists(utils)
      void utils.invitations.listForAccount.invalidate()
      // Full page reload to ensure everything is fresh after joining.
      window.location.reload()
    },
    onError: (err) => {
      toast({
        description: err.message,
        variant: 'destructive',
      })
    },
  })

  const declineMutation = trpc.invitations.decline.useMutation({
    onSuccess: () => {
      toast({ description: tGroups('invitationDeclined') })
      void utils.groups.get.invalidate({ groupId })
      void utils.invitations.listForAccount.invalidate()
      window.location.reload()
    },
    onError: (err) => {
      toast({
        description: err.message,
        variant: 'destructive',
      })
    },
  })

  // For link invites the preview is fetched separately to surface
  // the inviter name and the temporary name in the banner. The
  // preview is only useful while the URL still carries a token and
  // the viewer hasn't accepted yet.
  const previewQuery = trpc.invitations.previewLink.useQuery(
    { token: inviteToken ?? '' },
    { enabled: !!inviteToken, retry: false },
  )

  // Banner state comes from the server-side `linkInviteState` (set
  // by `groups.get` when a token is in the URL). `null` means the
  // URL has no token — we fall back to the regular email-invite
  // banner.
  const showLinkAlreadyMember =
    !!inviteToken &&
    !!currentMember &&
    !isLoading &&
    linkInviteState !== 'ACCEPTED'

  const showLinkExpiredOrInvalid =
    !!inviteToken &&
    !currentMember &&
    !currentInvitation &&
    !isLoading &&
    (linkInviteState === 'EXPIRED' ||
      linkInviteState === 'REVOKED' ||
      linkInviteState === 'DECLINED' ||
      linkInviteState === 'ACCEPTED')

  // Strip the `?invite=<token>` from the URL. Used by the "already a
  // member" banner, where the viewer can stay on the group page.

  const isLinkBanner = currentInvitation?.type === 'LINK'
  const hasMobileBanner = Boolean(
    currentInvitation ||
    showLinkAlreadyMember ||
    showLinkExpiredOrInvalid ||
    group?.archived ||
    savedView.isPublicLink,
  )

  return (
    <div
      className={`flex flex-col justify-between gap-3 ${hasMobileBanner ? 'mb-3 sm:mb-0' : ''}`}
    >
      <div className="mobile-contents items-center justify-between gap-3 sm:flex">
        <h1
          className={`flex min-w-0 items-center gap-2 text-2xl font-bold ${focusedMobileRoute || mobileGroupTabRoute ? 'hidden sm:flex' : ''}`}
        >
          {!isEditingImportedRow ? (
            <Button
              variant="ghost"
              size="icon"
              className="-ms-2"
              nativeButton={false}
              render={<Link to="/" title={tGroups('backToHome')} />}
            >
              <ArrowLeft className="h-5 w-5 rtl:rotate-180" />
            </Button>
          ) : null}
          <Link to="/groups/$groupId" params={{ groupId }} className="truncate">
            {isLoading ? (
              <Skeleton className="mt-1.5 mb-1.5 h-5 w-32" />
            ) : (
              <div className="truncate">{displayName || group.name}</div>
            )}
          </Link>
          {savedView.isPublicLink && savedView.isSaved ? (
            <ViewOnlyBadge compactOnMobile />
          ) : null}
        </h1>
        <CreateExpenseFab
          enableReceiptExtract={enableReceiptExtract}
          enableVoiceExpense={enableVoiceExpense}
        />
      </div>

      {currentInvitation && (
        <Alert data-testid="invitation-banner">
          <AlertTitle>{tGroups('invitationBannerTitle')}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <div className="flex flex-col gap-1">
              <span>
                {isLinkBanner
                  ? tGroups('linkInvitationBannerDescription', {
                      inviter: previewQuery.data?.preview?.inviter.name ?? '',
                      groupName: group.name,
                    })
                  : tGroups('invitationBannerDescription')}
              </span>
              {isLinkBanner && (
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{tGroups('linkInvitationSingleUse')}</span>
                </p>
              )}
              {isLinkBanner && previewQuery.data?.preview?.temporaryName && (
                <p className="text-xs text-muted-foreground">
                  {tGroups('linkInvitationTemporaryName', {
                    name: previewQuery.data.preview.temporaryName,
                  })}
                </p>
              )}
            </div>
            {account ? (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    isLinkBanner
                      ? inviteToken
                        ? acceptLinkMutation.mutate({
                            token: inviteToken,
                          })
                        : undefined
                      : acceptMutation.mutate({
                          invitationId: currentInvitation.id,
                        })
                  }
                  disabled={
                    acceptMutation.isPending ||
                    declineMutation.isPending ||
                    acceptLinkMutation.isPending ||
                    (isLinkBanner && !inviteToken)
                  }
                >
                  <Check className="me-2 h-4 w-4" />
                  {tGroups('invitationAccept')}
                </Button>
                {isLinkBanner ? (
                  // Link invites are one-shot: declining just drops the
                  // token from the URL. The viewer is a non-member so
                  // the bare group URL would surface the "no access"
                  // page — send them to the groups list instead.
                  <Button
                    size="sm"
                    variant="outline"
                    nativeButton={false}
                    render={<Link to="/" />}
                    disabled={acceptLinkMutation.isPending}
                  >
                    <X className="me-2 h-4 w-4" />
                    {tGroups('invitationDecline')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      declineMutation.mutate({
                        invitationId: currentInvitation.id,
                      })
                    }
                    disabled={
                      acceptMutation.isPending || declineMutation.isPending
                    }
                  >
                    <X className="me-2 h-4 w-4" />
                    {tGroups('invitationDecline')}
                  </Button>
                )}
              </div>
            ) : (
              <Button
                size="sm"
                nativeButton={false}
                render={
                  <Link
                    to="/"
                    search={{
                      redirect: inviteToken
                        ? `/groups/${groupId}?invite=${encodeURIComponent(inviteToken)}`
                        : `/groups/${groupId}`,
                      invitation: isLinkBanner ? inviteToken : undefined,
                    }}
                  />
                }
              >
                {tGroups('invitationSignInToAccept')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}

      <ViewOnlyBanner
        isPublicLink={savedView.isPublicLink}
        isSaved={savedView.isSaved}
        persistToAccount={savedView.persistToAccount}
        pending={savedView.pending}
        onSave={savedView.save}
      />

      {showLinkAlreadyMember && (
        <Alert data-testid="invitation-already-member-banner">
          <AlertTitle>
            {tGroups('linkInvitationAlreadyMemberTitle', {
              groupName: group.name,
            })}
          </AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>
              {tGroups('linkInvitationAlreadyMemberDescription', {
                groupName: group.name,
              })}
            </span>
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={
                <Link
                  to="/groups/$groupId"
                  params={{ groupId }}
                  search={{ invite: undefined }}
                />
              }
            >
              {tGroups('linkInvitationDismiss')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {showLinkExpiredOrInvalid && (
        <Alert data-testid="invitation-expired-banner">
          <AlertTitle>{tGroups('linkInvitationExpiredTitle')}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>{tGroups('linkInvitationExpiredDescription')}</span>
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={<Link to="/" />}
            >
              {tGroups('linkInvitationDismiss')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {/* Every valid access source gets the complete navigation. Mutation
          affordances are controlled independently by the access mode. */}
      {viewer && !isLoading && (
        <div className="mobile-contents flex flex-col gap-3 sm:flex">
          <GroupTabs groupId={groupId} />
        </div>
      )}
    </div>
  )
}
