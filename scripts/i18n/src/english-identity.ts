/**
 * Detects when a non-en-US locale value is identical to the English source.
 * Some identical values are language-neutral and auto-allowed (brands, URLs,
 * placeholder-only templates); everything else needs a real translation or an
 * explicit --allow-english escape hatch.
 */

const BRAND_TOKENS = new Set([
  // Loanword kept verbatim in some locales (e.g. it-IT) — intentional keeper.
  'Password',
  // Mascot character given name — same across locales.
  'Bill',
  'GitHub',
  'Spliit',
  'Splitwise',
  'Cospend',
  'Maxio',
  'Apple',
  'Google',
  'PayPal',
  'Venmo',
  'iOS',
  'Android',
  'API',
  'CSV',
  'PDF',
  'URL',
  'OK',
  // Crypto currency brands — same name across all locales.
  'Bitcoin',
  'Dogecoin',
  'Ethereum',
  'Litecoin',
  'Sats',
  'Solana',
  'XRP',
  // FX rate provider brands — proper nouns, same across locales.
  'Coinbase',
  'Frankfurter',
])

const URL_OR_EMAIL = /^(https?:\/\/\S+|[\w.+-]+@[\w.-]+\.\w+|mailto:\S+)$/i

/** Strip i18next placeholders and rich-text tags; leftover letters matter. */
function letterContentOutsideMarkup(value: string): string {
  return value
    .replace(/\{[A-Za-z][\w.-]*\}/g, '')
    .replace(/<\/?[A-Za-z][\w-]*\s*\/?>/g, '')
    .replace(/[^\p{L}]/gu, '')
}

export function isAutoAllowedEnglishIdentity(enValue: string): boolean {
  const trimmed = enValue.trim()
  if (trimmed.length === 0) return false
  if (BRAND_TOKENS.has(trimmed)) return true
  if (URL_OR_EMAIL.test(trimmed)) return true
  // Format templates whose only letters live inside {placeholders} / tags
  if (letterContentOutsideMarkup(trimmed).length === 0) return true
  return false
}

export type EnglishIdentityResult =
  | { identical: false }
  | { identical: true; allowed: true; reason: 'auto' | 'flag' }
  | { identical: true; allowed: false }

export function classifyEnglishIdentity(
  enValue: string,
  localeValue: string,
  opts: { allowEnglish?: boolean } = {},
): EnglishIdentityResult {
  if (enValue !== localeValue) return { identical: false }
  if (isAutoAllowedEnglishIdentity(enValue)) {
    return { identical: true, allowed: true, reason: 'auto' }
  }
  if (opts.allowEnglish) {
    return { identical: true, allowed: true, reason: 'flag' }
  }
  return { identical: true, allowed: false }
}

export function englishIdentityError(locale: string, key: string): string {
  return (
    `refusing to set ${key} in ${locale} to the English source value. ` +
    `Translate it, or pass --allow-english only for intentional keepers (brands, proper nouns).`
  )
}
