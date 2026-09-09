import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockFn } from 'vitest-mock-extended'

import {
  CurrencyRateNotFoundError,
  CurrencyRateProviderError,
  UnsupportedCurrencyError,
} from '../currency-errors'
import {
  clearCurrencyRateCache,
  currencyRateCacheSize,
  getCurrencyRate,
  getCurrencyRates,
} from '../currency-rates'
import type { FrankfurterResponse } from '../fiat-rates'

type FetchRatesFn = (
  date: string,
  base: string,
  quotes?: string[],
) => Promise<FrankfurterResponse>

function makePayload(
  overrides?: Partial<{
    base: string
    date: string
    rates: Record<string, number>
  }>,
) {
  return {
    base: 'EUR',
    date: '2026-06-28',
    rates: { USD: 1.1401, GBP: 0.86253 },
    ...overrides,
  }
}

describe('getCurrencyRate', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    clearCurrencyRateCache()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    clearCurrencyRateCache()
  })

  it('requests only the target quote from Frankfurter', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [
        { date: '2026-06-28', base: 'EUR', quote: 'USD', rate: 1.1401 },
      ],
    }))
    globalThis.fetch = fetchMock as never

    const result = await getCurrencyRate({
      date: '2026-06-28',
      base: 'EUR',
      target: 'USD',
    })

    expect(result.rate).toBe(1.1401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = new URL(fetchMock.mock.calls[0][0] as string)
    expect(url.pathname).toBe('/v2/rates')
    expect(url.searchParams.get('date')).toBe('2026-06-28')
    expect(url.searchParams.get('base')).toBe('EUR')
    expect(url.searchParams.get('quotes')).toBe('USD')
  })

  it('fetches from the provider on cache miss and returns the rate', async () => {
    const fetchImpl = mockFn<FetchRatesFn>().mockResolvedValue(makePayload())

    const result = await getCurrencyRate({
      date: '2026-06-28',
      base: 'EUR',
      target: 'USD',
      fetchImpl,
    })

    expect(result).toEqual({
      rate: 1.1401,
      requestedDate: '2026-06-28',
      asOfDate: '2026-06-28',
      base: 'EUR',
      target: 'USD',
      sources: [{ provider: 'frankfurter', base: 'EUR', target: 'USD' }],
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith('2026-06-28', 'EUR', ['USD'])
  })

  it('returns the cached entry on a second call without hitting the provider', async () => {
    const fetchImpl = mockFn<FetchRatesFn>().mockResolvedValue(makePayload())

    const first = await getCurrencyRate({
      date: '2026-06-28',
      base: 'EUR',
      target: 'USD',
      fetchImpl,
    })
    const second = await getCurrencyRate({
      date: '2026-06-28',
      base: 'EUR',
      target: 'USD',
      fetchImpl,
    })

    expect(first).toEqual(second)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(currencyRateCacheSize()).toBe(1)
  })

  it('falls back to the provider latest-available rate for future dates and records the as-of date', async () => {
    const fetchImpl = mockFn<FetchRatesFn>().mockResolvedValue(
      makePayload({ date: '2026-06-26' }),
    )

    const result = await getCurrencyRate({
      date: '2026-12-31',
      base: 'EUR',
      target: 'USD',
      fetchImpl,
    })

    expect(result.rate).toBe(1.1401)
    expect(result.requestedDate).toBe('2026-12-31')
    expect(result.asOfDate).toBe('2026-06-26')
  })

  it('throws UnsupportedCurrencyError for an unsupported base', async () => {
    const fetchImpl = mockFn<FetchRatesFn>()

    await expect(
      getCurrencyRate({
        date: '2026-06-28',
        base: 'ZZZ',
        target: 'USD',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(UnsupportedCurrencyError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws UnsupportedCurrencyError for an unsupported target', async () => {
    const fetchImpl = mockFn<FetchRatesFn>()

    await expect(
      getCurrencyRate({
        date: '2026-06-28',
        base: 'EUR',
        target: 'ZZZ',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(UnsupportedCurrencyError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws CurrencyRateNotFoundError when the target is missing from the response', async () => {
    const fetchImpl = mockFn<FetchRatesFn>().mockResolvedValue(
      makePayload({ rates: { GBP: 0.86253 } }),
    )

    await expect(
      getCurrencyRate({
        date: '2026-06-28',
        base: 'EUR',
        target: 'USD',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(CurrencyRateNotFoundError)
  })

  it('throws CurrencyRateProviderError on an invalid date string', async () => {
    const fetchImpl = mockFn<FetchRatesFn>()

    await expect(
      getCurrencyRate({
        date: 'not-a-date',
        base: 'EUR',
        target: 'USD',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(CurrencyRateProviderError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('caches different (base, target, date) triples independently', async () => {
    const fetchImpl = mockFn<FetchRatesFn>().mockResolvedValue(makePayload())

    await getCurrencyRate({
      date: '2026-06-28',
      base: 'EUR',
      target: 'USD',
      fetchImpl,
    })
    await getCurrencyRate({
      date: '2026-06-28',
      base: 'EUR',
      target: 'GBP',
      fetchImpl,
    })
    await getCurrencyRate({
      date: '2026-06-29',
      base: 'EUR',
      target: 'USD',
      fetchImpl,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(currencyRateCacheSize()).toBe(3)
  })
})

describe('getCurrencyRates', () => {
  beforeEach(() => {
    clearCurrencyRateCache()
  })

  afterEach(() => {
    clearCurrencyRateCache()
  })

  it('resolves each item in the input order, even when some fail', async () => {
    const fetchImpl = mockFn<FetchRatesFn>().mockImplementation(
      async (date: string, base: string) =>
        makePayload({ base, date, rates: { USD: 1.1, GBP: 0.85 } }),
    )

    const results = await getCurrencyRates(
      [
        { date: '2026-06-28', base: 'EUR', target: 'USD' },
        { date: '2026-06-28', base: 'ZZZ', target: 'USD' },
        { date: '2026-06-28', base: 'EUR', target: 'GBP' },
      ],
      { fetchImpl },
    )

    expect(results).toHaveLength(3)
    expect(results[0]).toMatchObject({ ok: true, rate: { rate: 1.1 } })
    expect(results[1]).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_CURRENCY', currency: 'ZZZ' },
    })
    expect(results[2]).toMatchObject({ ok: true, rate: { rate: 0.85 } })
  })

  it('surfaces a RATE_NOT_FOUND error when the provider omits the target', async () => {
    const fetchImpl = mockFn<FetchRatesFn>().mockResolvedValue(
      makePayload({ rates: { GBP: 0.85 } }),
    )

    const results = await getCurrencyRates(
      [{ date: '2026-06-28', base: 'EUR', target: 'USD' }],
      { fetchImpl },
    )

    expect(results[0]).toMatchObject({
      ok: false,
      error: { code: 'RATE_NOT_FOUND', target: 'USD' },
    })
  })

  it('shares the underlying fetch across targets on the same (date, base) pair', async () => {
    const fetchImpl = mockFn<FetchRatesFn>().mockResolvedValue(
      makePayload({ rates: { USD: 1.1, GBP: 0.85 } }),
    )

    await getCurrencyRates(
      [
        { date: '2026-06-28', base: 'EUR', target: 'USD' },
        { date: '2026-06-28', base: 'EUR', target: 'GBP' },
      ],
      { fetchImpl },
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith('2026-06-28', 'EUR', ['USD', 'GBP'])
    expect(currencyRateCacheSize()).toBe(2)
  })

  it('does not call the provider when every request is already cached', async () => {
    const fetchImpl = mockFn<FetchRatesFn>().mockResolvedValue(
      makePayload({ rates: { USD: 1.1, GBP: 0.85 } }),
    )
    // Warm the cache so the next batch sees everything as a hit.
    await getCurrencyRates(
      [
        { date: '2026-06-28', base: 'EUR', target: 'USD' },
        { date: '2026-06-28', base: 'EUR', target: 'GBP' },
      ],
      { fetchImpl },
    )
    fetchImpl.mockClear()

    const results = await getCurrencyRates(
      [
        { date: '2026-06-28', base: 'EUR', target: 'USD' },
        { date: '2026-06-28', base: 'EUR', target: 'GBP' },
      ],
      { fetchImpl },
    )

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(results[0]).toMatchObject({ ok: true, rate: { target: 'USD' } })
    expect(results[1]).toMatchObject({ ok: true, rate: { target: 'GBP' } })
  })

  it('reuses rates warmed by getCurrencyRate without a second provider call', async () => {
    const fetchImpl = mockFn<FetchRatesFn>().mockResolvedValue(
      makePayload({ rates: { USD: 1.1 } }),
    )

    await getCurrencyRate({
      date: '2026-06-28',
      base: 'EUR',
      target: 'USD',
      fetchImpl,
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    const results = await getCurrencyRates(
      [{ date: '2026-06-28', base: 'EUR', target: 'USD' }],
      { fetchImpl },
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(results[0]).toMatchObject({
      ok: true,
      rate: { rate: 1.1, base: 'EUR', target: 'USD' },
    })
  })

  it('partitions cached and uncached requests: cache hits skip the network', async () => {
    const fetchImpl = mockFn<FetchRatesFn>().mockResolvedValue(
      makePayload({ rates: { USD: 1.1, GBP: 0.85 } }),
    )
    // Warm the EUR→USD pair.
    await getCurrencyRate({
      date: '2026-06-28',
      base: 'EUR',
      target: 'USD',
      fetchImpl,
    })
    fetchImpl.mockClear()

    const results = await getCurrencyRates(
      [
        { date: '2026-06-28', base: 'EUR', target: 'USD' },
        { date: '2026-06-28', base: 'EUR', target: 'GBP' },
      ],
      { fetchImpl },
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledWith('2026-06-28', 'EUR', ['GBP'])
    expect(results[0]).toMatchObject({ ok: true, rate: { target: 'USD' } })
    expect(results[1]).toMatchObject({ ok: true, rate: { target: 'GBP' } })
  })

  it('does not propagate provider failures when every request is cached', async () => {
    const fetchImpl = mockFn<FetchRatesFn>().mockResolvedValue(
      makePayload({ rates: { USD: 1.1 } }),
    )
    await getCurrencyRates(
      [{ date: '2026-06-28', base: 'EUR', target: 'USD' }],
      { fetchImpl },
    )

    const failingFetch = mockFn<FetchRatesFn>().mockRejectedValue(
      new Error('provider down'),
    )

    const results = await getCurrencyRates(
      [{ date: '2026-06-28', base: 'EUR', target: 'USD' }],
      { fetchImpl: failingFetch },
    )

    expect(failingFetch).not.toHaveBeenCalled()
    expect(results[0]).toMatchObject({
      ok: true,
      rate: { rate: 1.1, target: 'USD' },
    })
  })
})

type CryptoFetchFn = (
  date: string,
  base: string,
  target: string,
) => Promise<number | null>

describe('crypto rate resolution', () => {
  beforeEach(() => {
    clearCurrencyRateCache()
  })

  afterEach(() => {
    clearCurrencyRateCache()
  })

  it('resolves a direct crypto pair through the crypto provider', async () => {
    const cryptoFetchImpl = vi
      .fn<CryptoFetchFn>()
      .mockImplementation(async () => 64_000)

    const result = await getCurrencyRate({
      date: '2026-06-28',
      base: 'BTC',
      target: 'USD',
      cryptoFetchImpl,
    })

    expect(result.rate).toBe(64_000)
    expect(result.via).toBeUndefined()
    expect(result.sources).toEqual([
      { provider: 'coinbase', base: 'BTC', target: 'USD' },
    ])
    expect(result.asOfDate).toBe('2026-06-28')
    expect(cryptoFetchImpl).toHaveBeenCalledTimes(1)
    expect(cryptoFetchImpl).toHaveBeenCalledWith('2026-06-28', 'BTC', 'USD')
  })

  it('falls back to the inverted pair and inverts the rate', async () => {
    const cryptoFetchImpl = vi
      .fn<CryptoFetchFn>()
      .mockImplementation(async (_date, base, target) =>
        base === 'BTC' && target === 'USD' ? 64_000 : null,
      )

    const result = await getCurrencyRate({
      date: '2026-06-28',
      base: 'USD',
      target: 'BTC',
      cryptoFetchImpl,
    })

    expect(result.rate).toBeCloseTo(1 / 64_000, 12)
  })

  it('composes a rate through the fiat side intermediary list', async () => {
    const cryptoFetchImpl = vi
      .fn<CryptoFetchFn>()
      .mockImplementation(async (_date, base, target) => {
        if (base === 'DOGE' && target === 'EUR') return 0.11
        if (base === 'DOGE' && target === 'USD') return 0.12
        return null
      })
    const fetchImpl = mockFn<FetchRatesFn>().mockImplementation(
      async (_date, base, quotes) => ({
        base,
        date: '2026-06-28',
        rates: Object.fromEntries(quotes!.map((q) => [q, 61.5])),
      }),
    )

    const result = await getCurrencyRate({
      date: '2026-06-28',
      base: 'DOGE',
      target: 'MKD',
      cryptoFetchImpl,
      fetchImpl,
    })

    // MKD's list is ['EUR', 'USD']: DOGE→EUR (crypto) × EUR→MKD (fiat).
    // Crypto provider attempts: direct DOGE→MKD, inverted MKD→DOGE, leg
    // DOGE→EUR.
    expect(result.via).toEqual(['EUR'])
    expect(result.rate).toBeCloseTo(0.11 * 61.5, 10)
    expect(result.sources).toEqual([
      { provider: 'coinbase', base: 'DOGE', target: 'EUR' },
      { provider: 'frankfurter', base: 'EUR', target: 'MKD' },
    ])
    expect(cryptoFetchImpl).toHaveBeenCalledTimes(3)
    expect(cryptoFetchImpl).toHaveBeenCalledWith('2026-06-28', 'DOGE', 'EUR')
    expect(fetchImpl).toHaveBeenCalledWith('2026-06-28', 'EUR', ['MKD'])
  })

  it('bridges crypto↔crypto through an intermediary when no direct pair exists', async () => {
    const cryptoFetchImpl = vi
      .fn<CryptoFetchFn>()
      .mockImplementation(async (_date, base, target) => {
        if (base === 'BTC' && target === 'EUR') return 55_000
        if (base === 'ETH' && target === 'EUR') return 2_500
        return null
      })

    const result = await getCurrencyRate({
      date: '2026-06-28',
      base: 'BTC',
      target: 'ETH',
      cryptoFetchImpl,
    })

    expect(result.via).toEqual(['EUR'])
    expect(result.rate).toBeCloseTo(55_000 / 2_500, 10)
    expect(result.sources).toEqual([
      { provider: 'coinbase', base: 'BTC', target: 'EUR' },
      { provider: 'coinbase', base: 'EUR', target: 'ETH' },
    ])
  })

  it('scales alias currencies through their parent code', async () => {
    const cryptoFetchImpl = vi
      .fn<CryptoFetchFn>()
      .mockImplementation(async (_date, base, target) =>
        base === 'BTC' && target === 'USD' ? 64_000 : null,
      )

    const result = await getCurrencyRate({
      date: '2026-06-28',
      base: 'SAT',
      target: 'USD',
      cryptoFetchImpl,
    })

    expect(result.rate).toBe(64_000 * 0.00000001)
    expect(cryptoFetchImpl).toHaveBeenCalledWith('2026-06-28', 'BTC', 'USD')
  })

  it('scales alias targets through their parent code', async () => {
    const cryptoFetchImpl = vi
      .fn<CryptoFetchFn>()
      .mockImplementation(async (_date, base, target) =>
        base === 'BTC' && target === 'USD' ? 64_000 : null,
      )

    const result = await getCurrencyRate({
      date: '2026-06-28',
      base: 'USD',
      target: 'SAT',
      cryptoFetchImpl,
    })

    // rate(USD→SAT) = rate(USD→BTC) ÷ 1e-8 = 1/64000 × 1e8 = 1562.5 sats.
    expect(result.rate).toBeCloseTo(1562.5, 10)
  })

  it('returns rate 1 for a same-currency crypto pair without calling providers', async () => {
    const cryptoFetchImpl = vi.fn<CryptoFetchFn>()
    const fetchImpl = mockFn<FetchRatesFn>()

    const result = await getCurrencyRate({
      date: '2026-06-28',
      base: 'BTC',
      target: 'BTC',
      cryptoFetchImpl,
      fetchImpl,
    })

    expect(result.rate).toBe(1)
    expect(cryptoFetchImpl).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('throws CurrencyRateNotFoundError when no direct or intermediary rate exists', async () => {
    const cryptoFetchImpl = vi.fn<CryptoFetchFn>().mockResolvedValue(null)
    const fetchImpl = mockFn<FetchRatesFn>().mockResolvedValue(
      makePayload({ rates: {} }),
    )

    await expect(
      getCurrencyRate({
        date: '2026-06-28',
        base: 'BTC',
        target: 'MKD',
        cryptoFetchImpl,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(CurrencyRateNotFoundError)
  })

  it('caches crypto rates across calls', async () => {
    const cryptoFetchImpl = vi
      .fn<CryptoFetchFn>()
      .mockImplementation(async () => 64_000)

    await getCurrencyRate({
      date: '2026-06-28',
      base: 'BTC',
      target: 'USD',
      cryptoFetchImpl,
    })
    await getCurrencyRate({
      date: '2026-06-28',
      base: 'BTC',
      target: 'USD',
      cryptoFetchImpl,
    })

    expect(cryptoFetchImpl).toHaveBeenCalledTimes(1)
  })

  it('batches crypto and fiat requests, sharing repeated intermediary legs', async () => {
    const cryptoFetchImpl = vi
      .fn<CryptoFetchFn>()
      .mockImplementation(async (_date, base, target) => {
        if (base === 'BTC' && target === 'USD') return 64_000
        if (base === 'BTC' && target === 'EUR') return 55_000
        return null
      })
    const fetchImpl = mockFn<FetchRatesFn>().mockImplementation(
      async (_date, base, quotes) => ({
        base,
        date: '2026-06-28',
        rates: Object.fromEntries(quotes!.map((q) => [q, 61.5])),
      }),
    )

    const results = await getCurrencyRates(
      [
        { date: '2026-06-28', base: 'BTC', target: 'USD' },
        { date: '2026-06-28', base: 'BTC', target: 'EUR' },
        { date: '2026-06-28', base: 'BTC', target: 'MKD' },
        { date: '2026-06-28', base: 'EUR', target: 'GBP' },
      ],
      { cryptoFetchImpl, fetchImpl },
    )

    expect(results[0]).toMatchObject({ ok: true, rate: { rate: 64_000 } })
    expect(results[1]).toMatchObject({ ok: true, rate: { rate: 55_000 } })
    expect(results[2]).toMatchObject({
      ok: true,
      rate: { rate: 55_000 * 61.5, via: ['EUR'] },
    })
    expect(results[3]).toMatchObject({ ok: true, rate: { target: 'GBP' } })

    // Crypto provider attempts: BTC→USD, BTC→EUR direct (requests 1-2);
    // BTC→MKD direct + inverted MKD→BTC (request 3); the BTC→EUR
    // intermediary leg is deduped against request 2's in-flight call.
    expect(cryptoFetchImpl).toHaveBeenCalledTimes(4)
    expect(cryptoFetchImpl).toHaveBeenCalledWith('2026-06-28', 'BTC', 'USD')
    expect(cryptoFetchImpl).toHaveBeenCalledWith('2026-06-28', 'BTC', 'EUR')
    expect(cryptoFetchImpl).toHaveBeenCalledWith('2026-06-28', 'BTC', 'MKD')
    expect(cryptoFetchImpl).toHaveBeenCalledWith('2026-06-28', 'MKD', 'BTC')
  })

  it('classifies crypto pair failures per item', async () => {
    const cryptoFetchImpl = vi.fn<CryptoFetchFn>().mockResolvedValue(null)
    const fetchImpl = mockFn<FetchRatesFn>().mockResolvedValue(
      makePayload({ rates: {} }),
    )

    const results = await getCurrencyRates(
      [
        { date: '2026-06-28', base: 'BTC', target: 'USD' },
        { date: '2026-06-28', base: 'BTC', target: 'MKD' },
      ],
      { cryptoFetchImpl, fetchImpl },
    )

    expect(results[0]).toMatchObject({
      ok: false,
      error: { code: 'RATE_NOT_FOUND', target: 'USD' },
    })
    expect(results[1]).toMatchObject({
      ok: false,
      error: { code: 'RATE_NOT_FOUND', target: 'MKD' },
    })
  })

  it('retries transient fiat failures with backoff and then succeeds', async () => {
    const fetchImpl = mockFn<FetchRatesFn>()
      .mockRejectedValueOnce(
        new CurrencyRateProviderError('Currency rate provider request failed'),
      )
      .mockRejectedValueOnce(
        new CurrencyRateProviderError('Currency rate provider request failed'),
      )
      .mockResolvedValue(makePayload({ rates: { USD: 1.1 } }))

    const results = await getCurrencyRates(
      [{ date: '2026-06-28', base: 'EUR', target: 'USD' }],
      { fetchImpl },
    )

    expect(results[0]).toMatchObject({ ok: true, rate: { rate: 1.1 } })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('does not retry RATE_NOT_FOUND (valid response, missing quote)', async () => {
    const fetchImpl = mockFn<FetchRatesFn>().mockResolvedValue(
      makePayload({ rates: { GBP: 0.85 } }),
    )

    const results = await getCurrencyRates(
      [{ date: '2026-06-28', base: 'EUR', target: 'USD' }],
      { fetchImpl },
    )

    expect(results[0]).toMatchObject({
      ok: false,
      error: { code: 'RATE_NOT_FOUND', target: 'USD' },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not retry validation errors (unsupported currency)', async () => {
    const fetchImpl = mockFn<FetchRatesFn>()

    const results = await getCurrencyRates(
      [{ date: '2026-06-28', base: 'ZZZ', target: 'USD' }],
      { fetchImpl },
    )

    expect(results[0]).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_CURRENCY' },
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('retries HTTP 500 then succeeds', async () => {
    const fetchImpl = mockFn<FetchRatesFn>()
      .mockRejectedValueOnce(
        new CurrencyRateProviderError(
          'Currency rate provider returned 500',
          undefined,
          500,
        ),
      )
      .mockResolvedValue(makePayload({ rates: { USD: 1.1 } }))

    const results = await getCurrencyRates(
      [{ date: '2026-06-28', base: 'EUR', target: 'USD' }],
      { fetchImpl },
    )

    expect(results[0]).toMatchObject({ ok: true, rate: { rate: 1.1 } })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('retries HTTP 429 then succeeds', async () => {
    const fetchImpl = mockFn<FetchRatesFn>()
      .mockRejectedValueOnce(
        new CurrencyRateProviderError(
          'Currency rate provider returned 429',
          undefined,
          429,
        ),
      )
      .mockResolvedValue(makePayload({ rates: { USD: 1.1 } }))

    const results = await getCurrencyRates(
      [{ date: '2026-06-28', base: 'EUR', target: 'USD' }],
      { fetchImpl },
    )

    expect(results[0]).toMatchObject({ ok: true, rate: { rate: 1.1 } })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('retries timeout/abort transport failures then succeeds', async () => {
    const abort = new DOMException('The operation was aborted', 'AbortError')
    const fetchImpl = mockFn<FetchRatesFn>()
      .mockRejectedValueOnce(
        new CurrencyRateProviderError(
          'Currency rate provider request failed',
          abort,
        ),
      )
      .mockResolvedValue(makePayload({ rates: { USD: 1.1 } }))

    const results = await getCurrencyRates(
      [{ date: '2026-06-28', base: 'EUR', target: 'USD' }],
      { fetchImpl },
    )

    expect(results[0]).toMatchObject({ ok: true, rate: { rate: 1.1 } })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry permanent HTTP 400', async () => {
    const fetchImpl = mockFn<FetchRatesFn>().mockRejectedValue(
      new CurrencyRateProviderError(
        'Currency rate provider returned 400',
        undefined,
        400,
      ),
    )

    const results = await getCurrencyRates(
      [{ date: '2026-06-28', base: 'EUR', target: 'USD' }],
      { fetchImpl },
    )

    expect(results[0]).toMatchObject({
      ok: false,
      error: { code: 'PROVIDER_ERROR' },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('does not retry permanent HTTP 404', async () => {
    const fetchImpl = mockFn<FetchRatesFn>().mockRejectedValue(
      new CurrencyRateProviderError(
        'Currency rate provider returned 404',
        undefined,
        404,
      ),
    )

    const results = await getCurrencyRates(
      [{ date: '2026-06-28', base: 'EUR', target: 'USD' }],
      { fetchImpl },
    )

    expect(results[0]).toMatchObject({
      ok: false,
      error: { code: 'PROVIDER_ERROR' },
    })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('resolves many fiat groups correctly under a counting mock', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const fetchImpl = mockFn<FetchRatesFn>().mockImplementation(
      async (date: string, base: string, quotes?: string[]) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        try {
          await new Promise((resolve) => setTimeout(resolve, 10))
          return {
            base,
            date,
            rates: Object.fromEntries((quotes ?? []).map((q) => [q, 1.5])),
          }
        } finally {
          inFlight -= 1
        }
      },
    )

    const requests = Array.from({ length: 20 }, (_, index) => ({
      date: `2026-06-${String((index % 28) + 1).padStart(2, '0')}`,
      base: 'EUR',
      target: 'USD',
    }))

    const results = await getCurrencyRates(requests, { fetchImpl })

    for (const result of results) {
      expect(result).toMatchObject({ ok: true, rate: { rate: 1.5 } })
    }
    // Concurrency is hard to assert strictly without flaky timing; at least
    // verify correctness and that the cap was respected.
    expect(maxInFlight).toBeLessThanOrEqual(8)
  })
})
