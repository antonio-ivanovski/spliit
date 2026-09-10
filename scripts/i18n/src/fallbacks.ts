import {
  fallbackChain,
  isSparseLocale,
  type Locale,
} from '../../../packages/domain/src/i18n'
import { readMessagesFile } from './fs-helpers'
import { flattenKeys, getAt } from './object-path'

export { fallbackChain, isSparseLocale }
export type { Locale }

/** Message data for a locale plus every fallback ancestor, nearest first. */
export type ChainData = Array<{
  locale: Locale
  data: Record<string, unknown>
}>

export async function readChainDatas(locale: Locale): Promise<ChainData> {
  const chain = [locale, ...fallbackChain(locale)]
  const datas = await Promise.all(chain.map((lng) => readMessagesFile(lng)))
  return chain.map((lng, index) => ({ locale: lng, data: datas[index] }))
}

/** Keys present in the locale itself. */
export function ownKeys(chain: ChainData): Set<string> {
  return new Set(flattenKeys(chain[0].data))
}

/** Keys present in the locale or any fallback ancestor. */
export function coveredKeys(chain: ChainData): Set<string> {
  const covered = new Set<string>()
  for (const { data } of chain) {
    for (const key of flattenKeys(data)) covered.add(key)
  }
  return covered
}

/**
 * Nearest fallback ancestor holding a string value for `key` (null when no
 * ancestor defines it — the key is truly untranslated).
 */
export function findFallbackSource(
  chain: ChainData,
  key: string,
): { locale: Locale; value: string } | null {
  for (const { locale, data } of chain.slice(1)) {
    const value = getAt(data, key)
    if (typeof value === 'string') return { locale, value }
  }
  return null
}

/**
 * Non-en-US fallback ancestors — the parent bundles a sparse locale inherits
 * from (e.g. `['pt']` for pt-BR, `[]` for en-GB). Useful as default translator
 * refs; en-US is already shown as `en` in packs.
 */
export function parentRefLocales(locale: Locale): Locale[] {
  return fallbackChain(locale).filter((lng) => lng !== 'en-US')
}
