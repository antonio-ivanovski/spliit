import { locales, type Locale } from '../../../packages/domain/src/i18n'

export { locales }
export type { Locale }
export { fallbackChain, isSparseLocale } from './fallbacks'

export type { Path } from './object-path'

export type DiffResult = {
  ref: string
  thisChange: {
    added: string[]
    modified: string[]
    removed: string[]
  }
  translationWork: Record<
    string,
    {
      missing: string[]
      present: string[]
      /** Changed keys a sparse overlay inherits — no action needed. */
      covered: string[]
    }
  >
  legacyMissing: Record<string, number>
}

export type ValidationResult = {
  valid: boolean
  errors: string[]
}

export type LocaleAudit = {
  locale: Locale
  total: number
  present: number
  missing: number
  missingKeys: string[]
  /** Keys stored in the locale file itself (== present for full locales). */
  overrides: number
  /** Introduced keys whose locale value equals en-US and is not auto-allowed. */
  untranslatedEnglishKeys: string[]
  untranslatedEnglish: number
  coverage: number
}

export type AuditSummary = {
  localesAudited: number
  localesComplete: number
  localesWithMissing: number
  totalMissing: number
  totalUntranslatedEnglish: number
  localesWithUntranslatedEnglish: number
}

export type AuditResult = {
  valid: boolean
  errors: string[]
  totalKeys: number
  changesOnly: boolean
  ref: string
  introducedKeys: string[]
  locales: Record<string, LocaleAudit>
  summary: AuditSummary
}

export type AuditOptions = {
  locale?: Locale
  changesOnly?: boolean
  ref?: string
  readOldEn?: () => Promise<Record<string, unknown> | null>
}

// Re-exports from split modules
export {
  getMessagesDir,
  LOCALE_TO_FILE,
  localeFileName,
  readMessagesFile,
  setMessagesDir,
} from './fs-helpers'

export {
  cleanupEmptyParents,
  flattenKeys,
  getAt,
  removeAt,
  reorderSiblings,
  setAt,
  setAtOrdered,
} from './object-path'

export {
  addString,
  missingKeys,
  removeString,
  setString,
  setStrings,
} from './translate'

export { pruneLocale } from './prune'
export type { PruneOptions, PruneResult } from './prune'

export { packMessages } from './pack'
export type {
  LocaleKeyStatus,
  PackKey,
  PackLocaleEntry,
  PackOptions,
  PackResult,
} from './pack'

export { formatPlanHuman, planTranslations, selectPlanMode } from './plan'
export type {
  PlanBatch,
  PlanFamily,
  PlanKey,
  PlanMode,
  PlanOptions,
  PlanResult,
} from './plan'

export { formatNextHuman, nextTranslationBatch } from './next-batch'
export type { NextBatchOptions, NextBatchResult } from './next-batch'

export {
  assertCompletedGuide,
  assertGuideInventory,
  getGuidePaths,
  resolveGuideInput,
} from './guides'
export type { GuidePaths, GuideValidationOptions } from './guides'

export {
  assertFamiliesCoverAllLocales,
  LANGUAGE_FAMILIES,
  nonEnLocales,
} from './families'

export { findUsages, findUsagesForKeys, usageSearchKey } from './usages'
export type { UsageHit } from './usages'

export {
  addLocaleToFamilySource,
  addRtlLocale,
  initLocale,
  insertObjectEntry,
} from './init-locale'
export type { InitLocaleOptions, InitLocaleResult } from './init-locale'

export {
  classifyEnglishIdentity,
  isAutoAllowedEnglishIdentity,
} from './english-identity'

// ---------------------------------------------------------------------------
// Audit / diff logic
// ---------------------------------------------------------------------------

import { classifyEnglishIdentity } from './english-identity'
import {
  coveredKeys,
  isSparseLocale,
  ownKeys,
  readChainDatas,
} from './fallbacks'
import {
  LOCALE_TO_FILE,
  readGitBlob,
  readMessagesFile,
  readStagedBlob,
} from './fs-helpers'
import { getGuidePaths } from './guides'
import {
  expectedKeysForLocale,
  getPluralFamilies,
  isAllowedLocaleKey,
  validateMessageData,
} from './message-validation'
import { flattenKeys, getAt } from './object-path'

export async function diffMessages(
  opts: {
    ref?: string
    staged?: boolean
    locale?: Locale
    readOldEn?: () => Promise<Record<string, unknown> | null>
  } = {},
): Promise<DiffResult> {
  const ref = opts.ref ?? 'HEAD'
  const enNow = await readMessagesFile('en-US')

  const enOld = opts.readOldEn
    ? await opts.readOldEn()
    : opts.staged
      ? await readStagedBlob('en-US')
      : await readGitBlob(ref, 'en-US')

  const oldKeys = new Set(enOld ? flattenKeys(enOld) : [])
  const newKeys = flattenKeys(enNow)
  const newKeySet = new Set(newKeys)

  const added: string[] = []
  const modified: string[] = []
  const removed: string[] = []
  for (const key of newKeys) {
    if (!oldKeys.has(key)) {
      added.push(key)
    } else if (getAt(enOld!, key) !== getAt(enNow, key)) {
      modified.push(key)
    }
  }
  for (const key of oldKeys) {
    if (!newKeySet.has(key)) removed.push(key)
  }
  added.sort()
  modified.sort()
  removed.sort()

  const changedKeys = [...added, ...modified]
  const changedKeySet = new Set(changedKeys)

  const targetLocales = opts.locale
    ? locales.filter((l) => l === opts.locale)
    : locales.filter((l) => l !== 'en-US')

  const translationWork: Record<
    string,
    { missing: string[]; present: string[]; covered: string[] }
  > = {}
  const legacyMissing: Record<string, number> = {}
  const allEnKeys = flattenKeys(enNow)

  await Promise.all(
    targetLocales.map(async (locale) => {
      const sparse = isSparseLocale(locale)
      const chain = sparse ? await readChainDatas(locale) : null
      const presentKeys = chain
        ? ownKeys(chain)
        : new Set(flattenKeys(await readMessagesFile(locale)))
      const covered = chain ? coveredKeys(chain) : presentKeys
      const expectedKeys = new Set(expectedKeysForLocale(newKeys, locale))
      const relevantChangedKeys = changedKeys.filter((key) =>
        expectedKeys.has(key),
      )

      const missing: string[] = []
      const present: string[] = []
      const coveredList: string[] = []
      for (const key of relevantChangedKeys) {
        if (presentKeys.has(key)) present.push(key)
        else if (sparse && covered.has(key)) coveredList.push(key)
        else missing.push(key)
      }
      translationWork[locale] = { missing, present, covered: coveredList }

      const legacyCount = expectedKeysForLocale(allEnKeys, locale).filter(
        (k) => !covered.has(k) && !changedKeySet.has(k),
      ).length
      legacyMissing[locale] = legacyCount
    }),
  )

  return {
    ref,
    thisChange: { added, modified, removed },
    translationWork,
    legacyMissing,
  }
}

export async function validateAllMessages(
  targetLocale?: Locale,
): Promise<ValidationResult> {
  const errors: string[] = []
  try {
    await getGuidePaths(
      targetLocale ? { locales: [targetLocale] } : { requireInventory: true },
    )
  } catch (e) {
    errors.push(`guides: ${(e as Error).message}`)
  }
  const sourceData = await readMessagesFile('en-US')
  const sourceKeyList = flattenKeys(sourceData)
  const sourceKeys = new Set(sourceKeyList)
  const sourceFamilies = getPluralFamilies(sourceKeyList)

  await Promise.all(
    locales
      .filter(
        (locale) =>
          targetLocale === undefined ||
          locale === 'en-US' ||
          locale === targetLocale,
      )
      .map(async (locale) => {
        try {
          const sparse = isSparseLocale(locale)
          const chain = sparse ? await readChainDatas(locale) : null
          const data = chain ? chain[0].data : await readMessagesFile(locale)
          const localeKeys = flattenKeys(data)
          for (const key of localeKeys) {
            if (!isAllowedLocaleKey(key, sourceKeys, sourceFamilies)) {
              errors.push(
                `${LOCALE_TO_FILE[locale]}: orphan key "${key}" — not present in en-US`,
              )
            }
          }
          for (const error of validateMessageData(
            locale,
            data,
            sourceData,
            sourceKeyList,
            chain ? coveredKeys(chain) : undefined,
          )) {
            errors.push(`${LOCALE_TO_FILE[locale]}: ${error}`)
          }
        } catch (e) {
          errors.push(`${locale}: ${(e as Error).message}`)
        }
      }),
  )

  errors.sort()
  return { valid: errors.length === 0, errors }
}

function untranslatedEnglishKeysForLocale(
  enData: Record<string, unknown>,
  localeData: Record<string, unknown>,
  candidateKeys: readonly string[],
): string[] {
  const bad: string[] = []
  for (const key of candidateKeys) {
    const enValue = getAt(enData, key)
    const locValue = getAt(localeData, key)
    if (typeof enValue !== 'string' || typeof locValue !== 'string') continue
    const identity = classifyEnglishIdentity(enValue, locValue)
    if (identity.identical && !identity.allowed) bad.push(key)
  }
  return bad.sort()
}

export async function auditMessages(
  opts: AuditOptions = {},
): Promise<AuditResult> {
  const [valResult, enData] = await Promise.all([
    validateAllMessages(opts.locale),
    readMessagesFile('en-US'),
  ])

  const enKeys = flattenKeys(enData)
  const totalKeys = enKeys.length

  const ref = opts.ref ?? 'HEAD'
  // Always compute introduced keys vs ref so English-copy gate can apply
  // even on a full check (legacy identical strings are not gated).
  const diff = await diffMessages({ ref, readOldEn: opts.readOldEn })
  const introducedKeys = [...diff.thisChange.added, ...diff.thisChange.modified]
  const introducedSet = new Set(introducedKeys)

  const targetLocales = opts.locale
    ? locales.filter((l) => l === opts.locale)
    : locales.filter((l) => l !== 'en-US')

  const localesAudit: Record<string, LocaleAudit> = {}
  await Promise.all(
    targetLocales.map(async (locale) => {
      const sparse = isSparseLocale(locale)
      const chain = sparse ? await readChainDatas(locale) : null
      const data = chain ? chain[0].data : await readMessagesFile(locale)
      const presentSet = new Set(flattenKeys(data))
      // Sparse overlays inherit missing keys from their parent bundle(s);
      // only keys covered nowhere count as missing.
      const covered = chain ? coveredKeys(chain) : presentSet
      const expectedKeys = expectedKeysForLocale(enKeys, locale)
      let missingKeysList = expectedKeys.filter((k) => !covered.has(k))
      if (opts.changesOnly) {
        missingKeysList = missingKeysList.filter((k) => introducedSet.has(k))
      }

      const introducedPresent = expectedKeys.filter(
        (k) => introducedSet.has(k) && presentSet.has(k),
      )
      const untranslated = untranslatedEnglishKeysForLocale(
        enData,
        data,
        introducedPresent,
      )

      const localeTotal = expectedKeys.length
      const presentCount = localeTotal - missingKeysList.length
      localesAudit[locale] = {
        locale,
        total: localeTotal,
        present: presentCount,
        missing: missingKeysList.length,
        missingKeys: missingKeysList,
        overrides: presentSet.size,
        untranslatedEnglishKeys: untranslated,
        untranslatedEnglish: untranslated.length,
        coverage: localeTotal === 0 ? 1 : presentCount / localeTotal,
      }
    }),
  )

  let totalMissing = 0
  let localesComplete = 0
  let totalUntranslatedEnglish = 0
  let localesWithUntranslatedEnglish = 0
  for (const audit of Object.values(localesAudit)) {
    totalMissing += audit.missing
    totalUntranslatedEnglish += audit.untranslatedEnglish
    if (audit.untranslatedEnglish > 0) localesWithUntranslatedEnglish++
    if (audit.missing === 0) localesComplete++
  }

  return {
    valid: valResult.valid,
    errors: valResult.errors,
    totalKeys,
    changesOnly: !!opts.changesOnly,
    ref,
    introducedKeys,
    locales: localesAudit,
    summary: {
      localesAudited: targetLocales.length,
      localesComplete,
      localesWithMissing: targetLocales.length - localesComplete,
      totalMissing,
      totalUntranslatedEnglish,
      localesWithUntranslatedEnglish,
    },
  }
}

/** Advisory: all non-allowlisted identical-to-en keys (legacy + current). */
export async function identicalKeysByLocale(
  targetLocale?: Locale,
): Promise<Record<string, string[]>> {
  const enData = await readMessagesFile('en-US')
  const enKeys = flattenKeys(enData)
  const targetLocales = targetLocale
    ? locales.filter((l) => l === targetLocale)
    : locales.filter((l) => l !== 'en-US')

  const result: Record<string, string[]> = {}
  await Promise.all(
    targetLocales.map(async (locale) => {
      const data = await readMessagesFile(locale)
      const expected = expectedKeysForLocale(enKeys, locale)
      result[locale] = untranslatedEnglishKeysForLocale(enData, data, expected)
    }),
  )
  return result
}

export async function missingKeysByLocale(): Promise<Record<Locale, string[]>> {
  const enData = await readMessagesFile('en-US')
  const enKeys = flattenKeys(enData)
  const result = {} as Record<Locale, string[]>
  await Promise.all(
    locales
      .filter((l) => l !== 'en-US')
      .map(async (locale) => {
        const sparse = isSparseLocale(locale)
        const chain = sparse ? await readChainDatas(locale) : null
        const covered = chain
          ? coveredKeys(chain)
          : new Set(flattenKeys(await readMessagesFile(locale)))
        result[locale] = expectedKeysForLocale(enKeys, locale).filter(
          (k) => !covered.has(k),
        )
      }),
  )
  return result
}

export async function getKeysAcrossLocales(
  keys: string[],
  targetLocales: Locale[],
): Promise<Record<string, Record<string, string | null>>> {
  const uniqueLocales = [...new Set(targetLocales)]
  const dataByLocale = new Map<Locale, Record<string, unknown>>()
  await Promise.all(
    uniqueLocales.map(async (locale) => {
      dataByLocale.set(locale, await readMessagesFile(locale))
    }),
  )

  const result: Record<string, Record<string, string | null>> = {}
  for (const key of keys) {
    const perLocale: Record<string, string | null> = {}
    for (const locale of uniqueLocales) {
      const value = getAt(dataByLocale.get(locale)!, key)
      perLocale[locale] = typeof value === 'string' ? value : null
    }
    result[key] = perLocale
  }
  return result
}
