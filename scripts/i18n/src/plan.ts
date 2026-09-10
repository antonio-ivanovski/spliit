import { type Locale } from '../../../packages/domain/src/i18n'
import { coveredKeys, isSparseLocale, readChainDatas } from './fallbacks'
import {
  LANGUAGE_FAMILIES,
  assertFamiliesCoverAllLocales,
  nonEnLocales,
} from './families'
import { readGitBlob, readMessagesFile } from './fs-helpers'
import { getGuidePaths, type GuidePaths } from './guides'
import { expectedKeysForLocale } from './message-validation'
import { flattenKeys, getAt } from './object-path'

export type PlanMode = 'noop' | 'oneshot' | 'single' | 'parallel'

export type PlanKey = {
  key: string
  en: string
  change: 'added' | 'modified'
}

export type PlanFamily = {
  id: string
  label: string
  locales: Locale[]
  refsHint: string
  cells: number
  missingCells: number
  staleCells: number
  packCommand: string
}

export type PlanBatch = {
  id: string
  locales: Locale[]
  guidePaths: GuidePaths
  keys: string[]
  refsHint: string
  packCommand: string
  prompt: string
}

export type PlanResult = {
  ref: string
  mode: PlanMode
  guidePaths: GuidePaths
  reason: string
  keys: PlanKey[]
  summary: {
    introduced: number
    localesNeedingWork: number
    totalCells: number
    missingCells: number
    staleCells: number
  }
  families: PlanFamily[]
  batches: PlanBatch[]
}

export type PlanOptions = {
  ref?: string
  /** Force mode; otherwise chosen from introduced key count. */
  mode?: Exclude<PlanMode, 'noop'>
  readOldEn?: () => Promise<Record<string, unknown> | null>
  includePrompts?: boolean
  projectRoot?: string
}

const ONESHOT_MAX_KEYS = 2
const SINGLE_MAX_KEYS = 8

export function selectPlanMode(introducedKeyCount: number): PlanMode {
  if (introducedKeyCount <= 0) return 'noop'
  if (introducedKeyCount <= ONESHOT_MAX_KEYS) return 'oneshot'
  if (introducedKeyCount <= SINGLE_MAX_KEYS) return 'single'
  return 'parallel'
}

async function introducedChanges(
  ref: string,
  readOldEn?: () => Promise<Record<string, unknown> | null>,
): Promise<{ added: string[]; modified: string[] }> {
  const enNow = await readMessagesFile('en-US')
  const enOld = readOldEn ? await readOldEn() : await readGitBlob(ref, 'en-US')
  const oldKeys = new Set(enOld ? flattenKeys(enOld) : [])
  const newKeys = flattenKeys(enNow)
  const added: string[] = []
  const modified: string[] = []
  for (const key of newKeys) {
    if (!oldKeys.has(key)) {
      added.push(key)
    } else if (enOld && getAt(enOld, key) !== getAt(enNow, key)) {
      modified.push(key)
    }
  }
  added.sort()
  modified.sort()
  return { added, modified }
}

function buildPackCommand(locales: Locale[], keys: string[]): string {
  return `bun i18n pack --locales ${locales.join(',')} --keys ${keys.join(',')} --usages --json`
}

function selectGuidePaths(
  guidePaths: GuidePaths,
  targetLocales: readonly Locale[],
): GuidePaths {
  const selected: Record<string, string> = {}
  for (const locale of targetLocales) {
    const path = guidePaths.locales[locale]
    if (path) selected[locale] = path
  }
  return { baseline: guidePaths.baseline, locales: selected }
}

function guideLines(
  guidePaths: GuidePaths,
  targetLocales: readonly Locale[],
): string[] {
  return [
    `Read the shared baseline guide before translating: ${guidePaths.baseline}`,
    ...targetLocales.map(
      (locale) =>
        `Read the ${locale} locale guide before translating: ${guidePaths.locales[locale]}`,
    ),
  ]
}

function buildTranslatorPrompt(opts: {
  batchId: string
  locales: Locale[]
  guidePaths: GuidePaths
  keys: PlanKey[]
  refsHint: string
  packCommand: string
}): string {
  const keyLines = opts.keys
    .map((k) => `- ${k.key} (${k.change}): ${JSON.stringify(k.en)}`)
    .join('\n')
  const sparse = opts.locales.filter((l) => isSparseLocale(l))
  return [
    `You are a Spliit translation subagent for batch "${opts.batchId}".`,
    `Load the skill at .agents/skills/translate-strings/SKILL.md (translator role).`,
    ``,
    `Own ONLY these locales (do not edit any other locale or en-US): ${opts.locales.join(', ')}`,
    ...guideLines(opts.guidePaths, opts.locales),
    `Suggested terminology refs within the family: ${opts.refsHint}`,
    ...(sparse.length > 0
      ? [
          `Sparse overlay locale(s): ${sparse.join(', ')} — only set keys that genuinely differ from their parent bundle; omit identical keys to inherit them (\`set\` rejects inherited values).`,
        ]
      : []),
    ``,
    `Keys to translate (introduced vs ref):`,
    keyLines,
    ``,
    `Workflow:`,
    `1. ${opts.packCommand}`,
    `2. For each owned locale, translate every missing/stale key. Preserve {placeholders} and rich-text tags.`,
    `3. If a string is short, ambiguous, or meaning is unclear from English alone: run \`bun i18n usages <key> --json\` and read the surrounding UI before translating.`,
    `4. Apply with \`bun i18n set <locale> --stdin\` (one locale at a time). Never paste English as a placeholder.`,
    `5. Finish with \`bun i18n check --locale <each-owned-locale> --changes-only\` exit 0 for every owned locale.`,
    ``,
    `Report: locales touched, keys per locale, check exit codes, any --allow-english keys.`,
  ].join('\n')
}

function buildOneshotPrompt(opts: {
  keys: PlanKey[]
  locales: Locale[]
  guidePaths: GuidePaths
  packCommand: string
}): string {
  const keyLines = opts.keys
    .map((k) => `- ${k.key} (${k.change}): ${JSON.stringify(k.en)}`)
    .join('\n')
  return [
    `Oneshot translation (main agent) — few introduced keys.`,
    `Load .agents/skills/translate-strings/SKILL.md.`,
    ``,
    `Keys:`,
    keyLines,
    ``,
    `Translate into ALL non-en locales: ${opts.locales.join(', ')}`,
    ...guideLines(opts.guidePaths, opts.locales),
    `1. ${opts.packCommand}`,
    `2. For ambiguous strings, run \`bun i18n usages <key> --json\` before translating.`,
    `3. \`bun i18n set <locale> --stdin\` per locale — never paste English placeholders.`,
    `4. \`bun i18n check --changes-only\` exit 0.`,
  ].join('\n')
}

export async function planTranslations(
  opts: PlanOptions = {},
): Promise<PlanResult> {
  assertFamiliesCoverAllLocales()

  const ref = opts.ref ?? 'HEAD'
  const { added, modified } = await introducedChanges(ref, opts.readOldEn)
  const enData = await readMessagesFile('en-US')
  const targetLocales = nonEnLocales()
  const guidePaths = await getGuidePaths({
    root: opts.projectRoot,
    locales: targetLocales,
    requireInventory: true,
  })

  const keys: PlanKey[] = [
    ...added.map((key) => ({
      key,
      en:
        typeof getAt(enData, key) === 'string'
          ? (getAt(enData, key) as string)
          : '',
      change: 'added' as const,
    })),
    ...modified.map((key) => ({
      key,
      en:
        typeof getAt(enData, key) === 'string'
          ? (getAt(enData, key) as string)
          : '',
      change: 'modified' as const,
    })),
  ]
  keys.sort((a, b) => a.key.localeCompare(b.key))

  const keyList = keys.map((k) => k.key)
  const modifiedSet = new Set(modified)

  let missingCells = 0
  let staleCells = 0
  const localesNeedingWork = new Set<Locale>()
  const cellsByLocale = new Map<
    Locale,
    { missing: number; stale: number; cells: number }
  >()

  await Promise.all(
    targetLocales.map(async (locale) => {
      const sparse = isSparseLocale(locale)
      const chain = sparse ? await readChainDatas(locale) : null
      const present = chain
        ? new Set(flattenKeys(chain[0].data))
        : new Set(flattenKeys(await readMessagesFile(locale)))
      const covered = chain ? coveredKeys(chain) : present
      const expected = new Set(
        expectedKeysForLocale(flattenKeys(enData), locale),
      )
      let missing = 0
      let stale = 0
      for (const key of keyList) {
        if (!expected.has(key)) continue
        if (!present.has(key)) {
          // Sparse overlays inherit this key — no work in this locale.
          if (sparse && covered.has(key)) continue
          missing++
          continue
        }
        if (modifiedSet.has(key)) {
          stale++
        }
      }
      const cells = missing + stale
      cellsByLocale.set(locale, { missing, stale, cells })
      missingCells += missing
      staleCells += stale
      if (cells > 0) localesNeedingWork.add(locale)
    }),
  )

  const totalCells = missingCells + staleCells
  let mode: PlanMode =
    totalCells === 0 ? 'noop' : (opts.mode ?? selectPlanMode(keys.length))
  if (totalCells === 0) mode = 'noop'

  const reason =
    mode === 'noop'
      ? 'No translation cells for introduced keys — nothing to do'
      : mode === 'oneshot'
        ? `${keys.length} introduced key(s) (<=${ONESHOT_MAX_KEYS}) — main agent should oneshot all locales`
        : mode === 'single'
          ? `${keys.length} introduced keys (<=${SINGLE_MAX_KEYS}) — one translator subagent for all families`
          : `${keys.length} introduced keys (>=${SINGLE_MAX_KEYS + 1}) — one subagent per language family in parallel`

  const families: PlanFamily[] = LANGUAGE_FAMILIES.map((family) => {
    let cells = 0
    let famMissing = 0
    let famStale = 0
    for (const locale of family.locales) {
      const stats = cellsByLocale.get(locale)
      if (!stats) continue
      cells += stats.cells
      famMissing += stats.missing
      famStale += stats.stale
    }
    return {
      id: family.id,
      label: family.label,
      locales: family.locales,
      refsHint: family.refsHint,
      cells,
      missingCells: famMissing,
      staleCells: famStale,
      packCommand: buildPackCommand(family.locales, keyList),
    }
  })

  const batches = buildBatches({
    mode,
    keys,
    keyList,
    familyStats: families,
    allLocales: targetLocales,
    guidePaths,
    includePrompts: opts.includePrompts !== false,
  })

  return {
    ref,
    mode,
    guidePaths,
    reason,
    keys,
    summary: {
      introduced: keys.length,
      localesNeedingWork: localesNeedingWork.size,
      totalCells,
      missingCells,
      staleCells,
    },
    families,
    batches,
  }
}

function buildBatches(opts: {
  mode: PlanMode
  keys: PlanKey[]
  keyList: string[]
  familyStats: PlanFamily[]
  allLocales: Locale[]
  guidePaths: GuidePaths
  includePrompts: boolean
}): PlanBatch[] {
  if (opts.mode === 'noop' || opts.keyList.length === 0) return []

  if (opts.mode === 'oneshot') {
    const packCommand = buildPackCommand(opts.allLocales, opts.keyList)
    return [
      {
        id: 'oneshot',
        locales: opts.allLocales,
        guidePaths: selectGuidePaths(opts.guidePaths, opts.allLocales),
        keys: opts.keyList,
        refsHint: 'es,fr-FR,de-DE',
        packCommand,
        prompt: opts.includePrompts
          ? buildOneshotPrompt({
              keys: opts.keys,
              locales: opts.allLocales,
              guidePaths: opts.guidePaths,
              packCommand,
            })
          : '',
      },
    ]
  }

  if (opts.mode === 'single') {
    const packCommand = buildPackCommand(opts.allLocales, opts.keyList)
    const prompt = opts.includePrompts
      ? [
          `You are a Spliit translation subagent. Process ALL language families sequentially in one run.`,
          `Load .agents/skills/translate-strings/SKILL.md (translator role).`,
          ``,
          `Introduced keys:`,
          ...opts.keys.map(
            (k) => `- ${k.key} (${k.change}): ${JSON.stringify(k.en)}`,
          ),
          ``,
          `For each family below, pack → translate → set --stdin → check --locale for each locale in that family.`,
          `If a string is ambiguous, run \`bun i18n usages <key> --json\` and read the UI context before translating.`,
          ...guideLines(opts.guidePaths, opts.allLocales),
          `Never paste English. Never edit en-US.`,
          ``,
          ...opts.familyStats.map(
            (f) =>
              `### ${f.label} (${f.id})\nLocales: ${f.locales.join(', ')}\nRefs: ${f.refsHint}\n${f.packCommand}`,
          ),
          ``,
          `Finish: every owned locale passes \`bun i18n check --locale <L> --changes-only\`.`,
        ].join('\n')
      : ''
    return [
      {
        id: 'all-families',
        locales: opts.allLocales,
        guidePaths: selectGuidePaths(opts.guidePaths, opts.allLocales),
        keys: opts.keyList,
        refsHint: 'per-family (see prompt)',
        packCommand,
        prompt,
      },
    ]
  }

  return opts.familyStats
    .filter((f) => f.cells > 0)
    .map((f) => {
      const packCommand = f.packCommand
      return {
        id: f.id,
        locales: f.locales,
        guidePaths: selectGuidePaths(opts.guidePaths, f.locales),
        keys: opts.keyList,
        refsHint: f.refsHint,
        packCommand,
        prompt: opts.includePrompts
          ? buildTranslatorPrompt({
              batchId: f.id,
              locales: f.locales,
              guidePaths: selectGuidePaths(opts.guidePaths, f.locales),
              keys: opts.keys,
              refsHint: f.refsHint,
              packCommand,
            })
          : '',
      }
    })
}

export function formatPlanHuman(plan: PlanResult): string {
  const lines: string[] = []
  lines.push(`i18n plan (vs ${plan.ref})`)
  lines.push(`  mode: ${plan.mode}`)
  lines.push(`  ${plan.reason}`)
  lines.push(
    `  keys: ${plan.summary.introduced} introduced | cells: ${plan.summary.totalCells} (${plan.summary.missingCells} missing, ${plan.summary.staleCells} stale) | locales needing work: ${plan.summary.localesNeedingWork}`,
  )
  if (plan.keys.length > 0) {
    lines.push('')
    lines.push('  Introduced keys:')
    for (const k of plan.keys) {
      lines.push(`    [${k.change}] ${k.key}: ${JSON.stringify(k.en)}`)
    }
  }
  if (plan.families.length > 0 && plan.mode !== 'noop') {
    lines.push('')
    lines.push('  Families:')
    for (const f of plan.families) {
      lines.push(
        `    ${f.id.padEnd(12)} ${String(f.cells).padStart(3)} cells  (${f.locales.join(',')})`,
      )
    }
  }
  if (plan.batches.length > 0) {
    lines.push('')
    lines.push(`  Batches (${plan.batches.length}):`)
    for (const b of plan.batches) {
      lines.push(`    - ${b.id}: ${b.locales.length} locales`)
      lines.push(`      baseline guide: ${b.guidePaths.baseline}`)
      for (const [locale, path] of Object.entries(b.guidePaths.locales)) {
        lines.push(`      ${locale} guide: ${path}`)
      }
      lines.push(`      ${b.packCommand}`)
    }
  }
  if (plan.mode === 'parallel') {
    lines.push('')
    lines.push(
      '  Dispatch: launch one Task per batch in the same message (parallel).',
    )
  } else if (plan.mode === 'single') {
    lines.push('')
    lines.push(
      '  Dispatch: launch exactly one translator Task with the batch prompt.',
    )
  } else if (plan.mode === 'oneshot') {
    lines.push('')
    lines.push('  Dispatch: do NOT spawn subagents — translate yourself.')
  }
  return lines.join('\n')
}
