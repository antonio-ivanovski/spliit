import { describe, expect, it } from 'vitest'

import {
  ALL_SCOPES,
  API_RESOURCE_DISCOVERY_SCOPES,
  ASSISTANT_WRITE_SCOPE,
  DEFAULT_CLIENT_SCOPES,
  DESTRUCTIVE_SCOPES,
  OIDC_SCOPES,
  SPLIIT_SCOPES,
  expandScopes,
  hasScope,
} from './scopes'

describe('scope catalogue', () => {
  it('never grants a destructive scope by default', () => {
    for (const scope of DESTRUCTIVE_SCOPES) {
      expect(DEFAULT_CLIENT_SCOPES).not.toContain(scope)
    }
  })

  it('keeps the default grant read-only', () => {
    // A client that omits `scope` must not gain write authority silently.
    // Manage scopes are requested by name and reached later through the
    // insufficient_scope step-up flow.
    expect(DEFAULT_CLIENT_SCOPES).not.toContain(SPLIIT_SCOPES.groupsManage)
    expect(DEFAULT_CLIENT_SCOPES).not.toContain(SPLIIT_SCOPES.expensesManage)
    expect(DEFAULT_CLIENT_SCOPES).toEqual([
      ...OIDC_SCOPES,
      SPLIIT_SCOPES.groupsRead,
      SPLIIT_SCOPES.expensesRead,
    ])
  })

  it('advertises only the read scopes in resource discovery', () => {
    // Agents fall back to requesting everything in `scopes_supported`, so
    // the protected-resource document must stay minimal.
    expect(API_RESOURCE_DISCOVERY_SCOPES).toEqual([
      SPLIIT_SCOPES.groupsRead,
      SPLIIT_SCOPES.expensesRead,
    ])
  })

  it('still offers every destructive scope for explicit requests', () => {
    for (const scope of DESTRUCTIVE_SCOPES) {
      expect(ALL_SCOPES).toContain(scope)
    }
  })

  it('keeps the read scope the MCP assistant already requests', () => {
    expect(DEFAULT_CLIENT_SCOPES).toContain(SPLIIT_SCOPES.groupsRead)
  })

  it('never hands the legacy assistant scope to a fresh client', () => {
    // `spliit:expenses:write` means "create after a preview and a confirmation
    // token". A client that wants that flow asks for it by name.
    expect(DEFAULT_CLIENT_SCOPES).not.toContain(ASSISTANT_WRITE_SCOPE)
    expect(ALL_SCOPES).toContain(ASSISTANT_WRITE_SCOPE)
  })
})

describe('expandScopes', () => {
  it('treats manage as implying read', () => {
    const expanded = expandScopes([SPLIIT_SCOPES.expensesManage])

    expect(expanded.has(SPLIIT_SCOPES.expensesRead)).toBe(true)
  })

  it('grants nothing at all from the legacy assistant scope', () => {
    // The whole point of keeping it separate: a live assistant grant must not
    // reach direct reads or writes.
    const expanded = expandScopes([ASSISTANT_WRITE_SCOPE])

    expect(expanded.has(SPLIIT_SCOPES.expensesRead)).toBe(false)
    expect(expanded.has(SPLIIT_SCOPES.expensesManage)).toBe(false)
  })

  it('treats delete as implying read', () => {
    const expanded = expandScopes([SPLIIT_SCOPES.groupsDelete])

    expect(expanded.has(SPLIIT_SCOPES.groupsRead)).toBe(true)
  })

  it('does not let a manage scope imply anything on the other resource', () => {
    const expanded = expandScopes([SPLIIT_SCOPES.expensesManage])

    expect(expanded.has(SPLIIT_SCOPES.groupsRead)).toBe(false)
    expect(expanded.has(SPLIIT_SCOPES.groupsManage)).toBe(false)
  })

  it('never lets read imply manage', () => {
    const expanded = expandScopes([
      SPLIIT_SCOPES.expensesRead,
      SPLIIT_SCOPES.groupsRead,
    ])

    expect(expanded.has(SPLIIT_SCOPES.expensesManage)).toBe(false)
    expect(expanded.has(SPLIIT_SCOPES.groupsManage)).toBe(false)
  })

  it('never lets manage imply delete', () => {
    const expanded = expandScopes([
      SPLIIT_SCOPES.expensesManage,
      SPLIIT_SCOPES.groupsManage,
    ])

    expect(expanded.has(SPLIIT_SCOPES.expensesDelete)).toBe(false)
    expect(expanded.has(SPLIIT_SCOPES.groupsDelete)).toBe(false)
  })
})

describe('hasScope', () => {
  it('gives a live assistant grant no direct access whatsoever', () => {
    // This is the grant every existing MCP client holds today. It must not
    // reach a single direct-access procedure.
    const granted = ['spliit:groups:read', ASSISTANT_WRITE_SCOPE]

    expect(hasScope(granted, SPLIIT_SCOPES.expensesRead)).toBe(false)
    expect(hasScope(granted, SPLIIT_SCOPES.expensesManage)).toBe(false)
    expect(hasScope(granted, SPLIIT_SCOPES.expensesDelete)).toBe(false)
  })

  it('rejects a scope that was never granted', () => {
    const granted = ['spliit:groups:read', SPLIIT_SCOPES.expensesManage]

    expect(hasScope(granted, SPLIIT_SCOPES.expensesDelete)).toBe(false)
    expect(hasScope(granted, SPLIIT_SCOPES.groupsManage)).toBe(false)
  })

  it('rejects everything for an empty grant', () => {
    for (const scope of Object.values(SPLIIT_SCOPES)) {
      expect(hasScope([], scope)).toBe(false)
    }
  })
})
