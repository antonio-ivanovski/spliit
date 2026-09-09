import { utcTodayIso } from '@spliit/domain'
import {
  getCurrency,
  intermediaryCurrenciesFor,
  isCryptoCurrency,
  supportedCurrencyCodes,
} from '@spliit/domain/currency'

import { mapWithConcurrency } from './concurrency'
import { fetchCoinbaseSpot, type CryptoFetchImpl } from './crypto-rates'
import {
  CurrencyRateNotFoundError,
  CurrencyRateProviderError,
  UnsupportedCurrencyError,
} from './currency-errors'
import { fetchFrankfurterRates, type FiatFetchImpl } from './fiat-rates'
import {
  clearRateCache,
  rateCacheKey,
  rateCacheSize,
  readRateCache,
  writeRateCache,
} from './rate-cache'

// Frankfurter historical rates are immutable for past dates, and the
// future-date fallback (provider's latest available rate) only changes
// on weekdays. 24h is plenty to dedupe repeated form interactions.
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
// Crypto spot prices for today's date move intraday; a short TTL keeps the
// rate fresh while past dates keep the standard 24h TTL.
const CRYPTO_TODAY_TTL_MS = 15 * 60 * 1000

/** Upstream FX provider that supplied a quote leg. */
export type CurrencyRateProviderId = 'frankfurter' | 'coinbase'

/** One provider quote that contributed to the resolved rate. */
export type CurrencyRateSource = {
  provider: CurrencyRateProviderId
  base: string
  target: string
}

export type CurrencyRate = {
  /** Rate of 1 unit of `base` expressed in `target`. */
  rate: number
  /** ISO date the user asked for (YYYY-MM-DD). */
  requestedDate: string
  /**
   * ISO date the provider actually returned (YYYY-MM-DD). Differs from
   * `requestedDate` for future dates, weekends, and provider outages.
   */
  asOfDate: string
  base: string
  target: string
  /**
   * Ordered quote legs that compose this rate. - Direct: one entry (provider
   * that quoted `base`→`target`). - Bridged: two+ entries (e.g. BTC→EUR via
   * Coinbase, EUR→MKD via Frankfurter); intermediate codes are also listed in
   * `via`. - Same-currency / pure alias scale: empty (no external quote).
   */
  sources: CurrencyRateSource[]
  /**
   * Bridge currencies used to compose the rate when no direct pair exists (e.g.
   * `['EUR']` for BTC→MKD via BTC→EUR + EUR→MKD).
   */
  via?: string[]
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Batch FX robustness: only transient failures are retried with exponential
 * backoff + jitter — transport failures without an HTTP status
 * (timeout/abort/network, wrapped as PROVIDER_ERROR with no `status`), HTTP
 * 429, and HTTP 5xx. Permanent HTTP 4xx (other than 429), validation failures
 * (unsupported currency, invalid date), and RATE_NOT_FOUND (valid response,
 * missing quote) are never retried.
 */
const FX_MAX_ATTEMPTS = 3
const FX_RETRY_BASE_MS = 250
const FX_RETRY_CAP_MS = 3000
const FX_FIAT_CONCURRENCY = 8
const FX_CRYPTO_CONCURRENCY = 8

function isNetworkLikeError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true
  if (err instanceof TypeError) return true
  return /timeout|abort|network|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|EPIPE|ETIMEDOUT/i.test(
    err.message,
  )
}

function isRetryableFxError(err: unknown): boolean {
  if (err instanceof UnsupportedCurrencyError) return false
  if (err instanceof CurrencyRateNotFoundError) return false
  if (err instanceof Error && /Invalid date/.test(err.message)) return false
  if (err instanceof CurrencyRateProviderError) {
    // Transport failures carry no HTTP status (fetch throw wrapped at the
    // construction site); HTTP failures carry `status` (see fiat/crypto
    // rates). Only 429 and 5xx are transient.
    if (err.status === undefined) return true
    return err.status === 429 || (err.status >= 500 && err.status <= 599)
  }
  return isNetworkLikeError(err)
}

function fxRetryDelayMs(attempt: number): number {
  const exponential = FX_RETRY_BASE_MS * 2 ** attempt
  const jitter = Math.floor(Math.random() * 100)
  return Math.min(exponential + jitter, FX_RETRY_CAP_MS)
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withFxRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt < FX_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (!isRetryableFxError(err) || attempt + 1 >= FX_MAX_ATTEMPTS) throw err
      await sleepMs(fxRetryDelayMs(attempt))
    }
  }
  throw lastError
}

// Re-exported for the file importer, which bounds its own document-promotion
// fan-out with the same semaphore. New code should import from
// `./concurrency` directly.
export { mapWithConcurrency } from './concurrency'

function assertSupported(code: string) {
  if (!(supportedCurrencyCodes as readonly string[]).includes(code)) {
    throw new UnsupportedCurrencyError(code)
  }
}

function ttlForPair(date: string, involvesCrypto: boolean) {
  if (!involvesCrypto) return DEFAULT_TTL_MS
  return date >= utcTodayIso() ? CRYPTO_TODAY_TTL_MS : DEFAULT_TTL_MS
}

function sameCurrencyRate(date: string, base: string, target: string) {
  return {
    rate: 1,
    requestedDate: date,
    asOfDate: date,
    base,
    target,
    sources: [],
  } satisfies CurrencyRate
}

/** Expand scale aliases (SAT→BTC) so providers never see alias codes. */
function expandAlias(code: string): { code: string; scale: number } {
  const currency = getCurrency(code)
  if (currency?.aliasOf && currency.aliasOf !== code) {
    return { code: currency.aliasOf, scale: currency.aliasScale ?? 1 }
  }
  return { code, scale: 1 }
}

type ResolveDeps = {
  date: string
  fiatFetch: FiatFetchImpl
  cryptoFetch: CryptoFetchImpl
  /** In-flight dedupe across a batch, keyed by `rateCacheKey`. */
  memo: Map<string, Promise<CurrencyRate | null>>
}

function makeRate(
  date: string,
  base: string,
  target: string,
  rate: number,
  asOfDate: string,
  options: {
    sources?: CurrencyRateSource[]
    via?: string[]
  } = {},
): CurrencyRate {
  return {
    rate,
    requestedDate: date,
    asOfDate,
    base,
    target,
    sources: options.sources ?? [],
    ...(options.via?.length ? { via: options.via } : {}),
  }
}

/** Fiat↔fiat via Frankfurter only. Crypto codes are never passed here. */
async function fetchFiatPair(
  ctx: ResolveDeps,
  base: string,
  target: string,
): Promise<CurrencyRate | null> {
  const key = rateCacheKey(base, target, ctx.date)
  const cached = readRateCache<CurrencyRate>(key)
  if (cached) return cached

  try {
    const payload = await withFxRetry(() =>
      ctx.fiatFetch(ctx.date, base, [target]),
    )
    const rate = payload.rates[target]
    if (typeof rate !== 'number') return null
    const result = makeRate(ctx.date, base, target, rate, payload.date, {
      sources: [{ provider: 'frankfurter', base, target }],
    })
    writeRateCache(key, result, DEFAULT_TTL_MS)
    return result
  } catch (err) {
    if (err instanceof CurrencyRateNotFoundError) return null
    throw err
  }
}

/**
 * Crypto-involving spot via Coinbase: try direct orientation, then reverse.
 * Returns null when Coinbase has no quote for the pair (caller may bridge).
 */
async function fetchCryptoPair(
  ctx: ResolveDeps,
  base: string,
  target: string,
): Promise<CurrencyRate | null> {
  if (base === target) return sameCurrencyRate(ctx.date, base, target)

  const key = rateCacheKey(base, target, ctx.date)
  const cached = readRateCache<CurrencyRate>(key)
  if (cached) return cached
  const inFlight = ctx.memo.get(key)
  if (inFlight) return inFlight

  const pending = (async (): Promise<CurrencyRate | null> => {
    const direct = await withFxRetry(() =>
      ctx.cryptoFetch(ctx.date, base, target),
    )
    if (direct !== null) {
      return makeRate(ctx.date, base, target, direct, ctx.date, {
        sources: [{ provider: 'coinbase', base, target }],
      })
    }
    const inverted = await withFxRetry(() =>
      ctx.cryptoFetch(ctx.date, target, base),
    )
    if (inverted !== null) {
      return makeRate(ctx.date, base, target, 1 / inverted, ctx.date, {
        // Inversion still uses the Coinbase quote for target→base.
        sources: [{ provider: 'coinbase', base, target }],
      })
    }
    return null
  })()

  ctx.memo.set(key, pending)
  const result = await pending
  if (result) {
    writeRateCache(key, result, ttlForPair(ctx.date, true))
  }
  return result
}

/**
 * One resolved leg after universe classification. Never calls the wrong
 * provider: fiat↔fiat → Frankfurter; any crypto side → Coinbase.
 */
async function fetchClassifiedPair(
  ctx: ResolveDeps,
  a: string,
  b: string,
): Promise<CurrencyRate | null> {
  if (a === b) return sameCurrencyRate(ctx.date, a, b)
  const aCrypto = isCryptoCurrency(a)
  const bCrypto = isCryptoCurrency(b)
  if (!aCrypto && !bCrypto) return fetchFiatPair(ctx, a, b)
  return fetchCryptoPair(ctx, a, b)
}

async function bridgeViaIntermediaries(
  ctx: ResolveDeps,
  base: string,
  target: string,
  list: readonly string[],
): Promise<CurrencyRate | null> {
  for (const intermediary of list) {
    if (intermediary === base || intermediary === target) continue
    const leg1 = await fetchClassifiedPair(ctx, base, intermediary)
    if (!leg1) continue
    const leg2 = await fetchClassifiedPair(ctx, intermediary, target)
    if (!leg2) continue
    return makeRate(ctx.date, base, target, leg1.rate * leg2.rate, ctx.date, {
      via: [intermediary],
      sources: [...leg1.sources, ...leg2.sources],
    })
  }
  return null
}

/**
 * Resolve 1 `base` in `target` on `date`.
 *
 * Routing uses `crypto` metadata from the catalog: - fiat↔fiat → Frankfurter -
 * crypto↔fiat / crypto↔crypto → Coinbase (direct, then reverse) - on Coinbase
 * miss → bridge via EUR then USD (crypto leg Coinbase, fiat leg Frankfurter)
 * Aliases expand before any provider call.
 */
async function resolveRate(
  ctx: ResolveDeps,
  base: string,
  target: string,
): Promise<CurrencyRate> {
  const key = rateCacheKey(base, target, ctx.date)
  const cached = readRateCache<CurrencyRate>(key)
  if (cached) return cached

  if (base === target) return sameCurrencyRate(ctx.date, base, target)

  const baseAlias = expandAlias(base)
  const targetAlias = expandAlias(target)
  const scaledBase = baseAlias.code
  const scaledTarget = targetAlias.code
  // rate(aliasBase→aliasTarget) = rate(parentBase→parentTarget) × baseScale / targetScale
  const aliasScale = baseAlias.scale / targetAlias.scale

  if (scaledBase === scaledTarget) {
    return makeRate(ctx.date, base, target, aliasScale, ctx.date)
  }

  const involvesCrypto =
    isCryptoCurrency(scaledBase) || isCryptoCurrency(scaledTarget)

  const direct = await fetchClassifiedPair(ctx, scaledBase, scaledTarget)
  if (direct) {
    const result = makeRate(
      ctx.date,
      base,
      target,
      direct.rate * aliasScale,
      direct.asOfDate,
      { sources: direct.sources, via: direct.via },
    )
    writeRateCache(key, result, ttlForPair(ctx.date, involvesCrypto))
    return result
  }

  // Coinbase miss (unknown fiat quote, missing crypto-crypto pair, …) → bridge.
  // Prefer the fiat side's intermediary order for crypto↔fiat; crypto↔crypto
  // uses the base's list (defaults to EUR, USD).
  const baseIsCrypto = isCryptoCurrency(scaledBase)
  const targetIsCrypto = isCryptoCurrency(scaledTarget)
  const list =
    baseIsCrypto && targetIsCrypto
      ? intermediaryCurrenciesFor(scaledBase)
      : intermediaryCurrenciesFor(baseIsCrypto ? scaledTarget : scaledBase)

  const bridged = await bridgeViaIntermediaries(
    ctx,
    scaledBase,
    scaledTarget,
    list,
  )
  if (bridged) {
    const result = makeRate(
      ctx.date,
      base,
      target,
      bridged.rate * aliasScale,
      bridged.asOfDate,
      { sources: bridged.sources, via: bridged.via },
    )
    writeRateCache(key, result, ttlForPair(ctx.date, involvesCrypto))
    return result
  }

  throw new CurrencyRateNotFoundError(target)
}

/**
 * Resolve the rate of 1 unit of `base` in `target` on `date`. Cached in-process
 * keyed by `(date, base, target)`. Future dates use the provider's latest
 * available rate (same contract as fiat); crypto pairs involving "today" use a
 * shorter TTL.
 */
export async function getCurrencyRate({
  date,
  base,
  target,
  ttlMs = DEFAULT_TTL_MS,
  fetchImpl = fetchFrankfurterRates,
  cryptoFetchImpl = fetchCoinbaseSpot,
}: {
  date: string
  base: string
  target: string
  ttlMs?: number
  fetchImpl?: FiatFetchImpl
  cryptoFetchImpl?: CryptoFetchImpl
}): Promise<CurrencyRate> {
  if (!ISO_DATE_RE.test(date)) {
    throw new CurrencyRateProviderError(`Invalid date: ${date}`)
  }
  assertSupported(base)
  assertSupported(target)

  const key = rateCacheKey(base, target, date)
  const cached = readRateCache<CurrencyRate>(key)
  if (cached) return cached

  if (isCryptoCurrency(base) || isCryptoCurrency(target)) {
    return resolveRate(
      {
        date,
        fiatFetch: fetchImpl,
        cryptoFetch: cryptoFetchImpl,
        memo: new Map(),
      },
      base,
      target,
    )
  }

  // Pure fiat: single Frankfurter call (preserves prior asOfDate / ttlMs behaviour).
  const payload = await withFxRetry(() => fetchImpl(date, base, [target]))
  const rate = payload.rates[target]
  if (typeof rate !== 'number') {
    throw new CurrencyRateNotFoundError(target)
  }
  const result = makeRate(date, base, target, rate, payload.date, {
    sources: [{ provider: 'frankfurter', base, target }],
  })
  writeRateCache(key, result, ttlMs)
  return result
}

/** Test/utility export. Drops all cached entries. */
export function clearCurrencyRateCache() {
  clearRateCache()
}

/** Test/utility export. Entry count after TTL eviction. */
export function currencyRateCacheSize() {
  return rateCacheSize()
}

export type BatchRateRequest = {
  date: string
  base: string
  target: string
}

/**
 * Discriminated union describing a single rate lookup outcome. Per-item
 * failures are returned alongside successes so the caller can block or surface
 * a specific message per offending expense instead of failing the whole batch.
 */
export type BatchRateResult =
  | { ok: true; rate: CurrencyRate }
  | {
      ok: false
      error:
        | { code: 'UNSUPPORTED_CURRENCY'; currency: string }
        | { code: 'RATE_NOT_FOUND'; target: string }
        | { code: 'INVALID_DATE'; date: string }
        | { code: 'PROVIDER_ERROR'; message: string }
    }

/**
 * Resolve multiple rates in parallel. Fiat-only requests are grouped by (date,
 * base) for one Frankfurter multi-quote call. Crypto-involving requests resolve
 * individually with shared in-flight sub-legs so repeated intermediaries
 * (BTC→EUR for BTC→MKD and BTC→BGN) cost a single provider call.
 */
export async function getCurrencyRates(
  requests: BatchRateRequest[],
  options: {
    fetchImpl?: FiatFetchImpl
    cryptoFetchImpl?: CryptoFetchImpl
  } = {},
): Promise<BatchRateResult[]> {
  const fetchImpl = options.fetchImpl ?? fetchFrankfurterRates
  const cryptoFetchImpl = options.cryptoFetchImpl ?? fetchCoinbaseSpot

  const output: BatchRateResult[] = Array.from({ length: requests.length })
  type Key = string
  const groupKey = (date: string, base: string): Key =>
    `${date}|${base.toUpperCase()}`
  const groups = new Map<
    Key,
    {
      date: string
      base: string
      targets: string[]
      indicesByTarget: Map<string, number[]>
    }
  >()
  const cryptoGroups = new Map<
    Key,
    { date: string; base: string; target: string; indices: number[] }
  >()
  let allCached = true
  requests.forEach((req, idx) => {
    const base = req.base.toUpperCase()
    const target = req.target.toUpperCase()
    const cached = readRateCache<CurrencyRate>(
      rateCacheKey(base, target, req.date),
    )
    if (cached) {
      output[idx] = { ok: true, rate: cached }
      return
    }
    allCached = false
    if (isCryptoCurrency(base) || isCryptoCurrency(target)) {
      const key = rateCacheKey(base, target, req.date)
      const existing = cryptoGroups.get(key)
      if (existing) {
        existing.indices.push(idx)
      } else {
        cryptoGroups.set(key, { date: req.date, base, target, indices: [idx] })
      }
      return
    }
    const key = groupKey(req.date, base)
    const existing = groups.get(key)
    if (existing) {
      if (!existing.indicesByTarget.has(target)) {
        existing.targets.push(target)
        existing.indicesByTarget.set(target, [])
      }
      existing.indicesByTarget.get(target)!.push(idx)
    } else {
      const indicesByTarget = new Map<string, number[]>()
      indicesByTarget.set(target, [idx])
      groups.set(key, {
        date: req.date,
        base,
        targets: [target],
        indicesByTarget,
      })
    }
  })

  if (allCached) return output

  type ResolvedGroup = {
    byTarget: Map<string, BatchRateResult>
  }
  const resolvedByKey = new Map<Key, ResolvedGroup>()

  // Fiat groups run with a bounded concurrency cap so a 276-row import with
  // many distinct (date, base) pairs cannot open hundreds of simultaneous
  // upstream connections. Cache hits were already partitioned out above and
  // stay unthrottled.
  const fiatGroupsPromise = mapWithConcurrency(
    Array.from(groups.entries()),
    FX_FIAT_CONCURRENCY,
    async ([key, group]) => {
      const byTarget = new Map<string, BatchRateResult>()
      try {
        assertSupported(group.base)
        if (!ISO_DATE_RE.test(group.date)) {
          throw new CurrencyRateProviderError(`Invalid date: ${group.date}`)
        }

        const payload = await withFxRetry(() =>
          fetchImpl(group.date, group.base, group.targets),
        )
        for (const target of group.targets) {
          const rate = payload.rates[target]
          if (typeof rate !== 'number') {
            byTarget.set(target, {
              ok: false,
              error: { code: 'RATE_NOT_FOUND', target },
            })
            continue
          }
          const result = makeRate(
            group.date,
            group.base,
            target,
            rate,
            payload.date,
            {
              sources: [
                {
                  provider: 'frankfurter',
                  base: group.base,
                  target,
                },
              ],
            },
          )
          writeRateCache(
            rateCacheKey(group.base, target, group.date),
            result,
            DEFAULT_TTL_MS,
          )
          byTarget.set(target, { ok: true, rate: result })
        }
      } catch (err) {
        for (const target of group.targets) {
          byTarget.set(target, {
            ok: false,
            error: classifyBatchError(err, group.date, target),
          })
        }
      }
      resolvedByKey.set(key, { byTarget })
    },
  )

  const cryptoCtx: ResolveDeps = {
    date: '',
    fiatFetch: fetchImpl,
    cryptoFetch: cryptoFetchImpl,
    memo: new Map(),
  }
  // Crypto groups fan out over distinct pairs just like fiat groups; bound
  // them with the same limiter so a many-pair batch cannot open unbounded
  // simultaneous upstream connections.
  const cryptoResultsPromise = mapWithConcurrency(
    Array.from(cryptoGroups.values()),
    FX_CRYPTO_CONCURRENCY,
    async ({ date, base, target, indices }) => {
      try {
        assertSupported(base)
        assertSupported(target)
        if (!ISO_DATE_RE.test(date)) {
          throw new CurrencyRateProviderError(`Invalid date: ${date}`)
        }
        const ctx: ResolveDeps = { ...cryptoCtx, date }
        return {
          ok: true as const,
          indices,
          rate: await resolveRate(ctx, base, target),
        }
      } catch (err) {
        return {
          ok: false as const,
          indices,
          error: classifyBatchError(err, date, target),
        }
      }
    },
  )

  await Promise.all([fiatGroupsPromise, cryptoResultsPromise])
  const cryptoResults = await cryptoResultsPromise
  for (const result of cryptoResults) {
    const entry: BatchRateResult = result.ok
      ? { ok: true, rate: result.rate }
      : { ok: false, error: result.error }
    for (const idx of result.indices) {
      output[idx] = entry
    }
  }

  for (const [key, group] of groups) {
    const { byTarget } = resolvedByKey.get(key)!
    for (const target of group.targets) {
      const result = byTarget.get(target)!
      for (const idx of group.indicesByTarget.get(target)!) {
        output[idx] = result
      }
    }
  }
  return output
}

function classifyBatchError(
  err: unknown,
  date: string,
  _target: string,
): Extract<BatchRateResult, { ok: false }>['error'] {
  if (err instanceof UnsupportedCurrencyError) {
    return { code: 'UNSUPPORTED_CURRENCY', currency: err.code }
  }
  if (err instanceof CurrencyRateNotFoundError) {
    return { code: 'RATE_NOT_FOUND', target: err.target }
  }
  if (err instanceof CurrencyRateProviderError) {
    return { code: 'PROVIDER_ERROR', message: err.message }
  }
  if (err instanceof Error && /Invalid date/.test(err.message)) {
    return { code: 'INVALID_DATE', date }
  }
  return {
    code: 'PROVIDER_ERROR',
    message: err instanceof Error ? err.message : String(err),
  }
}
