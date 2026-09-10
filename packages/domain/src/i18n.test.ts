import {
  fallbackChain,
  firstDayOfWeek,
  isRtlLocale,
  isSparseLocale,
  resolveFormattingLocale,
} from './i18n'

describe('locale formatting conventions', () => {
  it('resolves language-only bundles to their intended regions', () => {
    expect(resolveFormattingLocale('pt')).toBe('pt-PT')
    expect(resolveFormattingLocale('es')).toBe('es-ES')
    expect(resolveFormattingLocale('en-GZ')).toBe('en-US')
    expect(resolveFormattingLocale('de-DE')).toBe('de-DE')
  })

  it('uses regional first-day-of-week conventions', () => {
    expect(firstDayOfWeek('en-US')).toBe(7)
    expect(firstDayOfWeek('en-GB')).toBe(1)
    expect(firstDayOfWeek('de-DE')).toBe(1)
    expect(firstDayOfWeek('pt')).toBe(7)
  })

  it('falls back to the English-US convention for invalid tags', () => {
    expect(resolveFormattingLocale('')).toBe('en-US')
    expect(firstDayOfWeek('')).toBe(7)
  })

  it('identifies the supported right-to-left language families', () => {
    expect(isRtlLocale('ar-SA')).toBe(true)
    expect(isRtlLocale('he')).toBe(true)
    expect(isRtlLocale('ur-PK')).toBe(true)
    expect(isRtlLocale('en-US')).toBe(false)
  })
})

describe('locale fallback chains', () => {
  it('resolves direct and transitive chains ending at en-US', () => {
    expect(fallbackChain('en-GB')).toEqual(['en-US'])
    expect(fallbackChain('pt-BR')).toEqual(['pt', 'en-US'])
  })

  it('falls back to en-US for full locales and is empty for en-US itself', () => {
    expect(fallbackChain('fr-FR')).toEqual(['en-US'])
    expect(fallbackChain('de-DE')).toBeInstanceOf(Array)
    expect(fallbackChain('en-US')).toEqual([])
  })

  it('marks only overlay locales as sparse', () => {
    expect(isSparseLocale('en-GB')).toBe(true)
    expect(isSparseLocale('pt-BR')).toBe(true)
    expect(isSparseLocale('en-US')).toBe(false)
    expect(isSparseLocale('fr-FR')).toBe(false)
    expect(isSparseLocale('en-GZ')).toBe(false)
  })
})
