export const localeLabels = {
  'ar-SA': 'العربية',
  'bn-BD': 'বাংলা',
  'en-GZ': 'English (Gen Z)',
  'hi-IN': 'हिन्दी',
  id: 'Bahasa Indonesia',
  ca: 'Català',
  'cs-CZ': 'Česky',
  'de-DE': 'Deutsch',
  'en-GB': 'English (GB)',
  'en-US': 'English (US)',
  es: 'Español',
  eu: 'Euskera',
  'fr-FR': 'Français',
  'it-IT': 'Italiano',
  'nl-NL': 'Nederlands',
  'pl-PL': 'Polski',
  pt: 'Português',
  'pt-BR': 'Português Brasileiro',
  ro: 'Română',
  fi: 'Suomi',
  'sv-SE': 'Svenska',
  'tr-TR': 'Türkçe',
  'ru-RU': 'Русский',
  'uk-UA': 'Українська',
  he: 'עברית',
  ko: '한국어',
  'mk-MK': 'Македонски',
  'ja-JP': '日本語',
  'ur-PK': 'اردو',
  vi: 'Tiếng Việt',
  'zh-CN': '简体中文',
  'zh-TW': '正體中文',
} as const

export const locales = Object.keys(localeLabels) as Array<
  keyof typeof localeLabels
>
export type Locale = keyof typeof localeLabels
export type Locales = ReadonlyArray<Locale>
export const defaultLocale: Locale = 'en-US'

/**
 * Translation bundle identifiers are not always complete BCP 47 locale tags.
 * Resolve them to the regional locale whose formatting conventions match the
 * flag/region presented in the locale picker before using Intl APIs.
 */
const formattingLocaleByLocale: Partial<Record<Locale, string>> = {
  id: 'id-ID',
  ca: 'ca-ES',
  es: 'es-ES',
  eu: 'eu-ES',
  // The generic Portuguese bundle is the Portugal variant; pt-BR is explicit.
  pt: 'pt-PT',
  ro: 'ro-RO',
  fi: 'fi-FI',
  he: 'he-IL',
  ko: 'ko-KR',
  vi: 'vi-VN',
  // en-GZ is a synthetic translation bundle, not a real territory.
  'en-GZ': 'en-US',
}

export function resolveFormattingLocale(locale: string): string {
  const mapped = formattingLocaleByLocale[locale as Locale]
  if (mapped) return mapped
  try {
    return new Intl.Locale(locale).toString()
  } catch {
    return defaultLocale
  }
}

/** Returns ISO weekday numbering (Monday = 1, Sunday = 7). */
export function firstDayOfWeek(locale: string): number {
  try {
    const localeInfo = new Intl.Locale(
      resolveFormattingLocale(locale),
    ) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number }
      weekInfo?: { firstDay: number }
    }
    const weekInfo =
      typeof localeInfo.getWeekInfo === 'function'
        ? localeInfo.getWeekInfo()
        : localeInfo.weekInfo
    if (weekInfo && typeof weekInfo.firstDay === 'number') {
      return weekInfo.firstDay
    }
  } catch {
    // Fall through to the default English-US convention.
  }
  return 7
}

export function isRtlLocale(locale: string): boolean {
  try {
    return new Set(['ar', 'he', 'ur']).has(
      new Intl.Locale(resolveFormattingLocale(locale)).language,
    )
  } catch {
    return false
  }
}
