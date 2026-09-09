# Releases

Versioned releases. The public instance and `:latest` images follow these versions.

## How to cut a release

1. Write `releases/vX.Y.Z.md` (copy the template below) and add
   screenshots under `releases/assets/vX.Y.Z/`. Commit to `main`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`
3. The `Release` workflow builds the 5 images, publishes `:vX.Y.Z` and
   `:latest`, creates the GitHub Release from your file, and deploys
   Dokploy + Cloudflare Pages immediately.
4. Verify on the Releases page (text + screenshots render) and check
   prod `/health/readiness`.

Rollback: point `SPLIIT_TAG` at the previous version (or move `:latest`
back) and restore the DB backup if a migration was incompatible.

## Notes file template

Structure the file like Immich releases:

```markdown
Welcome to vX.Y.Z! One or two sentences on what this release is about.

## Highlights

- Headline one
- Headline two

### Headline one

A short paragraph per headline, with a screenshot where it helps.

![caption](./assets/vX.Y.Z/shot.webp)

### Headline two

...

## What's Changed

### 🚨 Breaking Changes

Omit this section when there are none. Each entry names what breaks,
who is affected, and the exact migration steps.

### 🚀 Features

- Short entry per user-facing change (`abc1234` by @user)

### 🐛 Bug fixes

- Short entry per fix (`abc1234` by @user)

**Full Changelog**: vA...vB
```

Rules:

- The file for tag `vX.Y.Z` must be `releases/vX.Y.Z.md`. The workflow
  fails without it.
- Screenshots: reference as `./assets/vX.Y.Z/<file>` (markdown image
  syntax). The workflow rewrites them to absolute tagged URLs, so they
  render on the Releases page and stay pinned to the tag.
- Do not write the Docker-images section yourself — the workflow
  appends `:vX.Y.Z` + `:latest` pointers for all 5 images.
