import { locales, type Locale } from '../../../packages/domain/src/i18n.ts'

export type LanguageFamily = {
  id: string
  label: string
  locales: Locale[]
  /** Suggested sibling locales for terminology when packing this family. */
  refsHint: string
}

/**
 * Fixed family groupings for translation dispatch (every non-en locale exactly
 * once).
 */
export const LANGUAGE_FAMILIES: LanguageFamily[] = [
  {
    id: 'romance',
    label: 'Romance',
    locales: ['ca', 'es', 'eu', 'fr-FR', 'it-IT', 'pt', 'pt-BR', 'ro'],
    refsHint: 'es,fr-FR',
  },
  {
    id: 'germanic',
    label: 'Germanic + Nordic',
    locales: ['de-DE', 'en-GB', 'en-GZ', 'fi', 'nl-NL', 'sv-SE'],
    refsHint: 'de-DE,nl-NL',
  },
  {
    id: 'slavic',
    label: 'Slavic',
    locales: ['cs-CZ', 'mk-MK', 'pl-PL', 'ru-RU', 'uk-UA'],
    refsHint: 'pl-PL,ru-RU',
  },
  {
    id: 'east-asian',
    label: 'East Asian',
    locales: ['ja-JP', 'ko', 'zh-CN', 'zh-TW'],
    refsHint: 'zh-CN,ja-JP',
  },
  {
    id: 'indic',
    label: 'Indic',
    locales: ['bn-BD', 'hi-IN', 'ur-PK'],
    refsHint: 'hi-IN,ur-PK',
  },
  {
    id: 'semitic',
    label: 'Semitic',
    locales: ['ar-SA', 'he'],
    refsHint: 'ar-SA',
  },
  {
    id: 'southeast-asian',
    label: 'Southeast Asian',
    locales: ['id', 'vi'],
    refsHint: 'id',
  },
  {
    id: 'turkic',
    label: 'Turkic',
    locales: ['tr-TR'],
    refsHint: '',
  },
]

export function nonEnLocales(): Locale[] {
  return locales.filter((l) => l !== 'en-US')
}

/** Throws if families drift from domain locales. */
export function assertFamiliesCoverAllLocales(): void {
  const covered = new Set(LANGUAGE_FAMILIES.flatMap((f) => f.locales))
  const expected = nonEnLocales()
  const missing = expected.filter((l) => !covered.has(l))
  const extra = [...covered].filter(
    (l) => !(expected as readonly string[]).includes(l),
  )
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `LANGUAGE_FAMILIES out of sync (missing: ${missing.join(',') || '—'}; extra: ${extra.join(',') || '—'})`,
    )
  }
  const seen = new Set<string>()
  for (const locale of LANGUAGE_FAMILIES.flatMap((f) => f.locales)) {
    if (seen.has(locale)) {
      throw new Error(`LANGUAGE_FAMILIES duplicate locale: ${locale}`)
    }
    seen.add(locale)
  }
}

export function familyForLocale(locale: Locale): LanguageFamily | undefined {
  return LANGUAGE_FAMILIES.find((f) => f.locales.includes(locale))
}
