# Self-hosting

The supported Docker deployment uses one public origin. The nginx-based web
container serves the SPA and forwards the existing API paths to the private API
container:

```text
internet -> HTTPS reverse proxy -> web:3000 -> api:3001
                                   |
                                   +-> static SPA
```

PostgreSQL, migrations, the API, and the worker communicate only on the Compose
network. The default stack does not publish ports `3001`, `3003`, or `5432`.

## Quick start

Copy `container.env.example` to `container.env` and set:

- `APP_URL` to the final HTTPS origin, such as `https://spliit.example.com`
- a long random `POSTGRES_PASSWORD`
- `BETTER_AUTH_SECRET` from `openssl rand -base64 32`
- `SMTP_HOST`, `SMTP_PORT`, and `EMAIL_FROM`
- both `SMTP_USER` and `SMTP_PASS` for authenticated SMTP, or neither for a
  trusted anonymous relay
- `EMAIL_UNSUBSCRIBE_SECRET` from `openssl rand -hex 32`

Then start the project:

```bash
docker compose --env-file container.env up -d
```

The web port binds to `127.0.0.1:3000`. Point Caddy, nginx, Traefik, HAProxy, or
another TLS-terminating reverse proxy at that address. The proxy should preserve
the public `Host` header and set `X-Forwarded-For`, `X-Real-IP`, and
`X-Forwarded-Proto`. Spliit's web gateway preserves those values for the API.

Useful checks:

```bash
curl https://spliit.example.com/health/liveness
curl https://spliit.example.com/health/readiness
docker compose --env-file container.env ps
docker compose --env-file container.env logs api worker
```

The `migrate` container exiting successfully is expected.

The bundled database image is PostgreSQL 18 and stores its data below
`/var/lib/postgresql/<major>/docker`; the Compose volume is therefore mounted
at `/var/lib/postgresql`. If upgrading an existing deployment that used the
legacy `/var/lib/postgresql/data` mount, do not start the new image until the
database has been migrated. Take a backup first, then use PostgreSQL's
`pg_upgrade` procedure (or restore a `pg_dump` into a fresh PostgreSQL 18
volume). A volume containing the old data at the legacy path cannot be reused
by simply changing the image tag.

## Ports and split-origin deployments

Change `WEB_PORT` to move the local web port. Keep `BIND_ADDRESS=127.0.0.1`
unless the reverse proxy runs on another host or cannot reach host loopback.

The optional API override publishes port 3001:

```bash
docker compose \
  --env-file container.env \
  -f compose.yaml \
  -f compose.api-port.yaml \
  up -d
```

`API_BIND_ADDRESS` and `API_PORT` control that mapping. Direct API exposure is
not needed for the normal same-origin setup, including most MCP deployments,
because `/auth`, `/.well-known`, and `/trpc` are already available through the
web origin.

For a separately hosted SPA, build it with `VITE_API_URL` set to the public API
origin. Set `WEB_ORIGINS` to the SPA origin and `BETTER_AUTH_URL` to the API
origin; these override the same-origin `APP_URL` defaults. This is how the
project can continue serving the web app from Cloudflare Pages while exposing
the API from Dokploy or the API-port Compose override. No runtime `config.js` is
used.

## Optional features

The example environment file contains every supported toggle. Optional values
may remain empty.

- OAuth buttons are enabled automatically when both credentials for Google or
  GitHub are configured.
- Account registration defaults to `SIGNUP_MODE=open` (anyone who can reach the
  instance can create an account). Set `SIGNUP_MODE=invite_only` for a private
  instance. In that mode the first account on a fresh database can still
  register; after that, a visitor can create an account only with a pending
  group or friend email invitation, or by opening a live share-link invite.
  Existing users can always sign in. Inviting someone to a group or friend
  ledger is how they get an account.
- Anonymous account creation requires `ENABLE_ANONYMOUS_AUTH=true`,
  `SIGNUP_MODE=open`, a stable `BETTER_AUTH_SECRET`, and `TRUST_PROXY=true`
  behind a correctly configured trusted proxy. The proxy must sanitize client
  IP headers so per-client signup and recovery limits are meaningful. Turning
  anonymous creation off later prevents new anonymous accounts but keeps
  recovery available for existing ones. Recovery links are permanent bearer
  credentials, so back up the secret; changing it makes interrupted,
  not-yet-confirmed setup links unreadable. The background worker permanently
  deletes anonymous accounts that do not start recovery-link setup within seven
  days, or leave setup unacknowledged for seven days. Acknowledged anonymous
  accounts are never removed by this sweep.
- Expense documents require
  `PUBLIC_ENABLE_EXPENSE_DOCUMENTS=true` and the required `S3_UPLOAD_*` values.
  Configure the bucket with a lifecycle rule that expires objects under
  `tmp/imports/` after 24 hours. Import retries intentionally retain these
  temporary objects until the database transaction commits; the lifecycle rule
  removes abandoned browser sessions and interrupted uploads.
- AI features require their corresponding `PUBLIC_ENABLE_*` flag and
  `AI_API_KEY`. `AI_PROVIDER`, model names, and `AI_BASE_URL` are optional.
- Web Push requires the public key, private key, and subject together.
- MCP requires `ENABLE_MCP=true`, `MCP_PUBLIC_URL`, and a dedicated
  `ASSISTANT_CONFIRMATION_SECRET` of at least 32 bytes. Deploy the MCP service
  separately using [the MCP guide](./mcp-publishing.md).

The background worker is part of the base stack because it handles recurring
expenses as well as notifications.

## Updates and rollback

`latest` follows the most recent stable version release. Every release is
also published with its immutable version tag. To upgrade, set `SPLIIT_TAG`
to the new version before pulling:

```bash
export SPLIIT_TAG=v2.0.0
docker compose --env-file container.env pull
docker compose --env-file container.env up -d
```

Check the GitHub Release for that version first: it lists what changed
and any breaking changes with migration steps.

The one-shot migration service applies pending database migrations before the
new API starts. Back up the database before upgrading. Roll back application
images by restoring the previous `SPLIIT_TAG`; if a release includes an
incompatible database migration, restore the matching database backup as well.

## Backups

The `postgres_data` volume contains the primary application data. Use regular
off-host `pg_dump` backups or an equivalent PostgreSQL-aware backup system.
Periodically test a full restore into a separate PostgreSQL instance. Object
storage must be backed up separately when expense documents are enabled.

## Hardening

- Terminate HTTPS before the web container and enable HSTS at the outer proxy.
- Do not publish PostgreSQL or the worker health port.
- Leave the API private unless a split-origin deployment requires it.
- Keep `TRUST_PROXY=false` until the origin is restricted to trusted proxy
  traffic. Enable it only after that restriction is active; otherwise direct
  callers can spoof forwarded client-IP headers. For Cloudflare, apply the
  Cloudflare-source allowlist before deploying with `TRUST_PROXY=true`.
- Protect `container.env`, database backups, SMTP credentials, and auth secrets.
- Configure SPF, DKIM, and DMARC for `EMAIL_FROM`.
- Pin `SPLIIT_TAG` when you prefer scheduled upgrades over tracking `latest`.
