import { useQuery } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import {
  ArrowRight,
  Database,
  Eye,
  Loader2,
  LockKeyhole,
  Plug,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { AccountAvatar } from '@/components/account-avatar'
import { Button } from '@/components/ui/button'
import { authClient } from '@/lib/auth'

import {
  getOAuthPublicClient,
  readOAuthRequest,
  resolveOAuthQuery,
  submitConsent,
} from './oauth-api'
import {
  describeScopes,
  KNOWN_SCOPES,
  OIDC_SCOPES,
} from './oauth-consent-scopes'
import { OAuthShell } from './oauth-shell'

const route = getRouteApi('/oauth/consent')

function readExternalHttpUrl(value: string | undefined) {
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return { href: url.toString(), host: url.host }
  } catch {
    return null
  }
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Where the authorization response will be sent. Parsed from the same signed
 * `oauth_query` as the client identity and scopes — never from separate search
 * params — so the destination shown is the one that receives the code.
 */
function describeRedirectDestination(value: string | undefined) {
  if (!value) return null
  try {
    const url = new URL(value)
    const isHttp = url.protocol === 'https:' || url.protocol === 'http:'
    return {
      href: url.toString(),
      // `host` keeps the port, which matters for loopback redirects. Custom
      // schemes (native apps) can have an empty host; show the full URI then.
      display: isHttp && url.host ? url.host : url.toString(),
      isLoopback: isHttp && LOOPBACK_HOSTNAMES.has(url.hostname),
    }
  } catch {
    return null
  }
}

export function OAuthConsentPage() {
  const { t } = useTranslation(undefined, { keyPrefix: 'OAuth.consent' })
  const { oauth_query: explicitOAuthQuery } = route.useSearch()
  const oauthQuery = resolveOAuthQuery(explicitOAuthQuery)
  // Identity, scopes and redirect target are read from the signed request
  // itself, never from separate search params, so what is shown is what gets
  // authorized.
  const { clientId, redirectUri, scopes } = readOAuthRequest(oauthQuery)
  const redirectDestination = describeRedirectDestination(redirectUri)
  const { data: session, isPending: sessionPending } = authClient.useSession()
  const client = useQuery({
    queryKey: ['oauth-public-client', clientId],
    queryFn: () => getOAuthPublicClient(clientId ?? ''),
    enabled: Boolean(clientId),
    retry: false,
  })
  const [pending, setPending] = useState<'accept' | 'deny' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const grants = describeScopes(scopes)
  const unknownScopes = scopes.filter(
    (scope) => !KNOWN_SCOPES.has(scope) && !OIDC_SCOPES.has(scope),
  )
  const clientName = client.data?.client_name ?? t('defaultClient')
  const clientWebsite = readExternalHttpUrl(client.data?.client_uri)
  const privacyPolicy = readExternalHttpUrl(client.data?.policy_uri)
  const clientError =
    !oauthQuery || !clientId
      ? t('missingRequest')
      : client.isError
        ? t('clientUnavailable')
        : null
  const account = session?.user
  // Approving is only meaningful once the account is known, the client has
  // been resolved, and every requested scope is one we can name.
  const canApprove =
    Boolean(account) &&
    Boolean(client.data) &&
    !client.isPending &&
    !client.isError &&
    unknownScopes.length === 0 &&
    pending === null

  async function decide(accept: boolean) {
    if (!oauthQuery) {
      setError(t('missingRequest'))
      return
    }
    setPending(accept ? 'accept' : 'deny')
    setError(null)
    await submitConsent({ accept, oauthQuery }).catch((cause) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      setPending(null)
    })
  }

  return (
    <OAuthShell
      title={t('title', { client: clientName })}
      description={t('description')}
    >
      <div className="grid gap-3">
        <section
          className="relative min-w-0 overflow-hidden rounded-xl border border-primary/20 bg-primary/[0.045] px-3 py-2.5 sm:px-3.5"
          aria-label={t('connectionDetails')}
          data-testid="oauth-connection-panel"
        >
          <div className="absolute -end-12 -top-12 size-24 rounded-full bg-primary/10 blur-2xl" />
          <div className="relative grid min-w-0 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-3">
            <IdentitySummary label={t('spliitAccount')}>
              {sessionPending ? (
                <Loader2 className="size-5 animate-spin text-primary" />
              ) : account ? (
                <>
                  <AccountAvatar account={account} size="lg" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      {account.name || t('defaultUser')}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {account.email}
                    </p>
                  </div>
                </>
              ) : (
                <p className="text-xs text-destructive">
                  {t('sessionUnavailable')}
                </p>
              )}
            </IdentitySummary>

            <div className="flex items-center justify-center text-primary sm:px-1">
              <ArrowRight
                className="size-4 rotate-90 sm:rotate-0 rtl:rotate-180"
                aria-hidden="true"
              />
            </div>

            <IdentitySummary label={t('connectingTo')}>
              <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm shadow-primary/20">
                <Plug className="size-5" aria-hidden="true" />
              </div>
              <div className="min-w-0">
                <p
                  className="truncate text-sm font-semibold"
                  title={clientName}
                >
                  {clientName}
                </p>
                <p className="text-xs break-words text-muted-foreground">
                  {t('assistantVia')}
                </p>
                {clientId ? (
                  <p
                    className="truncate font-mono text-[11px] text-muted-foreground"
                    dir="ltr"
                    title={clientId}
                    translate="no"
                  >
                    {clientId}
                  </p>
                ) : null}
                {redirectDestination ? (
                  // The address that receives the authorization code. The
                  // full URI stays one hover away via `title`.
                  <p
                    className="truncate text-[11px] text-muted-foreground"
                    title={redirectDestination.href}
                  >
                    {t('redirectsTo')}{' '}
                    <span className="font-mono" dir="ltr" translate="no">
                      {redirectDestination.display}
                    </span>
                  </p>
                ) : null}
                <p className="mt-0.5 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
                  {t('unverifiedClient')}
                </p>
                {clientWebsite || privacyPolicy ? (
                  <div className="mt-0.5 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-[11px]">
                    {clientWebsite ? (
                      <a
                        className="truncate text-primary underline-offset-2 hover:underline"
                        href={clientWebsite.href}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {t('clientWebsite')} ({clientWebsite.host})
                      </a>
                    ) : null}
                    {privacyPolicy ? (
                      <a
                        className="text-primary underline-offset-2 hover:underline"
                        href={privacyPolicy.href}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {t('privacyPolicy')}
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </IdentitySummary>
          </div>
        </section>

        <section className="grid gap-2" aria-labelledby="shared-data-title">
          <div className="flex items-center gap-2 md:col-span-2">
            <Database className="size-4 text-primary" aria-hidden="true" />
            <h2 id="shared-data-title" className="text-sm font-semibold">
              {t('sharedData')}
            </h2>
          </div>
          <div className="grid gap-2 md:col-span-2 md:grid-cols-3">
            <Permission
              icon={<Eye className="size-4" />}
              title={t('identityTitle')}
              description={t('identityDescription')}
            />
            {grants.map((grant) => (
              <Permission
                key={grant.scope}
                icon={<grant.icon className="size-4" />}
                title={t(grant.titleKey)}
                description={t(grant.descriptionKey)}
              />
            ))}
          </div>
        </section>

        <div className="grid gap-2 md:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <section
            className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-2.5"
            aria-labelledby="risk-title"
          >
            <div className="flex gap-2">
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
                aria-hidden="true"
              />
              <div>
                <h2 id="risk-title" className="text-sm font-semibold">
                  {t('privacyTitle')}
                </h2>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {t('privacyDescription', { client: clientName })}
                </p>
              </div>
            </div>
          </section>

          <div className="flex items-start gap-2 rounded-xl bg-muted/35 px-2.5 py-2">
            <ShieldCheck
              className="mt-0.5 size-4 shrink-0 text-primary"
              aria-hidden="true"
            />
            <p className="text-xs leading-5 text-muted-foreground">
              {t('authorityNote')}
            </p>
          </div>
        </div>

        {redirectDestination?.isLoopback && (
          <section
            role="note"
            className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-2.5"
            data-testid="oauth-loopback-warning"
          >
            <div className="flex gap-2">
              <TriangleAlert
                className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
                aria-hidden="true"
              />
              <p className="text-xs leading-5 text-muted-foreground">
                {t('loopbackWarning', {
                  destination: redirectDestination.display,
                })}
              </p>
            </div>
          </section>
        )}

        {unknownScopes.length > 0 && (
          <p className="text-sm text-destructive" role="alert">
            {t('unknownScopes', { scopes: unknownScopes.join(', ') })}
          </p>
        )}

        {(clientError || error) && (
          <p className="text-sm text-destructive" role="alert">
            {clientError ?? error}
          </p>
        )}

        <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row-reverse">
          <Button
            className="sm:min-w-48"
            disabled={!canApprove}
            onClick={() => void decide(true)}
          >
            {pending === 'accept' ? (
              <Loader2 className="me-2 h-4 w-4 animate-spin" />
            ) : (
              <LockKeyhole className="me-2 h-4 w-4" aria-hidden="true" />
            )}
            {t('allow')}
          </Button>
          <Button
            variant="outline"
            className="sm:min-w-28"
            disabled={pending !== null}
            onClick={() => void decide(false)}
          >
            {pending === 'deny' && (
              <Loader2 className="me-2 h-4 w-4 animate-spin" />
            )}
            {t('cancel')}
          </Button>
        </div>
      </div>
    </OAuthShell>
  )
}

function Permission({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode
  title: string
  description: string
}) {
  return (
    <div className="flex min-w-0 gap-2.5 rounded-lg border bg-background/70 p-2.5">
      <div className="mt-0.5 text-primary" aria-hidden="true">
        {icon}
      </div>
      <div className="min-w-0">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
    </div>
  )
}

function IdentitySummary({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="min-w-0 overflow-hidden">
      <p className="mb-1.5 text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </p>
      <div className="flex min-h-8 min-w-0 items-center gap-2.5">
        {children}
      </div>
    </div>
  )
}
