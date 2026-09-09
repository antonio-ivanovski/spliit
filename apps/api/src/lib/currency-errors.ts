/** Keep provider calls below the pg-boss 300s materialization lease. */
export const FX_REQUEST_TIMEOUT_MS = 10_000

export class UnsupportedCurrencyError extends Error {
  constructor(readonly code: string) {
    super(`Unsupported currency code: ${code}`)
    this.name = 'UnsupportedCurrencyError'
  }
}

export class CurrencyRateNotFoundError extends Error {
  constructor(readonly target: string) {
    super(`Provider did not return a rate for target ${target}`)
    this.name = 'CurrencyRateNotFoundError'
  }
}

export class CurrencyRateProviderError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'CurrencyRateProviderError'
  }
}
