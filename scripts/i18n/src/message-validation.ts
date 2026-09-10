import { type Locale } from '../../../packages/domain/src/i18n'
import { flattenKeys, getAt } from './object-path'

export const PLURAL_SUFFIXES = [
  'zero',
  'one',
  'two',
  'few',
  'many',
  'other',
] as const

type PluralSuffix = (typeof PLURAL_SUFFIXES)[number]

const pluralSuffixPattern = new RegExp(`^(.*)_(${PLURAL_SUFFIXES.join('|')})$`)

function pluralKeyParts(
  key: string,
): { base: string; suffix: PluralSuffix } | null {
  const match = pluralSuffixPattern.exec(key)
  if (!match) return null
  return { base: match[1], suffix: match[2] as PluralSuffix }
}

export function getPluralFamilies(sourceKeys: readonly string[]): Set<string> {
  const families = new Set<string>()
  for (const key of sourceKeys) {
    const parts = pluralKeyParts(key)
    if (parts?.suffix === 'other') {
      families.add(parts.base)
    }
  }
  return families
}

function isFamilyVariant(key: string, families: ReadonlySet<string>): boolean {
  const parts = pluralKeyParts(key)
  return parts !== null && families.has(parts.base)
}

export function expectedKeysForLocale(
  sourceKeys: readonly string[],
  locale: Locale,
): string[] {
  const families = getPluralFamilies(sourceKeys)
  const expected = sourceKeys.filter((key) => !isFamilyVariant(key, families))

  for (const family of families) {
    for (const category of new Intl.PluralRules(locale).resolvedOptions()
      .pluralCategories) {
      expected.push(`${family}_${category}`)
    }
  }

  return expected.sort()
}

export function isAllowedLocaleKey(
  key: string,
  sourceKeys: ReadonlySet<string>,
  sourceFamilies: ReadonlySet<string>,
): boolean {
  if (sourceKeys.has(key)) return true
  const parts = pluralKeyParts(key)
  return parts !== null && sourceFamilies.has(parts.base)
}

function placeholders(value: string): Set<string> {
  return new Set(
    [...value.matchAll(/\{([A-Za-z][\w.-]*)\}/g)].map((match) => match[1]),
  )
}

function doubledPlaceholders(value: string): string[] {
  return [
    ...new Set(
      [...value.matchAll(/\{\{\s*([A-Za-z][\w.-]*)\s*\}\}/g)].map(
        (match) => match[1],
      ),
    ),
  ].sort()
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return [...left].filter((value) => !right.has(value)).sort()
}

type TagAnalysis = {
  counts: Map<string, number>
  paths: Map<string, number>
  placeholderContexts: Map<string, Set<string>>
  errors: string[]
}

function analyzeTags(value: string): TagAnalysis {
  const counts = new Map<string, number>()
  const paths = new Map<string, number>()
  const placeholderContexts = new Map<string, Set<string>>()
  const errors: string[] = []
  const stack: string[] = []
  const tagPattern = /<[^<>]*>/g
  const covered = new Set<number>()

  for (const match of value.matchAll(tagPattern)) {
    const token = match[0]
    const index = match.index ?? 0
    for (let i = index; i < index + token.length; i++) covered.add(i)

    const parsed = /^<(\/)?([A-Za-z0-9][\w-]*)(\/?)>$/.exec(token)
    if (!parsed || (parsed[1] && parsed[3])) {
      errors.push(`malformed rich-text tag "${token}"`)
      continue
    }

    const [, closing, name, selfClosing] = parsed
    counts.set(name, (counts.get(name) ?? 0) + 1)
    if (selfClosing) continue
    if (!closing) {
      stack.push(name)
      continue
    }

    const open = stack.pop()
    if (open !== name) {
      errors.push(
        open === undefined
          ? `closing rich-text tag </${name}> has no opener`
          : `mismatched rich-text tags <${open}> and </${name}>`,
      )
    }
  }

  for (let i = 0; i < value.length; i++) {
    if ((value[i] === '<' || value[i] === '>') && !covered.has(i)) {
      errors.push(`malformed rich-text tag delimiter "${value[i]}"`)
    }
  }
  for (const name of stack.reverse()) {
    errors.push(`rich-text tag <${name}> is not closed`)
  }

  const semanticStack: string[] = []
  const semanticTokens = /<[^<>]*>|\{([A-Za-z][\w.-]*)\}/g
  for (const match of value.matchAll(semanticTokens)) {
    const token = match[0]
    if (token.startsWith('{')) {
      const name = match[1]
      const contexts = placeholderContexts.get(name) ?? new Set<string>()
      contexts.add(semanticStack.join('>'))
      placeholderContexts.set(name, contexts)
      continue
    }

    const parsed = /^<(\/)?([A-Za-z0-9][\w-]*)(\/?)>$/.exec(token)
    if (!parsed) continue
    const [, closing, name, selfClosing] = parsed
    if (closing) {
      if (semanticStack.at(-1) === name) semanticStack.pop()
      continue
    }
    const path = [...semanticStack, name].join('>')
    paths.set(path, (paths.get(path) ?? 0) + 1)
    if (!selfClosing) semanticStack.push(name)
  }

  return { counts, paths, placeholderContexts, errors }
}

function sameCounts(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>,
) {
  if (left.size !== right.size) return false
  for (const [name, count] of left) {
    if (right.get(name) !== count) return false
  }
  return true
}

function describeTagCounts(counts: ReadonlyMap<string, number>): string {
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, count]) => `<${name}> x${count}`)
    .join(', ')
}

export function validateMessageData(
  locale: Locale,
  data: Record<string, unknown>,
  sourceData: Record<string, unknown>,
  sourceKeys: readonly string[],
  /**
   * Keys inherited from a fallback ancestor (sparse overlays only). A missing
   * plural form covered by the parent bundle is not an error — it resolves at
   * runtime.
   */
  coveredKeys: ReadonlySet<string> = new Set(),
): string[] {
  const errors: string[] = []
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return ['message file root must be an object']
  }
  const keys = flattenKeys(data)
  const sourceFamilies = getPluralFamilies(sourceKeys)

  for (const key of keys) {
    const value = getAt(data, key)
    if (typeof value !== 'string') {
      errors.push(`${key}: value must be a string`)
      continue
    }
    if (value.trim().length === 0) {
      errors.push(`${key}: value must not be empty`)
    }

    for (const name of doubledPlaceholders(value)) {
      errors.push(
        `${key}: interpolation placeholder {${name}} must use single braces, not {{${name}}}`,
      )
    }

    const tagAnalysis = analyzeTags(value)
    errors.push(...tagAnalysis.errors.map((error) => `${key}: ${error}`))

    if (locale === 'en-US') continue
    const sourceValue = getAt(sourceData, key)
    if (typeof sourceValue !== 'string') continue

    const sourcePlaceholders = placeholders(sourceValue)
    const localePlaceholders = placeholders(value)
    const missing = difference(sourcePlaceholders, localePlaceholders)
    const unknown = difference(localePlaceholders, sourcePlaceholders)
    if (missing.length > 0) {
      errors.push(`${key}: missing placeholder(s): ${missing.join(', ')}`)
    }
    if (unknown.length > 0) {
      errors.push(`${key}: unknown placeholder(s): ${unknown.join(', ')}`)
    }

    const sourceTags = analyzeTags(sourceValue).counts
    if (!sameCounts(sourceTags, tagAnalysis.counts)) {
      errors.push(
        `${key}: rich-text tags differ from en-US (expected ${describeTagCounts(sourceTags) || 'none'}; found ${describeTagCounts(tagAnalysis.counts) || 'none'})`,
      )
    }

    const sourceAnalysis = analyzeTags(sourceValue)
    if (!sameCounts(sourceAnalysis.paths, tagAnalysis.paths)) {
      errors.push(`${key}: rich-text tag nesting differs from en-US`)
    }
    for (const [placeholder, contexts] of sourceAnalysis.placeholderContexts) {
      const localeContexts = tagAnalysis.placeholderContexts.get(placeholder)
      for (const context of contexts) {
        if (!localeContexts?.has(context)) {
          errors.push(
            `${key}: placeholder {${placeholder}} must remain inside ${context ? `<${context.replaceAll('>', '><')}>` : 'the same rich-text context'}`,
          )
        }
      }
    }
  }

  for (const family of sourceFamilies) {
    const suffixes =
      locale === 'en-US'
        ? PLURAL_SUFFIXES
        : new Intl.PluralRules(locale).resolvedOptions().pluralCategories
    for (const suffix of suffixes) {
      const key = `${family}_${suffix}`
      const value = getAt(data, key)
      if (typeof value !== 'string') {
        if (!coveredKeys.has(key)) {
          errors.push(`${key}: missing required plural form`)
        }
      } else if (!placeholders(value).has('count')) {
        errors.push(`${key}: plural form must contain {count}`)
      }
    }
  }

  return errors
}
