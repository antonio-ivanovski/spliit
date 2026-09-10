import { type Locale } from '../../../packages/domain/src/i18n'
import { fallbackChain, isSparseLocale, parentRefLocales } from './fallbacks'
import { readGitBlob, readMessagesFile } from './fs-helpers'
import { getGuidePaths, type GuidePaths } from './guides'
import { expectedKeysForLocale } from './message-validation'
import { flattenKeys, getAt } from './object-path'
import { findUsagesForKeys, type UsageHit } from './usages'

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([A-Za-z][\w.-]*)\}/g)].map((m) => m[1]).sort()
}

function richTextTags(value: string): string[] {
  const tags = new Set<string>()
  for (const match of value.matchAll(/<\/?([A-Za-z][\w-]*)\s*\/?>/g)) {
    tags.add(match[1])
  }
  return [...tags].sort()
}

function topLevelSection(key: string): string {
  return key.split('.')[0] ?? key
}

function pickNeighbors(
  targetData: Record<string, unknown>,
  key: string,
  limit = 3,
): Record<string, string> {
  const section = topLevelSection(key)
  const neighbors: Record<string, string> = {}
  for (const candidate of flattenKeys(targetData)) {
    if (candidate === key) continue
    if (topLevelSection(candidate) !== section) continue
    const value = getAt(targetData, candidate)
    if (typeof value !== 'string') continue
    neighbors[candidate] = value
    if (Object.keys(neighbors).length >= limit) break
  }
  return neighbors
}

async function introducedKeysVsRef(
  ref: string,
  readOldEn?: () => Promise<Record<string, unknown> | null>,
): Promise<{ all: string[]; modified: Set<string> }> {
  const enNow = await readMessagesFile('en-US')
  const enOld = readOldEn ? await readOldEn() : await readGitBlob(ref, 'en-US')
  const oldKeys = new Set(enOld ? flattenKeys(enOld) : [])
  const newKeys = flattenKeys(enNow)
  const all: string[] = []
  const modified = new Set<string>()
  for (const key of newKeys) {
    if (!oldKeys.has(key)) {
      all.push(key)
    } else if (enOld && getAt(enOld, key) !== getAt(enNow, key)) {
      all.push(key)
      modified.add(key)
    }
  }
  all.sort()
  return { all, modified }
}

export type LocaleKeyStatus = 'missing' | 'stale' | 'ok'

export type PackLocaleEntry = {
  status: LocaleKeyStatus
  current: string | null
  neighbors: Record<string, string>
  /** Sibling locale values from the same pack (in-family refs) plus --refs. */
  values: Record<string, string | null>
}

export type PackKey = {
  key: string
  en: string
  placeholders: string[]
  tags: string[]
  /** Legacy single-locale: external/sibling ref values for the primary locale. */
  values: Record<string, string | null>
  neighbors: Record<string, string>
  usages?: UsageHit[]
  byLocale?: Record<string, PackLocaleEntry>
}

export type PackResult = {
  locale?: Locale
  locales: Locale[]
  guidePaths: GuidePaths
  ref: string
  refs: Locale[]
  changesOnly: boolean
  total: number
  offset: number
  limit: number | null
  keys: PackKey[]
}

export type PackOptions = {
  locale?: Locale
  locales?: Locale[]
  keys?: string[]
  refs?: Locale[]
  usages?: boolean
  changesOnly?: boolean
  ref?: string
  limit?: number
  offset?: number
  readOldEn?: () => Promise<Record<string, unknown> | null>
  usagesRoot?: string
  projectRoot?: string
}

function resolveTargetLocales(opts: PackOptions): Locale[] {
  if (opts.locales && opts.locales.length > 0) {
    const unique = [...new Set(opts.locales)]
    if (unique.includes('en-US')) {
      throw new Error('pack target locales cannot include en-US')
    }
    return unique
  }
  if (opts.locale) {
    if (opts.locale === 'en-US') {
      throw new Error(
        'pack is not meaningful for en-US (it is the source of truth)',
      )
    }
    return [opts.locale]
  }
  throw new Error('pack requires --locale <l> or --locales a,b,c')
}

function statusFor(
  key: string,
  present: boolean,
  staleKeys: ReadonlySet<string>,
): LocaleKeyStatus {
  if (!present) return 'missing'
  if (staleKeys.has(key)) return 'stale'
  return 'ok'
}

export async function packMessages(opts: PackOptions): Promise<PackResult> {
  const targetLocales = resolveTargetLocales(opts)
  const guidePaths = await getGuidePaths({
    root: opts.projectRoot,
    locales: targetLocales,
  })
  const multi = targetLocales.length > 1 || opts.locales !== undefined
  const primary = targetLocales[0]
  const ref = opts.ref ?? 'HEAD'
  const explicitRefs = (opts.refs ?? []).filter(
    (l) => !targetLocales.includes(l),
  )
  // Sparse overlays inherit from their parent bundle(s): surface the parent
  // values as refs automatically (en-US is already shown as `en`).
  const autoRefs = [...new Set(targetLocales.flatMap(parentRefLocales))].filter(
    (l) => !targetLocales.includes(l) && !explicitRefs.includes(l as Locale),
  ) as Locale[]
  const allRefs = [...explicitRefs, ...autoRefs]
  const offset = opts.offset ?? 0
  const limit = opts.limit ?? null

  const enData = await readMessagesFile('en-US')
  const enKeys = flattenKeys(enData)
  const localeDatas = new Map<Locale, Record<string, unknown>>()
  await Promise.all(
    targetLocales.map(async (locale) => {
      localeDatas.set(locale, await readMessagesFile(locale))
    }),
  )
  const externalRefDatas = new Map<Locale, Record<string, unknown>>()
  await Promise.all(
    allRefs.map(async (locale) => {
      externalRefDatas.set(locale, await readMessagesFile(locale))
    }),
  )

  const intro =
    opts.changesOnly || opts.keys
      ? await introducedKeysVsRef(ref, opts.readOldEn)
      : { all: [] as string[], modified: new Set<string>() }
  const staleKeys = intro.modified

  // Fallback ancestors of sparse targets: keys inherited from them need no
  // work in the overlay locale.
  const sparseChainMembers = [
    ...new Set(
      targetLocales.flatMap((locale) =>
        isSparseLocale(locale) ? fallbackChain(locale) : [],
      ),
    ),
  ].filter((l) => !targetLocales.includes(l))
  const ancestorDatas = new Map<Locale, Record<string, unknown>>()
  await Promise.all(
    sparseChainMembers.map(async (locale) => {
      ancestorDatas.set(locale, await readMessagesFile(locale))
    }),
  )
  const coveredByLocale = new Map<Locale, Set<string>>()
  for (const locale of targetLocales) {
    if (!isSparseLocale(locale)) continue
    const covered = new Set(flattenKeys(localeDatas.get(locale)!))
    for (const ancestor of fallbackChain(locale)) {
      const data = ancestorDatas.get(ancestor) ?? localeDatas.get(ancestor)
      if (data) {
        for (const key of flattenKeys(data)) covered.add(key)
      }
    }
    coveredByLocale.set(locale, covered)
  }

  let candidateKeys: string[]
  if (opts.keys && opts.keys.length > 0) {
    candidateKeys = [...new Set(opts.keys)].sort()
  } else if (opts.changesOnly) {
    candidateKeys = intro.all
  } else if (!multi) {
    const data = localeDatas.get(primary)!
    const uncovered = (coveredByLocale.get(primary) ??
      new Set(flattenKeys(data))) as Set<string>
    candidateKeys = expectedKeysForLocale(enKeys, primary).filter(
      (k) => !uncovered.has(k),
    )
  } else {
    // Multi without --keys/--changes-only: union of missing across targets
    const keySet = new Set<string>()
    for (const locale of targetLocales) {
      const data = localeDatas.get(locale)!
      const uncovered = (coveredByLocale.get(locale) ??
        new Set(flattenKeys(data))) as Set<string>
      for (const key of expectedKeysForLocale(enKeys, locale)) {
        if (!uncovered.has(key)) keySet.add(key)
      }
    }
    candidateKeys = [...keySet].sort()
  }

  // Keep keys that need work in at least one target locale.
  // In explicit modes (--keys/--changes-only) inherited keys are kept for
  // review (marked ok below); in missing-queue modes they are not work.
  const explicitMode = (opts.keys?.length ?? 0) > 0 || opts.changesOnly || false
  const workKeys = candidateKeys.filter((key) =>
    targetLocales.some((locale) => {
      const data = localeDatas.get(locale)!
      const expected = new Set(expectedKeysForLocale(enKeys, locale))
      if (!expected.has(key)) return false
      const present = typeof getAt(data, key) === 'string'
      if (!present && coveredByLocale.get(locale)?.has(key)) {
        return explicitMode
      }
      const status = statusFor(key, present, staleKeys)
      return status !== 'ok'
    }),
  )

  const total = workKeys.length
  const sliced =
    limit == null
      ? workKeys.slice(offset)
      : workKeys.slice(offset, offset + limit)

  const usagesByKey = opts.usages
    ? await findUsagesForKeys(sliced, {
        root: opts.usagesRoot,
        projectRoot: opts.projectRoot,
      })
    : null

  const keys: PackKey[] = sliced.map((key) => {
    const en = getAt(enData, key)
    const enStr = typeof en === 'string' ? en : ''
    const byLocale: Record<string, PackLocaleEntry> = {}

    for (const locale of targetLocales) {
      const data = localeDatas.get(locale)!
      const currentRaw = getAt(data, key)
      const current = typeof currentRaw === 'string' ? currentRaw : null
      const values: Record<string, string | null> = {}
      for (const other of targetLocales) {
        if (other === locale) continue
        const v = getAt(localeDatas.get(other)!, key)
        values[other] = typeof v === 'string' ? v : null
      }
      for (const [refLocale, refData] of externalRefDatas) {
        const v = getAt(refData, key)
        values[refLocale] = typeof v === 'string' ? v : null
      }
      // Inherited keys surface for review in explicit modes: nothing is
      // stored (current null) and the parent value is visible in values.
      const inherited =
        current === null && coveredByLocale.get(locale)?.has(key) === true
      byLocale[locale] = {
        status: inherited ? 'ok' : statusFor(key, current !== null, staleKeys),
        current,
        neighbors: pickNeighbors(data, key),
        values,
      }
    }

    const primaryEntry = byLocale[primary]
    const entry: PackKey = {
      key,
      en: enStr,
      placeholders: placeholders(enStr),
      tags: richTextTags(enStr),
      values: primaryEntry.values,
      neighbors: primaryEntry.neighbors,
      byLocale,
    }
    if (usagesByKey) entry.usages = usagesByKey[key] ?? []
    return entry
  })

  return {
    locale: multi ? undefined : primary,
    locales: targetLocales,
    guidePaths,
    ref,
    refs: allRefs,
    changesOnly: !!opts.changesOnly,
    total,
    offset,
    limit,
    keys,
  }
}
