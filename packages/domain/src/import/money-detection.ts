import { getCurrency, resolveCurrencyCode } from '../currency'

/** Detect currency evidence without assigning ambiguous symbols to a country. */
export function inspectDelimitedCurrency(value: string) {
  const codes = new Set(
    (value.match(/(?<![A-Za-z])[A-Za-z]{3}(?![A-Za-z])/g) ?? [])
      .map((code) => code.toUpperCase())
      .filter((code) => Boolean(getCurrency(code))),
  )
  // Region-qualified symbols (CA$, US$, A$, HK$, R$) resolve to a country via
  // the currency catalog (CA$ → CAD). Try them before discarding shared `$`
  // as ambiguous; only a bare shared symbol stays ambiguous.
  const qualifierTokens = value.match(/[A-Za-z]{1,3}\p{Sc}/gu) ?? []
  const resolvedQualifierTokens = new Set<string>()
  for (const token of qualifierTokens) {
    const resolved = resolveCurrencyCode(token)
    if (resolved) {
      codes.add(resolved)
      resolvedQualifierTokens.add(token)
    }
  }
  const remainder =
    resolvedQualifierTokens.size > 0
      ? [...resolvedQualifierTokens].reduce(
          (text, token) => text.split(token).join(' '),
          value,
        )
      : value
  const symbols = remainder.match(/\p{Sc}/gu) ?? []
  // The currency picker uses region-qualified symbols (CA$, A$, …), so a
  // unique bare-symbol match in its catalog is not proof of a country.
  const sharedSymbols = new Set(['$', '¥', '￥', '£', '₨', '₩'])
  let ignoredSharedSymbols = 0
  const resolvedSymbols = symbols.map((symbol) => {
    if (!sharedSymbols.has(symbol)) return resolveCurrencyCode(symbol)
    ignoredSharedSymbols += 1
    return null
  })
  for (const code of resolvedSymbols) if (code) codes.add(code)
  const hasEvidence = codes.size > 0 || symbols.length > 0
  return {
    code: codes.size === 1 ? [...codes][0]! : null,
    hasEvidence,
    // A discarded shared symbol alongside a resolved code (e.g. `€ £50`) is
    // conflicting evidence, not agreement: the £ could be the real currency.
    ambiguous:
      codes.size > 1 ||
      (hasEvidence && codes.size === 0) ||
      (ignoredSharedSymbols > 0 && codes.size > 0),
  }
}

/** Profiling must not treat “Shop 123” as money just because parsing is lenient. */
export function isDelimitedMoneyInput(value: string) {
  const stripped = value
    // Region-qualified symbols (CA$, A$, US$, HK$, R$) carry a 1-3 letter
    // qualifier glued to the sign. Strip them before the allowlist test so
    // qualified amounts profile as money like bare symbols do.
    .replace(/[A-Za-z]{1,3}\p{Sc}/gu, '')
    .replace(/(?<![A-Za-z])[A-Za-z]{3}(?![A-Za-z])/g, (code) =>
      getCurrency(code.toUpperCase()) ? '' : code,
    )
    .replace(/\p{Sc}/gu, '')
    // Mirror parseDelimitedNumber: non-ASCII minus signs and trailing CR/DR
    // markers are legitimate amount syntax, not prose.
    .replace(/^[\u2212\u2012\u2013\u2014\u2015\uFE58\uFE63\uFF0D]+/, '-')
    .replace(/\b(CR|DR)\b\s*$/i, '')
  return /\d/.test(stripped) && /^[\d\s.,+'’()-]+$/.test(stripped)
}
