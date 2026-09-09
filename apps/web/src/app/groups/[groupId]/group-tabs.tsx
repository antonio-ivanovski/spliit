import { Link, useLocation, useNavigate } from '@tanstack/react-router'
import { Archive as ArchiveIcon, ArchiveRestore } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/use-toast'
import { invalidateAccountGroupLists } from '@/lib/invalidate-account-groups'
import { shouldHideMobileGroupTabs } from '@/lib/mobile-nav'
import { trpc } from '@/trpc/client'

import { useCurrentGroup } from './current-group-context'

const GROUP_TAB_TO = {
  expenses: '/groups/$groupId/expenses',
  balances: '/groups/$groupId/balances',
  stats: '/groups/$groupId/stats',
  budgets: '/groups/$groupId/budgets',
  activity: '/groups/$groupId/activity',
  members: '/groups/$groupId/members',
  tools: '/groups/$groupId/tools',
  edit: '/groups/$groupId/edit',
} as const

type GroupTab = keyof typeof GROUP_TAB_TO

function isGroupTab(value: string): value is GroupTab {
  return Object.hasOwn(GROUP_TAB_TO, value)
}

type Props = {
  groupId: string
}

export function GroupTabs({ groupId }: Props) {
  const { t } = useTranslation()
  const { t: tGroups } = useTranslation(undefined, { keyPrefix: 'Groups' })
  const pathname = useLocation({ select: (location) => location.pathname })
  const hideMobileTabs = shouldHideMobileGroupTabs(pathname)
  const value =
    pathname.replace(/\/groups\/[^/]+\/([^/]+).*/, '$1') || 'expenses'
  const navigate = useNavigate()
  const utils = trpc.useUtils()
  const { toast } = useToast()
  const { mutateAsync: archiveGroup } = trpc.groups.archive.useMutation()
  const { group, currentMember, viewer } = useCurrentGroup()
  const { data } = trpc.account.members.useQuery(
    { groupId },
    { enabled: viewer?.source === 'MEMBER' || !!currentMember },
  )
  const memberCount = data?.members?.length ?? group?.members.length ?? 0
  // The "Settings" tab is also the member-accessible home for export.
  // Members see a read-only settings view; admins additionally see the
  // group editing and lifecycle controls.
  const canViewSettings = !!viewer
  const canUnarchive = !!group?.archived && currentMember?.role === 'ADMIN'
  const isArchived = !!group?.archived
  // FRIEND-typed ledgers are strictly 2 people, so the Members tab is
  // redundant (the peer is shown on the card already) and is hidden.
  const isFriendLedger = group?.groupType === 'FRIEND'

  async function handleUnarchive() {
    try {
      await archiveGroup({ groupId, archived: false })
      await Promise.all([
        invalidateAccountGroupLists(utils),
        utils.groups.get.invalidate({ groupId }),
      ])
      toast({ description: tGroups('bannerUnarchiveSuccess') })
    } catch (error) {
      toast({
        description:
          error instanceof Error ? error.message : tGroups('unarchiveSuccess'),
        variant: 'destructive',
      })
    }
  }

  return (
    <>
      {isArchived && (
        <Alert>
          <ArchiveIcon className="h-4 w-4" />
          <AlertTitle>{tGroups('bannerArchivedTitle')}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>{tGroups('bannerArchivedDescription')}</span>
            {canUnarchive && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void handleUnarchive()}
              >
                <ArchiveRestore className="me-2 h-4 w-4" />
                {tGroups('bannerUnarchive')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      <div className={hideMobileTabs ? 'hidden sm:block' : undefined}>
        <Tabs
          value={value}
          className="overflow-x-auto *:border"
          onValueChange={(next) => {
            if (!isGroupTab(next)) return
            void navigate({
              to: GROUP_TAB_TO[next],
              params: { groupId },
            })
          }}
        >
          <TabsList>
            <TabsTrigger
              value="expenses"
              nativeButton={false}
              render={<Link to={GROUP_TAB_TO.expenses} params={{ groupId }} />}
            >
              {t('Expenses.title')}
            </TabsTrigger>
            <TabsTrigger
              value="balances"
              nativeButton={false}
              render={<Link to={GROUP_TAB_TO.balances} params={{ groupId }} />}
            >
              {t('Balances.title')}
            </TabsTrigger>
            <TabsTrigger
              value="stats"
              nativeButton={false}
              render={<Link to={GROUP_TAB_TO.stats} params={{ groupId }} />}
            >
              {t('Stats.title')}
            </TabsTrigger>
            <TabsTrigger
              value="budgets"
              nativeButton={false}
              render={<Link to={GROUP_TAB_TO.budgets} params={{ groupId }} />}
            >
              {t('Budgets.title')}
            </TabsTrigger>
            <TabsTrigger
              value="activity"
              nativeButton={false}
              render={<Link to={GROUP_TAB_TO.activity} params={{ groupId }} />}
            >
              {t('Activity.title')}
            </TabsTrigger>
            {!isFriendLedger && (
              <TabsTrigger
                value="members"
                className="flex items-center gap-2"
                nativeButton={false}
                render={<Link to={GROUP_TAB_TO.members} params={{ groupId }} />}
              >
                <span>{t('Members.title')}</span>
                {memberCount > 0 && (
                  <Badge
                    variant="outline"
                    className="border-current px-1.5 py-0 text-current"
                  >
                    {memberCount}
                  </Badge>
                )}
              </TabsTrigger>
            )}
            <TabsTrigger
              value="tools"
              nativeButton={false}
              render={<Link to={GROUP_TAB_TO.tools} params={{ groupId }} />}
            >
              {t('Tools.title')}
            </TabsTrigger>
            {canViewSettings && (
              <TabsTrigger
                value="edit"
                nativeButton={false}
                render={<Link to={GROUP_TAB_TO.edit} params={{ groupId }} />}
              >
                {t('Settings.title')}
              </TabsTrigger>
            )}
          </TabsList>
        </Tabs>
      </div>
    </>
  )
}
