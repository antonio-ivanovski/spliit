/**
 * OAuth scopes for programmatic clients.
 *
 * Two families live here, and the split is deliberate.
 *
 * `spliit:expenses:write` predates this module: it was published for the MCP
 * assistant, where creating an expense means calling `assistant.prepareExpense`
 * for a preview and then `assistant.createExpense` with the confirmation token
 * that preview returned. The consent screen promised exactly that. Reusing it
 * for direct writes would hand every live grant a power its holder never agreed
 * to, so it stays bound to `assistant.*` and `apiProcedure` refuses it.
 *
 * Direct access to the API therefore uses its own verbs. `manage` and `delete`
 * are new, so no existing token carries them and no existing consent silently
 * grows.
 */

/** Scopes required by the OpenID Connect authorization code flow. */
export const OIDC_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
] as const

/**
 * Published before the read/write split, bound to the assistant surface. Never
 * accepted by `apiProcedure` or `scopedGroupReadProcedure`.
 */
export const ASSISTANT_WRITE_SCOPE = 'spliit:expenses:write'

export const SPLIIT_SCOPES = {
  /**
   * Group reads. Also covers `assistant.listGroups` and
   * `assistant.getGroupSummary`, which is the one place an existing grant
   * widens: it already exposed group data, and now reaches the equivalent
   * direct reads. No new category of data becomes readable.
   */
  groupsRead: 'spliit:groups:read',
  /** Create and edit groups, add participants. */
  groupsManage: 'spliit:groups:manage',
  /** Delete or archive a group, remove participants. */
  groupsDelete: 'spliit:groups:delete',
  /** Read expenses and recurring series. */
  expensesRead: 'spliit:expenses:read',
  /** Create and edit expenses directly, without the assistant preview. */
  expensesManage: 'spliit:expenses:manage',
  /**
   * Delete an expense. Also required for edits that drop data, such as
   * shortening a recurring series with `THIS_AND_FUTURE`.
   */
  expensesDelete: 'spliit:expenses:delete',
} as const

export type SpliitScope = (typeof SPLIIT_SCOPES)[keyof typeof SPLIIT_SCOPES]

/** Scopes that allow irreversible changes. Always opt-in. */
export const DESTRUCTIVE_SCOPES: readonly SpliitScope[] = [
  SPLIIT_SCOPES.groupsDelete,
  SPLIIT_SCOPES.expensesDelete,
]

/** Every scope the provider recognises, including OIDC and the legacy one. */
export const ALL_SCOPES: readonly string[] = [
  ...OIDC_SCOPES,
  ...Object.values(SPLIIT_SCOPES),
  ASSISTANT_WRITE_SCOPE,
]

/**
 * Scopes the API's RFC 9728 protected-resource document advertises.
 *
 * Deliberately much narrower than `ALL_SCOPES`: agent clients that get no
 * `scope` hint in a challenge fall back to requesting everything in
 * `scopes_supported`, so advertising manage/delete there would push every
 * default authorization toward destructive permissions. The document describes
 * the API's basic resource scope set only — the read scopes. OIDC and refresh
 * scopes belong to the authorization-server metadata, the assistant write scope
 * to the MCP resource document, and manage/delete scopes are surfaced
 * per-operation through `insufficient_scope` step-up challenges and OpenAPI.
 */
export const API_RESOURCE_DISCOVERY_SCOPES: readonly SpliitScope[] = [
  SPLIIT_SCOPES.groupsRead,
  SPLIIT_SCOPES.expensesRead,
]

/**
 * Granted to a client that registers without requesting specific scopes.
 * Read-only: an agent or generic OAuth client that omits `scope` must not gain
 * write authority silently. Manage and delete scopes are always requested by
 * name, shown on the consent screen, and reachable later through the
 * `insufficient_scope` step-up flow. The assistant scope is excluded: a client
 * that wants the preview flow asks for it by name.
 */
export const DEFAULT_CLIENT_SCOPES: readonly string[] = [
  ...OIDC_SCOPES,
  SPLIIT_SCOPES.groupsRead,
  SPLIIT_SCOPES.expensesRead,
]

/**
 * Scopes each grant implies, within one resource only.
 *
 * Managing or deleting implies reading the same resource, since both need to
 * see a row before changing it. Nothing implies a write, nothing crosses from
 * groups to expenses, and the legacy assistant scope implies nothing at all.
 */
const IMPLIED_SCOPES: Readonly<Record<string, readonly SpliitScope[]>> = {
  [SPLIIT_SCOPES.expensesManage]: [SPLIIT_SCOPES.expensesRead],
  [SPLIIT_SCOPES.expensesDelete]: [SPLIIT_SCOPES.expensesRead],
  [SPLIIT_SCOPES.groupsManage]: [SPLIIT_SCOPES.groupsRead],
  [SPLIIT_SCOPES.groupsDelete]: [SPLIIT_SCOPES.groupsRead],
}

/** Expand a granted scope list with the scopes those grants imply. */
export function expandScopes(granted: readonly string[]): Set<string> {
  const expanded = new Set(granted)
  for (const scope of granted) {
    for (const implied of IMPLIED_SCOPES[scope] ?? []) expanded.add(implied)
  }
  return expanded
}

/** Whether a granted scope list satisfies `required`. */
export function hasScope(
  granted: readonly string[],
  required: SpliitScope,
): boolean {
  return expandScopes(granted).has(required)
}
