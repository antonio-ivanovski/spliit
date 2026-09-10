import { type Locale } from '../../../packages/domain/src/i18n'
import {
  coveredKeys,
  isSparseLocale,
  parentRefLocales,
  readChainDatas,
} from './fallbacks'
import { familyForLocale } from './families'
import { readMessagesFile } from './fs-helpers'
import { getGuidePaths, type GuidePaths } from './guides'
import { expectedKeysForLocale } from './message-validation'
import { flattenKeys } from './object-path'
import { packMessages, type PackKey } from './pack'

export type NextBatchResult = {
  locale: Locale
  guidePaths: GuidePaths
  refs: Locale[]
  size: number
  /** Keys still missing (auto-advances after set — no --offset). */
  remaining: number
  /** Keys already present vs expected for this locale. */
  completed: number
  /** Expected key count for this locale. */
  total: number
  /** 1-based batch index from progress. */
  batch: number
  done: boolean
  checkCommand: string
  nextCommand: string
  setCommand: string
  keys: PackKey[]
  /** Empty-string map for agents to fill and pipe to set --stdin. */
  applyTemplate: Record<string, string>
}

export type NextBatchOptions = {
  locale: Locale
  size?: number
  refs?: Locale[]
  usages?: boolean
  usagesRoot?: string
  projectRoot?: string
}

const DEFAULT_SIZE = 40

function defaultRefs(locale: Locale): Locale[] {
  // Parent bundles first: a sparse overlay is translated against them.
  const parents = parentRefLocales(locale).filter((r) => r !== locale)
  const family = familyForLocale(locale)
  const familyRefs = family
    ? (family.refsHint
        .split(',')
        .map((s) => s.trim())
        .filter((r) => r.length > 0 && r !== locale) as Locale[])
    : []
  return [...new Set([...parents, ...familyRefs])]
}

async function localeProgress(locale: Locale): Promise<{
  expectedTotal: number
  completedCount: number
  missingCount: number
}> {
  const [enData, localeData] = await Promise.all([
    readMessagesFile('en-US'),
    readMessagesFile(locale),
  ])
  const expected = expectedKeysForLocale(flattenKeys(enData), locale)
  // Sparse overlays inherit missing keys — only uncovered keys are work.
  const done =
    isSparseLocale(locale) && locale !== 'en-US'
      ? coveredKeys(await readChainDatas(locale))
      : new Set(flattenKeys(localeData))
  const completedCount = expected.filter((k) => done.has(k)).length
  return {
    expectedTotal: expected.length,
    completedCount,
    missingCount: expected.length - completedCount,
  }
}

export async function nextTranslationBatch(
  opts: NextBatchOptions,
): Promise<NextBatchResult> {
  const locale = opts.locale
  if (locale === 'en-US') {
    throw new Error('next is not meaningful for en-US')
  }

  const size = opts.size ?? DEFAULT_SIZE
  if (!Number.isFinite(size) || size < 1) {
    throw new Error('--size must be a positive integer')
  }

  const refs =
    opts.refs && opts.refs.length > 0 ? opts.refs : defaultRefs(locale)

  const progress = await localeProgress(locale)
  const guidePaths = await getGuidePaths({
    root: opts.projectRoot,
    locales: [locale],
  })

  // First N still-missing keys — after set, the next call advances automatically.
  const pack = await packMessages({
    locale,
    refs,
    usages: opts.usages ?? true,
    limit: size,
    offset: 0,
    usagesRoot: opts.usagesRoot,
    projectRoot: opts.projectRoot,
  })

  const remaining = progress.missingCount
  const completed = progress.completedCount
  const batch = remaining === 0 ? 0 : Math.floor(completed / size) + 1

  const refsArg = refs.length > 0 ? ` --refs ${refs.join(',')}` : ''
  const nextCommand = `bun i18n next --locale ${locale} --size ${size}${refsArg} --usages --json`
  const setCommand = `bun i18n set ${locale} --stdin`
  const checkCommand = `bun i18n check --locale ${locale}`

  const applyTemplate: Record<string, string> = {}
  for (const entry of pack.keys) {
    applyTemplate[entry.key] = ''
  }

  return {
    locale,
    guidePaths,
    refs,
    size,
    remaining,
    completed,
    total: progress.expectedTotal,
    batch,
    done: pack.keys.length === 0,
    checkCommand,
    nextCommand,
    setCommand,
    keys: pack.keys,
    applyTemplate,
  }
}

export function formatNextHuman(result: NextBatchResult): string {
  const lines: string[] = []
  lines.push(`i18n next — ${result.locale}`)
  lines.push(
    `  progress: ${result.completed}/${result.total} done | ${result.remaining} remaining | batch ${result.batch} (size ${result.size})`,
  )
  if (result.done) {
    lines.push('  DONE — no missing keys in this locale.')
    lines.push(`  Run: ${result.checkCommand}`)
    return lines.join('\n')
  }
  if (result.refs.length > 0) {
    lines.push(`  refs: ${result.refs.join(',')}`)
  }
  lines.push(`  read baseline guide: ${result.guidePaths.baseline}`)
  lines.push(`  read locale guide: ${result.guidePaths.locales[result.locale]}`)
  lines.push(`  keys in this batch: ${result.keys.length}`)
  lines.push('')
  lines.push('  Translate the keys below, then:')
  lines.push(`    ${result.setCommand}   # JSON map of key → translation`)
  lines.push(`    ${result.nextCommand}`)
  lines.push('')
  for (const entry of result.keys) {
    lines.push(`  ${entry.key}`)
    lines.push(`    en: ${entry.en}`)
    for (const [loc, value] of Object.entries(entry.values)) {
      if (value) lines.push(`    ${loc}: ${value}`)
    }
  }
  return lines.join('\n')
}
