import { API_RESOURCE_DISCOVERY_SCOPES } from './scopes'
import { getApiBaseUrl } from './urls'

export const OAUTH_PROTECTED_RESOURCE_PATH =
  '/.well-known/oauth-protected-resource'

/** RFC 9728 metadata that lets an unknown OAuth client discover Spliit. */
export function getOAuthProtectedResourceMetadata() {
  const resource = getApiBaseUrl()
  return {
    resource,
    authorization_servers: [new URL('/auth', resource).toString()],
    // The basic resource scope set only. Agent clients fall back to
    // requesting everything listed here when a challenge carries no `scope`,
    // so manage/delete/assistant scopes are deliberately absent — see
    // `API_RESOURCE_DISCOVERY_SCOPES`.
    scopes_supported: [...API_RESOURCE_DISCOVERY_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Spliit API',
    resource_documentation: new URL('/docs', resource).toString(),
  }
}

/**
 * RFC 6750 `WWW-Authenticate` challenge for OAuth-enabled API procedures.
 *
 * The attributes tell an agent which recovery applies: no `error` means no
 * usable credentials were presented (start authorization), `invalid_token`
 * means the bearer failed verification (refresh or re-authorize), and
 * `insufficient_scope` means authentication succeeded but the operation needs
 * the listed scope (step-up authorization).
 */
export function getOAuthProtectedResourceChallenge(opts?: {
  error?: 'invalid_token' | 'insufficient_scope'
  /** Minimum scopes for the requested operations; deduplicated, order kept. */
  scope?: readonly string[]
}): string {
  const metadataUrl = new URL(OAUTH_PROTECTED_RESOURCE_PATH, getApiBaseUrl())
  const attributes: string[] = []
  if (opts?.error) attributes.push(`error="${opts.error}"`)
  const scopes = [...new Set(opts?.scope ?? [])]
  if (scopes.length > 0) attributes.push(`scope="${scopes.join(' ')}"`)
  attributes.push(`resource_metadata="${metadataUrl.toString()}"`)
  return `Bearer ${attributes.join(', ')}`
}
