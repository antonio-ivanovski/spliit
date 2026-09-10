import { fallbackChain, type Locale } from '../../../packages/domain/src/i18n'
import { readMessagesFile, writeMessagesFile } from './fs-helpers'
import {
  cleanupEmptyParents,
  flattenKeys,
  getAt,
  removeAt,
} from './object-path'

export type PruneOptions = {
  /** Bundle to compare against (defaults to the direct fallback parent). */
  against?: Locale
  /** Without write, only report what would be removed (dry run). */
  write?: boolean
}

export type PruneResult = {
  locale: Locale
  against: Locale
  /** Keys in the locale identical to the parent (inheritance candidates). */
  identical: string[]
  /** Keys kept because they differ, are missing upstream, or are orphans. */
  kept: number
  removed: number
  written: boolean
}

/**
 * Shrink a sparse overlay locale to its genuine overrides by deleting keys
 * identical to its parent bundle. Keys that differ, are missing upstream, or
 * are orphans vs en-US are always kept.
 */
export async function pruneLocale(
  locale: Locale,
  opts: PruneOptions = {},
): Promise<PruneResult> {
  const against =
    opts.against ??
    fallbackChain(locale)[0] ??
    (locale === 'en-US' ? null : 'en-US')
  if (!against) {
    throw new Error(`prune needs --against <locale> for ${locale}`)
  }
  if (against === locale) {
    throw new Error(`prune --against must differ from --locale ${locale}`)
  }

  const [data, parentData] = await Promise.all([
    readMessagesFile(locale),
    readMessagesFile(against),
  ])

  const identical: string[] = []
  let kept = 0
  for (const key of flattenKeys(data)) {
    const value = getAt(data, key)
    const parentValue = getAt(parentData, key)
    if (
      typeof value === 'string' &&
      typeof parentValue === 'string' &&
      value === parentValue
    ) {
      identical.push(key)
    } else {
      kept++
    }
  }
  identical.sort()

  if (opts.write && identical.length > 0) {
    for (const key of identical) {
      if (removeAt(data, key)) cleanupEmptyParents(data, key)
    }
    await writeMessagesFile(locale, data)
  }

  return {
    locale,
    against,
    identical,
    kept,
    removed: identical.length,
    written: !!opts.write && identical.length > 0,
  }
}
