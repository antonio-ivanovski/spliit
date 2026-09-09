import { act, cleanup, render } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/react'
import { defaultLocale } from '@/i18n/request'
import {
  detectBrowserLocale,
  detectLocale,
  i18n,
  loadLocale,
  matchSupportedLocale,
  setUserLocale,
} from '@/i18n/setup'

// ── Helpers ────────────────────────────────────────────────────────────

const COOKIE_NAME = 'SPLIIT_LOCALE'

/** Read a cookie value from jsdom's cookie jar. */
function getCookie(name: string): string | undefined {
  return document.cookie
    .split('; ')
    .find((row) => row.startsWith(`${name}=`))
    ?.split('=')[1]
}

/** Restore i18n language to default after tests that change it. */
async function resetLocale() {
  if (i18n.language !== defaultLocale) {
    await i18n.changeLanguage(defaultLocale)
  }
}

function mockBrowserLocales(...locales: string[]) {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(locales)
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(locales[0] ?? '')
}

describe('matchSupportedLocale', () => {
  it.each([
    ['fr-FR', 'fr-FR'],
    ['FR-fr', 'fr-FR'],
    ['en-GB', 'en-GB'],
    ['fr-CA', 'fr-FR'],
    ['de-AT', 'de-DE'],
    ['es-MX', 'es'],
    ['pt-BR', 'pt-BR'],
    ['pt-PT', 'pt'],
    ['pt-AO', 'pt'],
    ['zh-Hant', 'zh-TW'],
    ['zh-HK', 'zh-TW'],
    ['zh-SG', 'zh-CN'],
    ['xx-XX', undefined],
    ['not_a_locale', undefined],
  ])('matches %s to %s', (browserLocale, expected) => {
    expect(matchSupportedLocale(browserLocale)).toBe(expected)
  })

  it('uses the first supported browser preference', () => {
    mockBrowserLocales('xx-XX', 'fr-CA', 'de-DE')
    expect(detectBrowserLocale()).toBe('fr-FR')
  })
})

// ── detectLocale ───────────────────────────────────────────────────────

describe('detectLocale', () => {
  beforeEach(() => {
    // Clear any existing cookie
    document.cookie = `${COOKIE_NAME}=;path=/;max-age=0`
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads locale from cookie first', () => {
    document.cookie = `${COOKIE_NAME}=fr-FR;path=/`
    expect(detectLocale()).toBe('fr-FR')
  })

  it('favors cookie over navigator.language', () => {
    // Set both — cookie should win
    document.cookie = `${COOKIE_NAME}=de-DE;path=/`
    mockBrowserLocales('en-US')
    expect(detectLocale()).toBe('de-DE')
  })

  it('falls back to the closest navigator locale when no cookie is set', () => {
    mockBrowserLocales('fr-CA')
    expect(detectLocale()).toBe('fr-FR')
  })

  it('falls back to defaultLocale when navigator.language is not supported', () => {
    mockBrowserLocales('xx-XX')
    expect(detectLocale()).toBe(defaultLocale)
  })

  it('falls back to defaultLocale when cookie is set to an unsupported locale', () => {
    document.cookie = `${COOKIE_NAME}=xx-XX;path=/`
    mockBrowserLocales('xx-XX')
    expect(detectLocale()).toBe(defaultLocale)
  })
})

// ── loadLocale ─────────────────────────────────────────────────────────

describe('loadLocale', () => {
  afterEach(async () => {
    await resetLocale()
  })

  it('adds resource bundle to i18next for a new locale', async () => {
    const locale = 'fr-FR'

    // Should not have the bundle yet
    expect(i18n.hasResourceBundle(locale, 'translation')).toBe(false)

    await loadLocale(locale)

    expect(i18n.hasResourceBundle(locale, 'translation')).toBe(true)
  })

  it('is idempotent when called twice with the same locale', async () => {
    const locale = 'de-DE'

    // First call
    await loadLocale(locale)
    expect(i18n.hasResourceBundle(locale, 'translation')).toBe(true)

    // Second call — should not throw and bundle stays loaded
    await loadLocale(locale)
    expect(i18n.hasResourceBundle(locale, 'translation')).toBe(true)
  })
})

// ── setUserLocale ──────────────────────────────────────────────────────

describe('setUserLocale', () => {
  beforeEach(() => {
    // Clear any existing cookie
    document.cookie = `${COOKIE_NAME}=;path=/;max-age=0`
  })

  afterEach(async () => {
    await resetLocale()
    vi.restoreAllMocks()
  })

  it('sets cookie with the locale', async () => {
    await setUserLocale('fr-FR')

    expect(getCookie(COOKIE_NAME)).toBe('fr-FR')
  })

  it('loads the locale resources and changes language', async () => {
    await setUserLocale('fr-FR')

    expect(i18n.hasResourceBundle('fr-FR', 'translation')).toBe(true)
    expect(i18n.language).toBe('fr-FR')
  })

  it('can switch between multiple locales', async () => {
    await setUserLocale('fr-FR')
    expect(i18n.language).toBe('fr-FR')

    await setUserLocale('de-DE')
    expect(i18n.language).toBe('de-DE')
    expect(getCookie(COOKIE_NAME)).toBe('de-DE')
  })
})

// ── document locale metadata ───────────────────────────────────────────

describe('I18nProvider document locale metadata', () => {
  afterEach(async () => {
    cleanup()
    await resetLocale()
    document.documentElement.lang = defaultLocale
    document.documentElement.dir = 'ltr'
  })

  it('applies the initial locale and RTL direction on mount', async () => {
    await i18n.changeLanguage('he')

    render(createElement(I18nProvider, null, createElement('div')))

    expect(document.documentElement.lang).toBe('he')
    expect(document.documentElement.dir).toBe('rtl')
  })

  it('updates the locale and restores LTR when switching away from Hebrew', async () => {
    render(createElement(I18nProvider, null, createElement('div')))

    await act(() => i18n.changeLanguage('he'))
    expect(document.documentElement.lang).toBe('he')
    expect(document.documentElement.dir).toBe('rtl')

    await act(() => i18n.changeLanguage('fr-FR'))
    expect(document.documentElement.lang).toBe('fr-FR')
    expect(document.documentElement.dir).toBe('ltr')
  })
})
