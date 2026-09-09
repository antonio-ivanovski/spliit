# Programmatic API access

Scripts and agents reach the API with an OAuth 2.1 access token instead of a
browser session. The authorization server runs on the API itself, so nothing
extra needs to be deployed: no MCP server, no feature flag.

The interactive reference is at [`/docs`](https://api.spliit.cloud/docs) and the
machine-readable document at
[`/openapi.json`](https://api.spliit.cloud/openapi.json). Both list the scope
each operation accepts.

## Scopes

Access is granted per resource and per verb.

| Scope                    | Covers                                         |
| ------------------------ | ---------------------------------------------- |
| `spliit:groups:read`     | groups, balances, statistics, activity         |
| `spliit:groups:manage`   | create and edit groups, add participants       |
| `spliit:groups:delete`   | delete or archive a group, remove participants |
| `spliit:expenses:read`   | expenses and recurring series                  |
| `spliit:expenses:manage` | create and edit expenses, stop a recurrence    |
| `spliit:expenses:delete` | delete an expense, and edits that drop data    |

A client that registers without naming scopes receives the two read scopes
only. **Write and delete scopes are never granted by default** and must be
requested explicitly, so an agent cannot change or destroy anything unless you
decided it should be able to. When a read-only token attempts a write, the API
answers with an `insufficient_scope` challenge naming the exact scope to
request (see [Calling the API](#calling-the-api)).

Managing or deleting implies reading the same resource, so a token holding
`spliit:expenses:manage` can read expenses without also holding
`spliit:expenses:read`. Nothing implies a write, and nothing crosses between
groups and expenses.

`spliit:expenses:delete` covers more than the delete procedure. Shortening a
recurring series with a `THIS_AND_FUTURE` edit drops the occurrences that no
longer fit and their stored documents, so that edit needs the delete scope even
though it goes through `groups.expenses.update`.

Two group-removal operations can create settlement expenses: force-archiving a
group with open balances and removing a participant with `settleBalances=true`.
OAuth callers need both `spliit:groups:delete` and
`spliit:expenses:manage` for those combined operations.

There is one older scope, `spliit:expenses:write`. It predates direct access and
belongs to the assistant, where creating an expense means calling
`assistant.prepareExpense` for a preview and then `assistant.createExpense` with
the token that preview returns. It grants no direct access at all, and is never
part of a default grant.

Scopes bound what a token may attempt, not who the caller is. Group role rules
still apply on top: a token acting for a non-admin member can only delete
expenses that member created.

## What a token cannot reach

Scopes cover groups and expenses: listing and reading groups, balances,
statistics and activity, plus reading, creating, editing and deleting expenses
and recurring series.

Everything else stays session-only for now and answers `401 Session required`
to a token, whatever scopes it holds:

- budgets, subgroups, saved views
- expense comments, category memory, common currencies
- imports and exports
- invitations, member roles, leaving a group
- account preferences and profile

This is a deliberate starting surface rather than an oversight. Say so if your
integration needs one of them, so the list can grow with a reason attached.

## Discovering OAuth

An agent only needs the API URL. Calling an OAuth-enabled procedure without a
token returns a `WWW-Authenticate` challenge whose `resource_metadata` value
points to the standard RFC 9728 document:

```text
https://api.spliit.cloud/.well-known/oauth-protected-resource
```

That document identifies the API resource, its basic scope set — the two read
scopes only — and the OAuth authorization server. The agent can then follow
RFC 8414 discovery to learn the dynamic-registration, authorization and token
endpoints. No Spliit-specific skill or hard-coded OAuth route list is required.
Write and delete scopes are deliberately not advertised there: each challenge
and the OpenAPI document name the scope an operation actually needs, so an
agent that falls back to requesting everything in `scopes_supported` ends up
with a safe read-only grant.

## Registering a client

Dynamic client registration is open, so a client can enrol itself:

```bash
curl -X POST https://api.spliit.cloud/auth/oauth2/register \
  -H 'Content-Type: application/json' \
  -d '{
    "client_name": "My agent",
    "redirect_uris": ["http://127.0.0.1:52123/callback"],
    "token_endpoint_auth_method": "none",
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"]
  }'
```

The response returns the `client_id` to use below.

Add a `scope` field to request a manage or delete scope. This has to happen at
registration: the authorization endpoint refuses any scope the client did not
register for, with `The following scopes are invalid`. There is no endpoint to
widen an existing client, so a client that needs to start writing or deleting
has to be registered again and reauthorized.

An explicit `scope` value replaces the read-only defaults; it does not add to
them. Send the complete, space-separated set the client needs, including
`openid` and `offline_access` when it needs identity claims and refresh
tokens. The example below adds expense writes and deletion.

```bash
  -d '{
    "client_name": "My agent",
    ...
    "scope": "openid offline_access spliit:expenses:read spliit:expenses:manage spliit:expenses:delete"
  }'
```

## Getting a token

The authorization code flow with PKCE, which needs a browser once:

1. Send the account holder to `/auth/oauth2/authorize` with `response_type=code`,
   your `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge` and
   `code_challenge_method=S256`.
2. They sign in and approve the scopes.
3. Exchange the returned `code` at `/auth/oauth2/token` as form data:

```bash
curl -X POST https://api.spliit.cloud/auth/oauth2/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=authorization_code' \
  --data-urlencode 'client_id=<client_id>' \
  --data-urlencode 'code=<authorization_code>' \
  --data-urlencode 'redirect_uri=http://127.0.0.1:52123/callback' \
  --data-urlencode 'code_verifier=<pkce_code_verifier>'
```

When `resource` is omitted, Spliit binds the authorization to
`https://api.spliit.cloud` by default and issues an API JWT. A client may pass
`resource=https://api.spliit.cloud` explicitly on the authorization request;
the token exchange and later refreshes inherit that resource.

Tokens issued for the MCP resource (`${MCP_PUBLIC_URL}/mcp`) keep verifying
while that variable is configured, but only for the assistant surface that
backs the MCP server. The direct API requires a token whose audience is the
API itself and answers anything else with `401` and `error="invalid_token"` —
a token minted for one resource is not a credential for the other (RFC 8707).
On the first refresh after upgrading from Better Auth 1.6, an existing token
family is bound to the valid resource requested by the client (or to the API
default when omitted); later refreshes can only retain or narrow that binding.
Existing MCP clients therefore keep working without reauthorizing.

Call the API with `Authorization: Bearer <access_token>`.

Access tokens last one hour. Refresh at the same form-encoded endpoint; refresh
tokens last 30 days and a fresh one is issued on every renewal, so a client
calling at least once a month keeps working indefinitely.

```bash
curl -X POST https://api.spliit.cloud/auth/oauth2/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=refresh_token' \
  --data-urlencode 'client_id=<client_id>' \
  --data-urlencode 'refresh_token=<refresh_token>'
```

Two things to know about refreshing. A refresh token can only be used once: if
your client refreshes but fails to persist the new token, replaying the old one
invalidates the whole family and the account holder has to authorize again.
And a refresh cannot widen a grant, so adding a scope means running the
authorization flow a second time.

## Calling the API

The API is tRPC, so paths are dotted procedure names under `/trpc` and responses
are wrapped in an envelope. Queries take input as a JSON query parameter,
mutations as a JSON body.

```bash
# Query
curl -G 'https://api.spliit.cloud/trpc/groups.list' \
  -H "Authorization: Bearer $TOKEN" \
  --data-urlencode 'input={"json":{}}'

# Mutation
curl -X POST 'https://api.spliit.cloud/trpc/groups.expenses.create' \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"json":{"groupId":"...","requestId":"<uuid>","expense":{ ... }}}'
```

Authentication and authorization failures return machine-actionable
`WWW-Authenticate` challenges (RFC 6750):

- No token on an OAuth-enabled procedure: `401` with
  `Bearer scope="<required scopes>", resource_metadata="…"` — register and
  authorize with the scope named in the challenge.
- Expired, malformed or wrong-audience token: `401` with
  `error="invalid_token"` — refresh, or reauthorize if refreshing fails.
- Token valid but missing the operation's scope: `403` with
  `error="insufficient_scope", scope="<missing scopes>"` and a body of
  `Missing required scope: <scope>` — register and authorize with the wider
  scope set (step-up). Batched calls advertise the union of the missing
  scopes.

Send a `User-Agent` identifying your client. Spliit Cloud sits behind
Cloudflare, which answers default HTTP-library agents with a challenge page
rather than reaching the API.

## Reviewing and revoking

Account settings list every app that has been authorized, with the scopes it
holds. Disconnecting invalidates pending authorization codes and revokes the
client’s refresh tokens, so it cannot exchange or renew credentials. An access
token already issued keeps working until it expires, which is at most an hour.
An authorization request that was already in progress is blocked as well; the
app must start again and receive a new explicit consent before it can reconnect.
