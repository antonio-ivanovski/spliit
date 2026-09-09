import {
  CurrencyRateProviderError,
  FX_REQUEST_TIMEOUT_MS,
} from './currency-errors'

const FRANKFURTER_BASE_URL = 'https://api.frankfurter.dev/v2'

export type FrankfurterResponse = {
  base: string
  date: string
  rates: Record<string, number>
}

// v2 returns a flat array of one row per (date, base, quote) triple instead
// of v1's `{ base, date, rates: Record<quote, rate> }` object. We translate
// it back into the v1 shape here so callers stay unchanged.
type FrankfurterV2Entry = {
  date: string
  base: string
  quote: string
  rate: number
}

/**
 * Fetch fiat rates from Frankfurter. `base` and `quotes` must be non-crypto
 * catalog codes — the resolver never passes crypto tickers here.
 */
export async function fetchFrankfurterRates(
  date: string,
  base: string,
  quotes?: string[],
): Promise<FrankfurterResponse> {
  let res: Response
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FX_REQUEST_TIMEOUT_MS)
  try {
    const params = new URLSearchParams({ date, base })
    if (quotes?.length) {
      params.set('quotes', Array.from(new Set(quotes)).join(','))
    }
    res = await fetch(`${FRANKFURTER_BASE_URL}/rates?${params.toString()}`, {
      signal: controller.signal,
    })
  } catch (err) {
    throw new CurrencyRateProviderError(
      'Currency rate provider request failed',
      err,
    )
  } finally {
    clearTimeout(timeout)
  }
  if (!res.ok) {
    throw new CurrencyRateProviderError(
      `Currency rate provider returned ${res.status}`,
      undefined,
      res.status,
    )
  }
  const entries = (await res.json()) as FrankfurterV2Entry[]
  const rates: Record<string, number> = {}
  for (const entry of entries) {
    rates[entry.quote] = entry.rate
  }
  return {
    base,
    // The provider may fall back to a different (most recent available)
    // date for currencies that lack data on the requested day; pick the
    // first row's date so callers can record the actual as-of date.
    date: entries[0]?.date ?? date,
    rates,
  }
}

export type FiatFetchImpl = typeof fetchFrankfurterRates
