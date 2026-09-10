import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'

import { ACCOUNT_LOCALE_CHANGED_EVENT } from '@/lib/account-preferences'
import {
  defaultLocale,
  fallbackChain,
  locales,
  type Locale,
} from '@spliit/domain/i18n'

const COOKIE_NAME = 'SPLIIT_LOCALE'

export const defaultNS = 'translation'

const messageModules = import.meta.glob<{ default: unknown }>(
  '@/messages/*.json',
)

function loaderFor(
  locale: Locale,
): (() => Promise<{ default: unknown }>) | undefined {
  const suffix = `/${locale}.json`
  for (const [path, loader] of Object.entries(messageModules)) {
    if (path === suffix || path.endsWith(suffix)) return loader
  }
  return undefined
}

export async function loadLocaleMessages(locale: Locale): Promise<unknown> {
  const loader = loaderFor(locale)
  if (!loader) {
    throw new Error(`No message bundle registered for locale "${locale}"`)
  }
  const mod = await loader()
  return mod.default
}

export const i18n = i18next.createInstance()

const loadedLocales = new Set<Locale>()

const canonicalLocaleMap = new Map(
  locales.map((locale) => [new Intl.Locale(locale).toString(), locale]),
)

export async function loadLocale(locale: Locale) {
  // Load the locale plus its fallback chain (e.g. pt-BR → pt → en-US) so
  // sparse overlay locales resolve inherited keys at runtime.
  for (const lng of [locale, ...fallbackChain(locale)]) {
    if (loadedLocales.has(lng)) continue
    const messages = await loadLocaleMessages(lng)
    i18n.addResourceBundle(lng, defaultNS, messages, true, true)
    loadedLocales.add(lng)
  }
}

/**
 * Match a browser locale tag to the closest locale supported by Spliit.
 *
 * Browser preferences commonly include a region that differs from the
 * translation bundle (for example fr-CA), so exact matching alone is not
 * sufficient.
 */
export function matchSupportedLocale(localeTag: string): Locale | undefined {
  let browserLocale: Intl.Locale
  try {
    browserLocale = new Intl.Locale(localeTag)
  } catch {
    return undefined
  }

  const exact = canonicalLocaleMap.get(browserLocale.toString())
  if (exact) return exact

  if (browserLocale.language === 'pt') {
    return browserLocale.region === 'BR' ? 'pt-BR' : 'pt'
  }

  if (browserLocale.language === 'zh') {
    const maximized = browserLocale.maximize()
    const isTraditional =
      browserLocale.script === 'Hant' ||
      maximized.script === 'Hant' ||
      ['TW', 'HK', 'MO'].includes(
        browserLocale.region ?? maximized.region ?? '',
      )
    return isTraditional ? 'zh-TW' : 'zh-CN'
  }

  // Keep generic English browser preferences on the default locale. The
  // playful en-GZ bundle is opt-in through an exact locale or user choice.
  if (browserLocale.language === 'en') return 'en-US'

  const languageMatches = locales.filter(
    (locale) => new Intl.Locale(locale).language === browserLocale.language,
  )
  return languageMatches.length === 1 ? languageMatches[0] : undefined
}

export function detectBrowserLocale(): Locale | undefined {
  if (typeof navigator === 'undefined') return undefined

  const preferences =
    navigator.languages.length > 0
      ? navigator.languages
      : navigator.language
        ? [navigator.language]
        : []

  for (const preference of preferences) {
    const match = matchSupportedLocale(preference)
    if (match) return match
  }
  return undefined
}

export function detectLocale(): Locale {
  if (typeof document === 'undefined') return defaultLocale
  const cookieLocale = document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${COOKIE_NAME}=`))
    ?.split('=')[1]
  if (cookieLocale && (locales as readonly string[]).includes(cookieLocale)) {
    return cookieLocale as Locale
  }
  return detectBrowserLocale() ?? defaultLocale
}

/**
 * I18next fallback map derived from the domain fallback chains. Sparse overlay
 * locales inherit missing keys from their parent bundle(s); every other locale
 * falls back to the default locale as before.
 */
export function buildFallbackLng(): Record<string, string[]> {
  const fallbackLng: Record<string, string[]> = { default: [defaultLocale] }
  for (const locale of locales) {
    if (locale === defaultLocale) continue
    const chain = fallbackChain(locale)
    if (
      chain.length > 0 &&
      !(chain.length === 1 && chain[0] === defaultLocale)
    ) {
      fallbackLng[locale] = chain
    }
  }
  return fallbackLng
}

export async function initI18n() {
  const locale = detectLocale()
  // Init first so the store API (addResourceBundle, hasResourceBundle, ...)
  // is wired onto the instance — see i18next's init() where it copies the
  // store methods onto the i18n object.
  await i18n.use(initReactI18next).init({
    lng: locale,
    fallbackLng: buildFallbackLng(),
    defaultNS,
    interpolation: { escapeValue: false, prefix: '{', suffix: '}' },
    partialBundledLanguages: true,
    resources: {},
  })
  // loadLocale also loads the fallback chain (e.g. pt-BR → pt → en-US).
  await loadLocale(locale)
  return i18n
}

export async function setUserLocale(
  locale: Locale,
  options: { notify?: boolean; persist?: boolean } = {},
) {
  if (options.persist !== false) {
    document.cookie = `${COOKIE_NAME}=${locale};path=/;max-age=31536000;samesite=lax`
  }
  await loadLocale(locale)
  await i18n.changeLanguage(locale)
  if (options.notify !== false) {
    window.dispatchEvent(
      new CustomEvent(ACCOUNT_LOCALE_CHANGED_EVENT, { detail: locale }),
    )
  }
}
