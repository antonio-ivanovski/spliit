import { readFileSync } from 'node:fs'

import {
  addString,
  auditMessages,
  diffMessages,
  findUsages,
  flattenKeys,
  formatNextHuman,
  formatPlanHuman,
  getAt,
  getKeysAcrossLocales,
  identicalKeysByLocale,
  initLocale,
  isSparseLocale,
  missingKeys,
  missingKeysByLocale,
  nextTranslationBatch,
  packMessages,
  planTranslations,
  pruneLocale,
  readMessagesFile,
  removeString,
  setString,
  setStrings,
  validateAllMessages,
} from './lib'
import type { AuditResult, PlanMode } from './lib'
import { locales, type Locale } from './lib'

type ParsedArgs = {
  positional: string[]
  flags: Set<string>
  kvFlags: Record<string, string>
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = []
  const flags = new Set<string>()
  const kvFlags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        kvFlags[key] = next
        i++
      } else {
        flags.add(key)
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags, kvFlags }
}

function die(msg: string, code = 1): never {
  console.error(`error: ${msg}`)
  process.exit(code)
}

function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value)
}

function parseLocaleList(raw: string | undefined): Locale[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((value) => {
      if (!isLocale(value)) die(`unknown locale: ${value}`, 2)
      return value
    })
}

function formatDiffHuman(result: Awaited<ReturnType<typeof diffMessages>>) {
  const lines: string[] = []
  const { ref, thisChange, translationWork, legacyMissing } = result

  lines.push(`This change (vs ${ref}):`)
  lines.push(`  + ${thisChange.added.length} added`)
  for (const k of thisChange.added) lines.push(`    ${k}`)
  lines.push(`  ~ ${thisChange.modified.length} modified`)
  for (const k of thisChange.modified) lines.push(`    ${k}`)
  lines.push(`  - ${thisChange.removed.length} removed`)
  for (const k of thisChange.removed) lines.push(`    ${k}`)

  const localeKeys = Object.keys(translationWork)
  if (localeKeys.length === 0) {
    lines.push('')
    lines.push('No non-default locales to translate.')
  } else {
    lines.push('')
    lines.push('Translation work introduced by this change:')
    const maxLen = Math.max(...localeKeys.map((k) => k.length))
    for (const locale of localeKeys) {
      const { missing, present, covered } = translationWork[locale]
      const padded = locale.padEnd(maxLen)
      const inherited =
        covered.length > 0 ? ` / ${covered.length} inherited` : ''
      lines.push(
        `  ${padded}  ${missing.length} missing / ${present.length} present${inherited}`,
      )
    }

    const single = localeKeys.length === 1
    if (single) {
      const locale = localeKeys[0]
      const { missing, present, covered } = translationWork[locale]
      if (covered.length > 0) {
        lines.push('')
        lines.push(`${String(locale)} (inherited from parent — no action):`)
        for (const k of covered) lines.push(`  = ${k}`)
      }
      if (missing.length > 0) {
        lines.push('')
        lines.push(`${String(locale)} (missing):`)
        for (const k of missing) lines.push(`  - ${k}`)
      }
      if (present.length > 0) {
        lines.push('')
        lines.push(
          `${String(locale)} (present — may need re-check if English changed):`,
        )
        for (const k of present) lines.push(`  + ${k}`)
      }
    }
  }

  const legacyKeys = Object.keys(legacyMissing)
  if (legacyKeys.length > 0) {
    lines.push('')
    lines.push('Legacy debt (pre-existing missing keys, unchanged by this PR):')
    const maxLen = Math.max(...legacyKeys.map((k) => k.length))
    for (const locale of legacyKeys) {
      const padded = locale.padEnd(maxLen)
      lines.push(`  ${padded}  ${legacyMissing[locale]}`)
    }
  }

  return lines.join('\n')
}

function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

function printCheckHuman(result: AuditResult) {
  const { totalKeys, locales, summary, errors, valid, changesOnly, ref } =
    result

  console.log(`i18n audit${changesOnly ? ` (changes vs ${ref})` : ''}`)
  console.log(`  en-US source: ${totalKeys} keys`)
  console.log(
    `  locales: ${summary.localesAudited} audited, ${summary.localesComplete} complete, ${summary.localesWithMissing} with gaps`,
  )
  console.log(`  total missing keys: ${summary.totalMissing}`)
  console.log(
    `  untranslated English (introduced keys): ${summary.totalUntranslatedEnglish}`,
  )
  if (errors.length > 0) {
    console.log(`  structural errors: ${errors.length}`)
  }

  const audited = Object.values(locales).sort((a, b) => {
    const aScore = a.missing + a.untranslatedEnglish
    const bScore = b.missing + b.untranslatedEnglish
    if (aScore !== bScore) return bScore - aScore
    return a.locale.localeCompare(b.locale)
  })

  const localeCol = Math.max(
    'locale'.length,
    ...audited.map((a) => a.locale.length),
  )

  if (audited.length > 0) {
    console.log('')
    console.log(
      `  ${'locale'.padEnd(localeCol)}  ${'present'.padStart(7)}  ${'missing'.padStart(7)}  ${'en-copy'.padStart(7)}  ${'coverage'.padStart(9)}`,
    )
    for (const a of audited) {
      console.log(
        `  ${a.locale.padEnd(localeCol)}  ${String(a.present).padStart(7)}  ${String(a.missing).padStart(7)}  ${String(a.untranslatedEnglish).padStart(7)}  ${formatPercent(a.coverage).padStart(9)}`,
      )
    }
  }

  const sparse = audited.filter((a) => isSparseLocale(a.locale))
  if (sparse.length > 0) {
    console.log('')
    console.log('  Sparse overlays (missing keys inherit from parent):')
    for (const a of sparse) {
      console.log(
        `    ${a.locale}: ${a.overrides} overrides / ${a.present} covered`,
      )
    }
  }

  const incomplete = audited.filter((a) => a.missing > 0)
  if (incomplete.length > 0) {
    console.log('')
    for (const a of incomplete) {
      console.log(`  ${a.locale} (${a.missing} missing):`)
      for (const k of a.missingKeys) console.log(`    - ${k}`)
    }
  }

  const englishCopies = audited.filter((a) => a.untranslatedEnglish > 0)
  if (englishCopies.length > 0) {
    console.log('')
    console.log('  Untranslated English on introduced keys:')
    for (const a of englishCopies) {
      console.log(`  ${a.locale} (${a.untranslatedEnglish}):`)
      for (const k of a.untranslatedEnglishKeys) console.log(`    - ${k}`)
    }
  }

  if (errors.length > 0) {
    console.log('')
    console.log('  structural errors:')
    for (const e of errors) console.log(`    ${e}`)
  }

  if (
    valid &&
    summary.totalMissing === 0 &&
    summary.totalUntranslatedEnglish === 0
  ) {
    console.log('')
    console.log('  OK — all locales in sync with en-US.')
  } else {
    console.log('')
    console.log('  FAIL — see above.')
  }
}

function help() {
  return [
    'Usage: bun i18n <command> [args]',
    '',
    'Commands:',
    '  add <path> "<value>"            Add a key to en-US (creates intermediate objects).',
    '  add --stdin                     Read {"path": "value", ...} from stdin and add to en-US.',
    '  set <locale> <path> "<value>"   Set a translation in any single locale.',
    '  set <locale> --stdin            Batch-set from stdin JSON map {"path":"value",...}.',
    '                                  Rejects English copies unless auto-allowed or --allow-english.',
    '                                  --dry-run validates without writing.',
    '  remove <path>                   Remove a key from every locale where it exists (cleanup).',
    '  prune --locale <l> [--against <p>] [--write] [--json]',
    '                                  Shrink a sparse overlay to its genuine overrides by',
    '                                  deleting keys identical to its parent (dry run by default).',
    '  get <locale> <path>             Print the current value at a path.',
    '  get <key...> --locales a,b      Multi-key multi-locale read (--json recommended).',
    '  get --stdin --locales a,b       Read keys from stdin (JSON array or newline list).',
    '  list [locale]                   Print flat dotted keys (defaults to en-US).',
    '  pack --locale <l> | --locales a,b [--keys k1,k2] [--refs a,b] [--usages]',
    '       [--changes-only] [--limit N] [--offset N] [--json]',
    '                                  Export a work pack for agents (single or family).',
    '  plan [--ref HEAD] [--mode oneshot|single|parallel] [--json] [--prompts]',
    '                                  Main-agent dispatch brief after editing en-US.',
    '  next --locale <l> [--size 40] [--refs a,b] [--usages] [--json]',
    '                                  Next unfinished batch for a locale (auto-advances after set).',
    '  usages <key...> [--json]        Best-effort code locations for message keys.',
    '  init-locale <code> --label "…" --flag "…" --family <id> --guide <path.md> [--rtl] [--from <locale>] [--sparse] [--fallback <locale>]',
    '                                  Register a language and install its completed translation guide.',
    '                                  --sparse starts an overlay inheriting from --fallback (or en-US);',
    '                                  only differing keys are stored.',
    '  missing [--locale <l>] [--all] [--json]',
    '                                  List keys missing in a locale (vs en-US).',
    '  identical [--locale <l>] [--json]',
    '                                  Advisory: non-allowlisted values identical to en-US.',
    '  diff [--staged] [--ref <r>] [--locale <l>] [--json]',
    '                                  Show changes vs git, partitioned by translation work.',
    '  check [--changes-only] [--locale <l>] [--ref <r>] [--json]',
    '                                  Audit locales. Exits 1 on orphans, missing keys, or',
    '                                  untranslated English on keys introduced vs --ref.',
    '  validate                        Validate values, guides, placeholders, rich-text tags, plurals, orphans.',
    '  help                            Show this help.',
    '',
    'Exit codes:',
    '  0  clean',
    '  1  translation or validation issues found',
    '  2  usage error or unknown locale / key',
    '',
    'Notes:',
    '  - `add` only touches en-US.json; `remove` cleans the key from every locale.',
    '  - Never paste English into another locale as a placeholder — `set` rejects it.',
    '  - After editing en-US: `bun i18n plan` → oneshot / one subagent / family parallel.',
    '  - New/backfill locale: loop `bun i18n next --locale L` → set --stdin until done.',
    '  - Translators: `pack`/`next` → translate → `set --stdin` → `check`.',
    '  - Use `init-locale --family … --guide path/to/guide.md` to register a brand-new language.',
  ].join('\n')
}

function parseStdinKeys(): string[] {
  const raw = readFileSync(0, 'utf8').trim()
  if (!raw) return []
  if (raw.startsWith('[')) {
    const arr = JSON.parse(raw) as unknown
    if (!Array.isArray(arr) || arr.some((k) => typeof k !== 'string')) {
      die('stdin JSON must be an array of key strings', 2)
    }
    return arr as string[]
  }
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

function printSetResult(
  locale: string,
  result: { count: number; allowEnglishKeys: string[]; dryRun: boolean },
) {
  const verb = result.dryRun ? 'Validated' : 'Set'
  console.log(`${verb} ${result.count} key(s) in ${String(locale)}.`)
  if (result.allowEnglishKeys.length > 0) {
    console.log(
      `Allowed English (via --allow-english): ${result.allowEnglishKeys.join(', ')}`,
    )
  }
}

async function main() {
  const { positional, flags, kvFlags } = parseArgs(process.argv.slice(2))
  const cmd = positional[0]

  if (!cmd || cmd === 'help' || flags.has('help')) {
    console.log(help())
    return
  }

  switch (cmd) {
    case 'add': {
      if (flags.has('stdin')) {
        const raw = readFileSync(0, 'utf8')
        const obj = JSON.parse(raw) as Record<string, unknown>
        let count = 0
        for (const [path, value] of Object.entries(obj)) {
          if (typeof value !== 'string') {
            die(`value for "${path}" must be a string`)
          }
          await addString(path, value)
          count++
        }
        console.log(`Added ${count} key(s) to en-US.`)
        return
      }
      const path = positional[1]
      const value = positional[2]
      if (!path || value === undefined) {
        die('usage: bun i18n add <path> "<value>"')
      }
      await addString(path, value)
      console.log(`Added ${path} to en-US.`)
      return
    }

    case 'set': {
      const locale = positional[1]
      if (!locale)
        die('usage: bun i18n set <locale> <path> "<value>" | --stdin')
      if (!isLocale(locale)) die(`unknown locale: ${String(locale)}`, 2)
      const allowEnglish = flags.has('allow-english')
      const dryRun = flags.has('dry-run')

      if (flags.has('stdin')) {
        const raw = readFileSync(0, 'utf8')
        const obj = JSON.parse(raw) as Record<string, unknown>
        const entries: Record<string, string> = {}
        for (const [path, value] of Object.entries(obj)) {
          if (typeof value !== 'string') {
            die(`value for "${path}" must be a string`, 2)
          }
          entries[path] = value
        }
        try {
          const result = await setStrings(locale, entries, {
            allowEnglish,
            dryRun,
          })
          printSetResult(locale, result)
        } catch (e) {
          die((e as Error).message, 2)
        }
        return
      }

      const path = positional[2]
      const value = positional[3]
      if (!path || value === undefined) {
        die('usage: bun i18n set <locale> <path> "<value>"')
      }
      try {
        const result = await setString(locale, path, value, {
          allowEnglish,
          dryRun,
        })
        printSetResult(locale, result)
      } catch (e) {
        die((e as Error).message, 2)
      }
      return
    }

    case 'remove': {
      const path = positional[1]
      if (!path) die('usage: bun i18n remove <path>')
      const count = await removeString(path)
      if (count === 0) {
        console.log(`Nothing to remove: ${path} not present in any locale.`)
        return
      }
      console.log(`Removed ${path} from ${count} locale(s).`)
      return
    }

    case 'prune': {
      const locale = kvFlags.locale as Locale | undefined
      if (!locale)
        die(
          'usage: bun i18n prune --locale <l> [--against <p>] [--write] [--json]',
          2,
        )
      if (!isLocale(locale)) die(`unknown locale: ${String(locale)}`, 2)
      const against = kvFlags.against as Locale | undefined
      if (against && !isLocale(against)) {
        die(`unknown --against locale: ${String(against)}`, 2)
      }
      try {
        const result = await pruneLocale(locale, {
          against,
          write: flags.has('write'),
        })
        if (flags.has('json')) {
          console.log(JSON.stringify(result, null, 2))
          return
        }
        const verb = result.written ? 'Removed' : 'Would remove'
        console.log(
          `${verb} ${result.removed} key(s) from ${String(locale)} identical to ${String(result.against)} (${result.kept} kept).`,
        )
        const shown = result.identical.slice(0, 30)
        for (const k of shown) console.log(`  - ${k}`)
        if (result.identical.length > shown.length) {
          console.log(`  …and ${result.identical.length - shown.length} more`)
        }
        if (!flags.has('write') && result.removed > 0) {
          console.log('Dry run — pass --write to apply.')
        }
      } catch (e) {
        die((e as Error).message, 2)
      }
      return
    }

    case 'get': {
      const json = flags.has('json')
      const localeList = parseLocaleList(kvFlags.locales)

      if (
        flags.has('stdin') ||
        localeList.length > 0 ||
        positional.length > 3
      ) {
        const keys = flags.has('stdin')
          ? parseStdinKeys()
          : localeList.length > 0
            ? positional.slice(1)
            : positional.slice(2)

        if (localeList.length === 0) {
          // Legacy multi-key without --locales is ambiguous; require locales.
          // But legacy `get <locale> <path>` is handled below.
          if (positional.length === 3 && isLocale(positional[1])) {
            // fall through to legacy
          } else {
            die('usage: bun i18n get <key...> --locales a,b[,c] [--json]', 2)
          }
        }

        if (localeList.length > 0) {
          if (keys.length === 0) die('no keys provided', 2)
          const result = await getKeysAcrossLocales(keys, localeList)
          if (json) {
            console.log(JSON.stringify(result, null, 2))
          } else {
            for (const [key, perLocale] of Object.entries(result)) {
              console.log(key)
              for (const [loc, value] of Object.entries(perLocale)) {
                console.log(`  ${loc}: ${value === null ? '(missing)' : value}`)
              }
            }
          }
          return
        }
      }

      // Legacy: get <locale> <path>
      const locale = positional[1]
      const path = positional[2]
      if (!locale || !path) die('usage: bun i18n get <locale> <path>', 2)
      if (!isLocale(locale)) die(`unknown locale: ${String(locale)}`, 2)
      const data = await readMessagesFile(locale)
      const value = getAt(data, path)
      if (value === undefined) {
        console.log(`(undefined)`)
        process.exit(2)
      }
      console.log(typeof value === 'string' ? value : JSON.stringify(value))
      return
    }

    case 'list': {
      const locale = (positional[1] ?? 'en-US') as Locale
      if (!isLocale(locale)) die(`unknown locale: ${String(locale)}`, 2)
      const data = await readMessagesFile(locale)
      const keys = flattenKeys(data)
      for (const k of keys) console.log(k)
      return
    }

    case 'pack': {
      const locale = kvFlags.locale as Locale | undefined
      const localesList = parseLocaleList(kvFlags.locales)
      if (!locale && localesList.length === 0) {
        die('usage: bun i18n pack --locale <l> | --locales a,b [...]', 2)
      }
      if (locale && localesList.length > 0) {
        die('--locale and --locales are mutually exclusive', 2)
      }
      if (locale) {
        if (!isLocale(locale)) die(`unknown locale: ${String(locale)}`, 2)
        if (locale === 'en-US') {
          die('pack is not meaningful for en-US (it is the source of truth)', 2)
        }
      }
      const refs = parseLocaleList(kvFlags.refs)
      const keys = kvFlags.keys
        ? kvFlags.keys
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined
      const limit = kvFlags.limit ? Number(kvFlags.limit) : undefined
      const offset = kvFlags.offset ? Number(kvFlags.offset) : undefined
      if (limit !== undefined && (!Number.isFinite(limit) || limit < 0)) {
        die('--limit must be a non-negative number', 2)
      }
      if (offset !== undefined && (!Number.isFinite(offset) || offset < 0)) {
        die('--offset must be a non-negative number', 2)
      }

      const result = await packMessages({
        locale,
        locales: localesList.length > 0 ? localesList : undefined,
        keys,
        refs,
        usages: flags.has('usages'),
        changesOnly: flags.has('changes-only'),
        ref: kvFlags.ref,
        limit,
        offset,
      })

      if (flags.has('json')) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        const label =
          result.locales.length === 1
            ? result.locales[0]
            : result.locales.join(',')
        console.log(
          `pack ${label}: ${result.keys.length}/${result.total} keys` +
            (result.limit != null ? ` (limit ${result.limit})` : ''),
        )
        console.log(`  read baseline guide: ${result.guidePaths.baseline}`)
        for (const [loc, path] of Object.entries(result.guidePaths.locales)) {
          console.log(`  read ${loc} guide: ${path}`)
        }
        for (const entry of result.keys) {
          console.log(`  ${entry.key}`)
          console.log(`    en: ${entry.en}`)
          if (entry.byLocale) {
            for (const [loc, info] of Object.entries(entry.byLocale)) {
              console.log(
                `    ${loc} [${info.status}]: ${info.current ?? '(missing)'}`,
              )
            }
          }
        }
      }
      return
    }

    case 'plan': {
      const modeRaw = kvFlags.mode as PlanMode | undefined
      if (
        modeRaw &&
        modeRaw !== 'oneshot' &&
        modeRaw !== 'single' &&
        modeRaw !== 'parallel'
      ) {
        die('--mode must be oneshot, single, or parallel', 2)
      }
      const result = await planTranslations({
        ref: kvFlags.ref,
        mode: modeRaw,
        includePrompts: true,
      })
      if (flags.has('json')) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(formatPlanHuman(result))
        if (flags.has('prompts')) {
          for (const batch of result.batches) {
            console.log('')
            console.log(`----- prompt:${batch.id} -----`)
            console.log(batch.prompt)
          }
        }
      }
      return
    }

    case 'next': {
      const locale = kvFlags.locale as Locale | undefined
      if (!locale) die('usage: bun i18n next --locale <l> [--size 40] [...]', 2)
      if (!isLocale(locale)) die(`unknown locale: ${String(locale)}`, 2)
      if (locale === 'en-US') {
        die('next is not meaningful for en-US', 2)
      }
      const size = kvFlags.size ? Number(kvFlags.size) : undefined
      if (size !== undefined && (!Number.isFinite(size) || size < 1)) {
        die('--size must be a positive integer', 2)
      }
      const refs = parseLocaleList(kvFlags.refs)
      try {
        const result = await nextTranslationBatch({
          locale,
          size,
          refs: refs.length > 0 ? refs : undefined,
          usages: !flags.has('no-usages'),
        })
        if (flags.has('json')) {
          console.log(JSON.stringify(result, null, 2))
        } else {
          console.log(formatNextHuman(result))
        }
        if (result.done) process.exit(0)
      } catch (e) {
        die((e as Error).message, 2)
      }
      return
    }

    case 'usages': {
      const keys = positional.slice(1)
      if (keys.length === 0) die('usage: bun i18n usages <key...> [--json]', 2)
      const result: Record<string, Awaited<ReturnType<typeof findUsages>>> = {}
      for (const key of keys) {
        result[key] = await findUsages(key)
      }
      if (flags.has('json')) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        for (const [key, hits] of Object.entries(result)) {
          console.log(`${key}: ${hits.length} hit(s)`)
          for (const hit of hits) {
            console.log(`  ${hit.file}:${hit.line}  ${hit.snippet}`)
          }
        }
      }
      return
    }

    case 'init-locale': {
      const code = positional[1]
      const label = kvFlags.label
      const flag = kvFlags.flag
      const family = kvFlags.family
      const guide = kvFlags.guide
      if (!code || !label || !flag || !family || !guide) {
        die(
          'usage: bun i18n init-locale <code> --label "<Native>" --flag "<emoji>" --family <id> --guide <path.md> [--rtl] [--from <locale>] [--sparse] [--fallback <locale>]',
          2,
        )
      }
      const from = kvFlags.from as Locale | undefined
      if (from && !isLocale(from))
        die(`unknown --from locale: ${String(from)}`, 2)
      try {
        const result = await initLocale({
          code,
          label,
          flag,
          family,
          guide,
          rtl: flags.has('rtl'),
          from,
          sparse: flags.has('sparse'),
          fallback: kvFlags.fallback,
        })
        console.log(
          `Initialized locale ${result.code} (family ${result.family}).`,
        )
        console.log('Touched:')
        for (const f of result.filesTouched) console.log(`  ${f}`)
        console.log('Next:')
        for (const step of result.nextSteps) console.log(`  ${step}`)
      } catch (e) {
        die((e as Error).message, 2)
      }
      return
    }

    case 'missing': {
      const json = flags.has('json')
      if (flags.has('all')) {
        if (kvFlags.locale) {
          die('--all and --locale are mutually exclusive', 2)
        }
        const allMissing = await missingKeysByLocale()
        if (json) {
          console.log(JSON.stringify(allMissing, null, 2))
        } else {
          let total = 0
          for (const locale of locales.filter((l) => l !== 'en-US')) {
            const missing = allMissing[locale]
            total += missing.length
            console.log(`${String(locale)}: ${missing.length} missing`)
          }
          console.log(`Total: ${total} missing across all locales.`)
        }
        return
      }
      const locale = kvFlags.locale as Locale | undefined
      const target = locale ?? 'en-US'
      if (!isLocale(target)) die(`unknown locale: ${String(target)}`, 2)
      if (target === 'en-US') {
        die(
          'missing is not meaningful for en-US (it is the source of truth)',
          2,
        )
      }
      const missing = await missingKeys(target)
      if (json) {
        console.log(JSON.stringify({ locale: target, missing }, null, 2))
      } else {
        console.log(`${missing.length} key(s) missing in ${String(target)}:`)
        for (const k of missing) console.log(`  ${k}`)
      }
      return
    }

    case 'identical': {
      const locale = kvFlags.locale as Locale | undefined
      if (locale && !isLocale(locale))
        die(`unknown locale: ${String(locale)}`, 2)
      if (locale === 'en-US') {
        die('identical is not meaningful for en-US', 2)
      }
      const result = await identicalKeysByLocale(locale)
      if (flags.has('json')) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        let total = 0
        for (const [loc, keys] of Object.entries(result)) {
          total += keys.length
          console.log(`${loc}: ${keys.length} identical to en-US`)
          for (const k of keys) console.log(`  ${k}`)
        }
        console.log(`Total: ${total}`)
      }
      return
    }

    case 'diff': {
      const staged = flags.has('staged')
      const ref = kvFlags.ref
      const locale = kvFlags.locale as Locale | undefined
      const json = flags.has('json')
      if (locale && !isLocale(locale))
        die(`unknown locale: ${String(locale)}`, 2)
      const result = await diffMessages({ staged, ref, locale })
      if (json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        console.log(formatDiffHuman(result))
      }
      return
    }

    case 'validate': {
      const result = await validateAllMessages()
      if (result.valid) {
        console.log(`All ${locales.length} message files valid.`)
        return
      }
      console.error(`Found ${result.errors.length} error(s):`)
      for (const e of result.errors) console.error(`  ${e}`)
      return process.exit(1)
    }

    case 'check': {
      const json = flags.has('json')
      const changesOnly = flags.has('changes-only')
      const locale = kvFlags.locale as Locale | undefined
      const ref = kvFlags.ref
      if (locale && !isLocale(locale))
        die(`unknown locale: ${String(locale)}`, 2)
      if (locale === 'en-US') {
        die('check is not meaningful for en-US (it is the source of truth)', 2)
      }

      const result = await auditMessages({ changesOnly, locale, ref })

      if (json) {
        console.log(JSON.stringify(result, null, 2))
      } else {
        printCheckHuman(result)
      }

      if (
        !result.valid ||
        result.summary.totalMissing > 0 ||
        result.summary.totalUntranslatedEnglish > 0
      ) {
        process.exit(1)
      }
      return
    }

    default:
      die(`unknown command: ${cmd}\n\n${help()}`, 2)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
