import { KeyRound, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogClose,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { useToast } from '@/components/ui/use-toast'
import { cn } from '@/lib/utils'
import { trpc } from '@/trpc/client'
import type { AppRouterOutput } from '@spliit/api/router'

import {
  SettingsBadge,
  SettingsList,
  SettingsRow,
  SettingsSection,
} from './settings-ui'

type AuthorizedClient =
  AppRouterOutput['account']['authorizedClients']['clients'][number]

/**
 * Translation key per scope. A scope with no entry falls back to its raw name,
 * which is ugly but honest: better an unfamiliar string than a wrong label.
 */
const SCOPE_LABELS = {
  'spliit:groups:read': 'AccountAuthorizedClients.scopeGroupsRead',
  'spliit:groups:manage': 'AccountAuthorizedClients.scopeGroupsManage',
  'spliit:groups:delete': 'AccountAuthorizedClients.scopeGroupsDelete',
  'spliit:expenses:read': 'AccountAuthorizedClients.scopeExpensesRead',
  'spliit:expenses:manage': 'AccountAuthorizedClients.scopeExpensesManage',
  'spliit:expenses:delete': 'AccountAuthorizedClients.scopeExpensesDelete',
  'spliit:expenses:write': 'AccountAuthorizedClients.scopeExpensesWrite',
} as const

type KnownScope = keyof typeof SCOPE_LABELS

function isKnownScope(scope: string): scope is KnownScope {
  return scope in SCOPE_LABELS
}

/** OIDC scopes say nothing about what an app can reach in Spliit Cloud. */
function meaningfulScopes(scopes: string[]): string[] {
  return scopes.filter((scope) => scope.startsWith('spliit:'))
}

export function AuthorizedClients() {
  const { t, i18n } = useTranslation()
  const { toast } = useToast()
  const utils = trpc.useUtils()
  const [pendingRevoke, setPendingRevoke] = useState<AuthorizedClient | null>(
    null,
  )

  const authorized = trpc.account.authorizedClients.useQuery()
  const revoke = trpc.account.revokeAuthorizedClient.useMutation({
    onSuccess: async () => {
      await utils.account.authorizedClients.invalidate()
      toast({ title: t('AccountAuthorizedClients.revoked') })
      setPendingRevoke(null)
    },
    onError: () => {
      toast({
        title: t('AccountAuthorizedClients.revokeFailed'),
        variant: 'destructive',
      })
    },
  })

  const clients = authorized.data?.clients ?? []
  const dateFormat = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
  })

  return (
    <>
      <SettingsSection
        id="authorized-clients"
        title={t('AccountAuthorizedClients.title')}
        description={t('AccountAuthorizedClients.description')}
        icon={KeyRound}
      >
        {authorized.isPending || authorized.isError || clients.length === 0 ? (
          <p
            className={cn(
              'px-4 pb-4 text-sm sm:px-6 sm:pb-5',
              authorized.isError ? 'text-destructive' : 'text-muted-foreground',
            )}
            role={authorized.isError ? 'alert' : undefined}
          >
            {authorized.isPending
              ? t('AccountAuthorizedClients.loading')
              : authorized.isError
                ? t('AccountAuthorizedClients.loadFailed')
                : t('AccountAuthorizedClients.empty')}
          </p>
        ) : (
          <SettingsList className="border-t border-border/70">
            {clients.map((client) => (
              <SettingsRow
                key={client.consentId}
                id={`authorized-client-${client.consentId}`}
                label={
                  client.name ?? t('AccountAuthorizedClients.unnamedClient')
                }
                description={
                  <div className="flex flex-col gap-1.5">
                    <div className="flex flex-wrap gap-1.5">
                      {meaningfulScopes(client.scopes).map((scope) => (
                        <SettingsBadge key={scope}>
                          {isKnownScope(scope) ? t(SCOPE_LABELS[scope]) : scope}
                        </SettingsBadge>
                      ))}
                    </div>
                    {client.authorizedAt ? (
                      <span>
                        {t('AccountAuthorizedClients.authorizedOn', {
                          date: dateFormat.format(
                            new Date(client.authorizedAt),
                          ),
                        })}
                      </span>
                    ) : null}
                  </div>
                }
                control={
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() => setPendingRevoke(client)}
                  >
                    {t('AccountAuthorizedClients.revoke')}
                  </Button>
                }
              />
            ))}
          </SettingsList>
        )}
      </SettingsSection>

      <ResponsiveDialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRevoke(null)
        }}
      >
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>
              {t('AccountAuthorizedClients.confirmTitle', {
                name:
                  pendingRevoke?.name ??
                  t('AccountAuthorizedClients.unnamedClient'),
              })}
            </ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              {t('AccountAuthorizedClients.confirmDescription')}
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody>
            <p className="text-sm text-muted-foreground">
              {t('AccountAuthorizedClients.confirmGracePeriod')}
            </p>
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <ResponsiveDialogClose
              render={
                <Button type="button" variant="outline">
                  {t('AccountAuthorizedClients.cancel')}
                </Button>
              }
            />
            <Button
              variant="destructive"
              disabled={revoke.isPending}
              onClick={() => {
                if (pendingRevoke) {
                  revoke.mutate({ consentId: pendingRevoke.consentId })
                }
              }}
            >
              {revoke.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {t('AccountAuthorizedClients.revoke')}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    </>
  )
}
