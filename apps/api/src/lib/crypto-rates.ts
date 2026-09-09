import {
  CurrencyRateProviderError,
  FX_REQUEST_TIMEOUT_MS,
} from './currency-errors'

const COINBASE_BASE_URL = 'https://api.coinbase.com/v2'

type CoinbaseSpotResponse = {
  data?: {
    base: string
    currency: string
    amount: string
  }
  error?: string
}

/**
 * Resolve the spot rate of 1 unit of `base` in `target` on `date` (UTC) via
 * Coinbase's public Data API. Returns null when Coinbase has no rate for the
 * pair on that date (unknown pair or date beyond the provider's history depth);
 * throws on transport/provider failures.
 */
export async function fetchCoinbaseSpot(
  date: string,
  base: string,
  target: string,
): Promise<number | null> {
  const url = `${COINBASE_BASE_URL}/prices/${base}-${target}/spot?date=${date}`
  let res: Response
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FX_REQUEST_TIMEOUT_MS)
  try {
    res = await fetch(url, { signal: controller.signal })
  } catch (err) {
    throw new CurrencyRateProviderError(
      'Crypto rate provider request failed',
      err,
    )
  } finally {
    clearTimeout(timeout)
  }
  if (res.status === 404) return null
  if (!res.ok) {
    throw new CurrencyRateProviderError(
      `Crypto rate provider returned ${res.status}`,
      undefined,
      res.status,
    )
  }
  const payload = (await res.json()) as CoinbaseSpotResponse
  const amount = Number(payload.data?.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return null
  }
  return amount
}

export type CryptoFetchImpl = typeof fetchCoinbaseSpot
