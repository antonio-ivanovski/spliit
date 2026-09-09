# Contributing to Spliit Cloud

Spliit Cloud is a community fork of [Spliit](https://github.com/spliit-app/spliit). Contributions are welcome: bug reports, fixes, tests, docs, translations, and features.

For project rules, see [AGENTS.md](./AGENTS.md). For behavior, see [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## Where to start

- [`good first issue`](https://github.com/antonio-ivanovski/spliit-cloud/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) — approachable entry points
- [`help wanted`](https://github.com/antonio-ivanovski/spliit-cloud/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) — scoped but unassigned
- For larger changes, open an issue first to align on direction

## Development setup

Bun monorepo. All commands through Bun.

Local dev runs in three explicit steps:

```bash
bun install
cp .env.example .env
bun dev:up                       # starts postgres, maxio, maildev (compose.dev.yaml)
bun prisma-migrate
bun dev                          # web :3000, api :3001
```

Service state lives under `storage/` at the repository root. Stop local
service containers with `bun dev:down` when you are done; remove `storage/`
for a clean reset.

Other useful commands:

```bash
bun run check            # Oxfmt, Oxlint, and TypeScript
bun run format:affected  # Format only affected Turbo tasks
bun run lint:fix         # Apply Oxlint's behavior-preserving fixes
bun run test             # Vitest unit tests
bun test:integration     # Real-DB integration tests
```

Web integration tests expect an API using the integration profile. Start it in
another terminal before running the suite:

```bash
bun --filter @spliit/api start:integration # API on :3101
bun test:integration
```

## Pull request workflow

1. Branch off `main` (`fix/...`, `feat/...`, `docs/...`)
2. One logical change per PR. Add or update tests.
3. Run `bun run check` and `bun run test` before pushing.
4. Schema changes: commit schema, migration, and generated Prisma client together.
   Create SQL migrations with `bun --filter @spliit/db prisma-create-migration`
   so Prisma stamps the current UTC `YYYYMMDDHHmmss`. Do not invent, backdate,
   or reuse a timestamp prefix, and do not treat the `dd` (day) digits as a
   same-day sequence number — that inserts a migration _before_ later-named
   folders already on `main`/prod.
   `prisma migrate deploy` still applies a pending earlier-named migration
   after later ones are already recorded. Independent `ADD COLUMN` SQL usually
   succeeds, but anything that assumes chronological schema order can fail or
   leave a fresh database with a different apply order than production.
   Before committing, confirm the new folder name sorts after every existing
   directory in `packages/db/prisma/migrations/`. Two folders already share
   `20260813120000`; do not add another collision.
5. Reference the issue with `Closes #123`.

## Releases

Releases are versioned (`v2.0.0`, first stable). To cut one:

1. Write `releases/vX.Y.Z.md` with screenshots in `releases/assets/vX.Y.Z/`
   (see `releases/README.md` for the template).
2. Commit it to `main`, then `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The Release workflow publishes `:vX.Y.Z` + `:latest`, creates the
   GitHub Release from your file, and deploys prod immediately.

If your change breaks compatibility or needs manual migration steps, say
so in the PR (`Migration:` field) so it lands in the release notes.

### AI-assisted contributions

AI agent contributions are welcome, but the PR must make the agent's context
and reasoning reviewable. If AI was used, include the initial prompt and
every follow-up prompt that materially shaped the implementation, along with
any relevant notes about what was accepted or changed.

The PR author remains responsible for the implementation, tests, security,
and review of all generated code. Do not include secrets, private data, or
unredacted third-party content in prompt transcripts.

Commit messages: short imperative subject, optional body for the _why_.

## Key rules

See [AGENTS.md](./AGENTS.md) for agent and contributor invariants (Bun, money units, translations, integration-test server rules).

## Translations

`apps/web/src/messages/en-US.json` is the source of truth. Use `bun i18n` for all changes to non-English locales. Weblate is not set up yet.

## Review

Maintained in spare time. Reviews are best-effort. A ping on stalled PRs is welcome.
