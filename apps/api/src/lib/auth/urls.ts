import { env } from '../env'

export function getApiBaseUrl(): string {
  if (env.BETTER_AUTH_URL) return env.BETTER_AUTH_URL
  // In local dev the API runs on 3001 and the web on 3000. Use the configured
  // port to derive a sensible base URL when no explicit override is set.
  return `http://localhost:${env.PORT}`
}

export function getWebBaseUrl(): string {
  const firstWebOrigin = env.WEB_ORIGINS.split(',')
    .map((o) => o.trim())
    .find(Boolean)
  return firstWebOrigin ?? 'http://localhost:3000'
}

/**
 * Audiences an access token may legitimately carry.
 *
 * The API is its own resource server, so tokens minted for it use the API base
 * URL. The MCP audience is preserved whenever MCP_PUBLIC_URL is configured:
 * tokens issued to assistant clients before the provider was ungated carry
 * `${MCP_PUBLIC_URL}/mcp` and must keep verifying. Both the provider and the
 * request-side resolver read this list, so they cannot drift apart.
 *
 * This list only says which audiences can be _authenticated_. It does not grant
 * an MCP-audience token access to the direct API surface: `apiProcedure` and
 * `scopedGroupReadProcedure` additionally require the API base URL in the
 * token's own `aud` claim (see `OAuthResolvedAuth.audiences`).
 */
export function oauthAudiences(): string[] {
  const audiences = [getApiBaseUrl()]
  if (env.MCP_PUBLIC_URL) audiences.push(`${env.MCP_PUBLIC_URL}/mcp`)
  return audiences
}
