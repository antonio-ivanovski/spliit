import { getApiBaseUrl } from '@/lib/api-url'

const apiBaseUrl = getApiBaseUrl()

export function resolveOAuthQuery(
  explicitQuery?: string,
  locationSearch = typeof window !== 'undefined' ? window.location.search : '',
) {
  if (explicitQuery) return explicitQuery
  const rawQuery = locationSearch.startsWith('?')
    ? locationSearch.slice(1)
    : locationSearch
  if (!rawQuery) return undefined
  // Older links may wrap the signed query, while Better Auth's native
  // login/consent redirects put the signed parameters directly in the URL.
  return new URLSearchParams(rawQuery).get('oauth_query') ?? rawQuery
}

/**
 * Read the client, scopes and redirect target out of the signed request that
 * will actually be submitted.
 *
 * The page used to render `client_id` and `scope` from its own search params
 * while posting `oauth_query` separately, so a wrapped link could name one
 * client and authorize another. Everything shown now comes from the same string
 * the server decodes — including `redirect_uri`, the address that will receive
 * the authorization code.
 */
export function readOAuthRequest(oauthQuery: string | undefined) {
  const query = new URLSearchParams(oauthQuery ?? '')
  const scope = query.get('scope') ?? ''
  return {
    clientId: query.get('client_id') ?? undefined,
    redirectUri: query.get('redirect_uri') ?? undefined,
    scopes: scope.split(' ').filter(Boolean),
  }
}

export function buildOAuthAuthorizationUrl(oauthQuery: string) {
  const query = new URLSearchParams(oauthQuery)
  // These fields authenticate Better Auth's hand-off to our login/consent
  // pages. A fresh request to the authorization endpoint must contain only
  // the original OAuth parameters; Better Auth signs the next hand-off.
  for (const field of ['sig', 'exp', 'ba_iat', 'ba_pl', 'ba_param']) {
    query.delete(field)
  }
  return `${apiBaseUrl}/auth/oauth2/authorize?${query.toString()}`
}

export function resumeOAuthAuthorization(oauthQuery: string) {
  window.location.assign(buildOAuthAuthorizationUrl(oauthQuery))
}

export type OAuthPublicClient = {
  client_id: string
  client_name?: string
  client_uri?: string
  logo_uri?: string
  policy_uri?: string
}

export async function getOAuthPublicClient(clientId: string) {
  const url = new URL(`${apiBaseUrl}/auth/oauth2/public-client`)
  url.searchParams.set('client_id', clientId)
  const response = await fetch(url, { credentials: 'include' })
  const body = (await response.json()) as OAuthPublicClient & {
    message?: string
  }
  if (!response.ok) {
    throw new Error(body.message ?? 'Could not identify the connecting app')
  }
  return body
}

export async function submitConsent(opts: {
  accept: boolean
  oauthQuery: string
  scope?: string
}) {
  const response = await fetch(`${apiBaseUrl}/auth/oauth2/consent`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accept: opts.accept,
      scope: opts.scope,
      oauth_query: opts.oauthQuery,
    }),
  })
  const body = (await response.json()) as { url?: string; message?: string }
  if (!response.ok || !body.url) {
    throw new Error(body.message ?? 'Could not save authorization choice')
  }
  window.location.assign(body.url)
}
