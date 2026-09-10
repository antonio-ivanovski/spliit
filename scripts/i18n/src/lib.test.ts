import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { locales } from '../../../packages/domain/src/i18n'
import {
  LOCALE_TO_FILE,
  addString,
  auditMessages,
  diffMessages,
  flattenKeys,
  getAt,
  getMessagesDir,
  isSparseLocale,
  missingKeys,
  missingKeysByLocale,
  removeAt,
  removeString,
  reorderSiblings,
  setAt,
  setMessagesDir,
  setString,
  validateAllMessages,
} from './lib'

let dir: string

async function seedFile(locale: keyof typeof LOCALE_TO_FILE, data: unknown) {
  await writeFile(
    join(dir, LOCALE_TO_FILE[locale]),
    JSON.stringify(data, null, 2) + '\n',
  )
}

async function readFileJson(locale: keyof typeof LOCALE_TO_FILE) {
  return JSON.parse(await readFile(join(dir, LOCALE_TO_FILE[locale]), 'utf8'))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'i18n-test-'))
  await mkdir(dir, { recursive: true })
  setMessagesDir(dir)
  for (const locale of Object.keys(LOCALE_TO_FILE) as Array<
    keyof typeof LOCALE_TO_FILE
  >) {
    await writeFile(join(dir, LOCALE_TO_FILE[locale]), '{}\n')
  }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('getAt', () => {
  it('reads nested values', () => {
    expect(getAt({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42)
  })

  it('reads from arrays', () => {
    expect(getAt({ a: ['x', 'y', 'z'] }, 'a.1')).toBe('y')
  })

  it('returns undefined for missing paths', () => {
    expect(getAt({ a: 1 }, 'a.b.c')).toBeUndefined()
  })

  it('accepts array path form', () => {
    expect(getAt({ a: { b: 'hi' } }, ['a', 'b'])).toBe('hi')
  })

  it('treats empty paths as the root', () => {
    const obj = { a: 1 }
    expect(getAt(obj, '')).toBe(obj)
    expect(getAt({ a: 1 }, '.a.')).toBe(1)
  })
})

describe('setAt', () => {
  it('sets nested values and creates intermediate objects', () => {
    const obj: Record<string, unknown> = {}
    setAt(obj, 'a.b.c', 'x')
    expect(obj).toEqual({ a: { b: { c: 'x' } } })
  })

  it('overwrites existing leaf values', () => {
    const obj: Record<string, unknown> = { a: { b: 'old' } }
    setAt(obj, 'a.b', 'new')
    expect(obj).toEqual({ a: { b: 'new' } })
  })

  it('throws on empty path', () => {
    expect(() => setAt({}, '', 'x')).toThrow()
  })
})

describe('removeAt', () => {
  it('removes a leaf and returns true', () => {
    const obj = { a: { b: 'x' } }
    expect(removeAt(obj, 'a.b')).toBe(true)
    expect(obj).toEqual({ a: {} })
  })

  it('returns false for missing paths', () => {
    expect(removeAt({ a: 1 }, 'b')).toBe(false)
    expect(removeAt({ a: { b: 1 } }, 'a.c')).toBe(false)
  })
})

describe('flattenKeys', () => {
  it('returns dotted paths for all leaves', () => {
    expect(flattenKeys({ a: { b: 1, c: { d: 2 } }, e: 3 }).sort()).toEqual([
      'a.b',
      'a.c.d',
      'e',
    ])
  })

  it('returns [] for non-objects', () => {
    expect(flattenKeys(null)).toEqual([])
    expect(flattenKeys('x')).toEqual([])
    expect(flattenKeys([1, 2])).toEqual([])
  })
})

describe('reorderSiblings', () => {
  it('inserts the new key just before the next reference sibling', () => {
    const parent: Record<string, unknown> = { A: 1, C: 3, X: 'x' }
    const ref: Record<string, unknown> = { A: 1, B: 2, C: 3 }
    parent['B'] = 2
    reorderSiblings(parent, ref, 'B')
    expect(Object.keys(parent)).toEqual(['A', 'B', 'C', 'X'])
  })

  it('appends at the end when the key is the last in the reference', () => {
    const parent: Record<string, unknown> = { A: 1, B: 2 }
    const ref: Record<string, unknown> = { A: 1, B: 2, C: 3 }
    parent['C'] = 3
    reorderSiblings(parent, ref, 'C')
    expect(Object.keys(parent)).toEqual(['A', 'B', 'C'])
  })

  it('inserts at the start when no earlier reference sibling exists in parent', () => {
    const parent: Record<string, unknown> = { B: 2, C: 3 }
    const ref: Record<string, unknown> = { A: 1, B: 2, C: 3 }
    parent['A'] = 1
    reorderSiblings(parent, ref, 'A')
    expect(Object.keys(parent)).toEqual(['A', 'B', 'C'])
  })

  it('does nothing if the key is not in the reference', () => {
    const parent: Record<string, unknown> = { A: 1 }
    const ref: Record<string, unknown> = { A: 1 }
    parent['Z'] = 'z'
    reorderSiblings(parent, ref, 'Z')
    expect(Object.keys(parent)).toEqual(['A', 'Z'])
  })

  it('does nothing if the key is not in the parent', () => {
    const parent: Record<string, unknown> = { A: 1 }
    const ref: Record<string, unknown> = { A: 1, B: 2 }
    reorderSiblings(parent, ref, 'B')
    expect(Object.keys(parent)).toEqual(['A'])
  })
})

describe('addString', () => {
  it('writes only to en-US and creates intermediate objects', async () => {
    await seedFile('en-US', { Existing: 'v' })
    await seedFile('fr-FR', { Existing: 'v' })
    await addString('New.deep.key', 'hello')
    expect(await readFileJson('en-US')).toEqual({
      Existing: 'v',
      New: { deep: { key: 'hello' } },
    })
    expect(await readFileJson('fr-FR')).toEqual({ Existing: 'v' })
  })

  it('preserves the original 2-space indent + trailing newline', async () => {
    await seedFile('en-US', {})
    await addString('a', 'b')
    const raw = await readFile(join(dir, 'en-US.json'), 'utf8')
    expect(raw).toBe('{\n  "a": "b"\n}\n')
  })
})

describe('setString', () => {
  it('sets in any locale', async () => {
    await seedFile('en-US', { a: 'a' })
    await seedFile('fr-FR', { a: 'a' })
    await setString('fr-FR', 'a', 'A')
    expect((await readFileJson('fr-FR')).a).toBe('A')
  })

  it('appends to en-US without reordering (matches en-US convention)', async () => {
    await seedFile('en-US', { A: 'a', B: 'b' })
    await setString('en-US', 'C', 'c')
    expect(Object.keys(await readFileJson('en-US'))).toEqual(['A', 'B', 'C'])
  })

  it('inserts into a non-en-US locale at en-US-relative position', async () => {
    await seedFile('en-US', { A: 'a', B: 'b', C: 'c', D: 'd' })
    await seedFile('fr-FR', { A: 'A', C: 'C', X: 'X' })
    await setString('fr-FR', 'B', 'B-fr')
    expect(Object.keys(await readFileJson('fr-FR'))).toEqual([
      'A',
      'B',
      'C',
      'X',
    ])
  })

  it('appends at end when the new key is last in en-US', async () => {
    await seedFile('en-US', { A: 'a', B: 'b' })
    await seedFile('fr-FR', { A: 'A' })
    await setString('fr-FR', 'B', 'B-fr')
    expect(Object.keys(await readFileJson('fr-FR'))).toEqual(['A', 'B'])
  })

  it('inserts at start when the new key is first in en-US and missing in target', async () => {
    await seedFile('en-US', { A: 'a', B: 'b' })
    await seedFile('fr-FR', { B: 'B' })
    await setString('fr-FR', 'A', 'A-fr')
    expect(Object.keys(await readFileJson('fr-FR'))).toEqual(['A', 'B'])
  })
})

describe('removeString', () => {
  it('removes the key from en-US and from any locale that has it', async () => {
    await seedFile('en-US', { a: 'a', b: 'b' })
    await seedFile('fr-FR', { a: 'a', b: 'b' })
    await seedFile('de-DE', { a: 'a' })
    const count = await removeString('b')
    expect(count).toBe(2)
    expect(await readFileJson('en-US')).toEqual({ a: 'a' })
    expect(await readFileJson('fr-FR')).toEqual({ a: 'a' })
    expect(await readFileJson('de-DE')).toEqual({ a: 'a' })
  })

  it('removes locale orphans when the key is already absent from en-US', async () => {
    await seedFile('en-US', { group: { source: 'source' } })
    await seedFile('fr-FR', {
      group: { before: 'avant', obsolete: 'ancien', after: 'après' },
    })
    await seedFile('de-DE', { group: { obsolete: 'alt' } })

    const count = await removeString('group.obsolete')

    expect(count).toBe(2)
    expect(await readFileJson('en-US')).toEqual({
      group: { source: 'source' },
    })
    expect(await readFileJson('fr-FR')).toEqual({
      group: { before: 'avant', after: 'après' },
    })
    expect(await readFileJson('de-DE')).toEqual({})
  })

  it('cleans up empty parents recursively', async () => {
    await seedFile('en-US', { a: { b: { c: 'x' } } })
    await removeString('a.b.c')
    expect(await readFileJson('en-US')).toEqual({})
  })

  it('keeps non-empty parents intact after cleaning up', async () => {
    await seedFile('en-US', { a: { b: 'b', c: 'c' } })
    await removeString('a.b')
    expect(await readFileJson('en-US')).toEqual({ a: { c: 'c' } })
  })

  it('returns 0 when nothing was removed', async () => {
    await seedFile('en-US', { a: 'a' })
    expect(await removeString('missing')).toBe(0)
  })
})

describe('missingKeys', () => {
  it('lists all en-US keys not present in target, sorted', async () => {
    await seedFile('en-US', { a: 'a', b: 'b', c: { d: 'd' } })
    await seedFile('fr-FR', { a: 'A', c: {} })
    expect(await missingKeys('fr-FR')).toEqual(['b', 'c.d'])
  })

  it('returns [] when target is complete', async () => {
    await seedFile('en-US', { a: 'a', b: { c: 'c' } })
    await seedFile('fr-FR', { a: 'A', b: { c: 'C' } })
    expect(await missingKeys('fr-FR')).toEqual([])
  })
})

describe('validateAllMessages', () => {
  it('passes when no orphans exist', async () => {
    for (const locale of locales) await seedFile(locale, {})
    const result = await validateAllMessages()
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('fails with a descriptive error for orphan keys', async () => {
    await seedFile('en-US', { good: 'g' })
    await seedFile('fr-FR', { good: 'G', orphan: 'O' })
    const result = await validateAllMessages()
    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('orphan')
    expect(result.errors[0]).toContain('orphan')
    expect(result.errors[0]).toContain('fr-FR.json')
  })

  it('rejects empty and non-string message values', async () => {
    await seedFile('en-US', { empty: ' ', wrong: 42 })
    const result = await validateAllMessages()
    expect(result.errors).toContain(
      'en-US.json: empty: value must not be empty',
    )
    expect(result.errors).toContain('en-US.json: wrong: value must be a string')
  })

  it('compares interpolation placeholder sets and permits repetition', async () => {
    await seedFile('en-US', { greeting: 'Hello {name}, total {amount}' })
    await seedFile('fr-FR', {
      greeting: '{name}, bonjour {name}, total {extra}',
    })
    const result = await validateAllMessages()
    expect(result.errors).toContain(
      'fr-FR.json: greeting: missing placeholder(s): amount',
    )
    expect(result.errors).toContain(
      'fr-FR.json: greeting: unknown placeholder(s): extra',
    )
    expect(
      result.errors.some((error) =>
        error.includes('unknown placeholder(s): name'),
      ),
    ).toBe(false)
  })

  it('rejects doubled interpolation braces', async () => {
    await seedFile('en-US', { greeting: 'Hello {name}' })
    await seedFile('fr-FR', { greeting: 'Bonjour {{name}}' })
    const result = await validateAllMessages('fr-FR')
    expect(result.errors).toContain(
      'fr-FR.json: greeting: interpolation placeholder {name} must use single braces, not {{name}}',
    )

    await seedFile('en-US', { greeting: 'Hello {{name}}' })
    await seedFile('fr-FR', { greeting: 'Bonjour {name}' })
    const sourceResult = await validateAllMessages('fr-FR')
    expect(sourceResult.errors).toContain(
      'en-US.json: greeting: interpolation placeholder {name} must use single braces, not {{name}}',
    )
  })

  it('can restrict structural validation to one locale', async () => {
    await seedFile('en-US', { greeting: 'Hello' })
    await seedFile('fr-FR', { greeting: 'Bonjour' })
    await seedFile('de-DE', { orphan: 'Hallo' })
    const result = await validateAllMessages('fr-FR')
    expect(result.valid).toBe(true)
  })

  it('rejects malformed, mismatched, and source-incompatible rich-text tags', async () => {
    await seedFile('en-US', { first: '<strong>Hello</strong>', second: 'Hi' })
    await seedFile('fr-FR', {
      first: '<em>Bonjour</strong>',
      second: '<em>Salut</em>',
    })
    const result = await validateAllMessages()
    expect(
      result.errors.some((error) =>
        error.includes('mismatched rich-text tags <em> and </strong>'),
      ),
    ).toBe(true)
    expect(
      result.errors.some((error) =>
        error.includes('rich-text tags differ from en-US'),
      ),
    ).toBe(true)
  })

  it('preserves rich-text nesting and placeholder emphasis', async () => {
    await seedFile('en-US', {
      nested: '<strong><em>Delete</em></strong>',
      named: 'Delete <strong>{name}</strong>',
    })
    await seedFile('fr-FR', {
      nested: '<em><strong>Supprimer</strong></em>',
      named: '<strong>Supprimer</strong> {name}',
    })

    const result = await validateAllMessages('fr-FR')

    expect(result.errors).toContain(
      'fr-FR.json: nested: rich-text tag nesting differs from en-US',
    )
    expect(result.errors).toContain(
      'fr-FR.json: named: placeholder {name} must remain inside <strong>',
    )
  })

  it('requires the canonical plural suffix family in en-US', async () => {
    await seedFile('en-US', {
      itemCount_one: '{count} item',
      itemCount_other: '{count} items',
    })
    const result = await validateAllMessages()
    for (const suffix of ['zero', 'two', 'few', 'many']) {
      expect(result.errors).toContain(
        `en-US.json: itemCount_${suffix}: missing required plural form`,
      )
    }
  })

  it('requires locale-specific plural forms and {count}', async () => {
    const source = Object.fromEntries(
      ['zero', 'one', 'two', 'few', 'many', 'other'].map((suffix) => [
        `itemCount_${suffix}`,
        '{count} items',
      ]),
    )
    await seedFile('en-US', source)
    for (const locale of locales.filter((locale) => locale !== 'en-US')) {
      const localized = Object.fromEntries(
        new Intl.PluralRules(locale)
          .resolvedOptions()
          .pluralCategories.map((suffix) => [
            `itemCount_${suffix}`,
            '{count} translated',
          ]),
      )
      await seedFile(locale, localized)
    }
    await seedFile('he', {
      itemCount_one: 'one without count',
      itemCount_other: '{count} others',
    })

    const result = await validateAllMessages()
    expect(result.errors).toContain(
      'he.json: itemCount_two: missing required plural form',
    )
    expect(result.errors).toContain(
      'he.json: itemCount_one: missing placeholder(s): count',
    )
    expect(result.errors).toContain(
      'he.json: itemCount_one: plural form must contain {count}',
    )
  })
})

describe('diffMessages', () => {
  it('classifies keys as added when present only in working tree', async () => {
    await seedFile('en-US', { old: 'o', brandNew: 'b' })
    const result = await diffMessages({
      readOldEn: async () => ({ old: 'o' }),
    })
    expect(result.thisChange.added).toEqual(['brandNew'])
    expect(result.thisChange.modified).toEqual([])
    expect(result.thisChange.removed).toEqual([])
  })

  it('classifies modified values separately from pure additions', async () => {
    await seedFile('en-US', { same: 'SAME', changed: 'NEW' })
    await seedFile('fr-FR', { same: 'IDENTIQUE', changed: 'TRADUIT' })
    const result = await diffMessages({
      locale: 'fr-FR',
      readOldEn: async () => ({ same: 'SAME', changed: 'OLD' }),
    })
    expect(result.thisChange.added).toEqual([])
    expect(result.thisChange.modified).toEqual(['changed'])
    expect(result.translationWork['fr-FR'].present).toEqual(['changed'])
  })

  it('reports changed plural forms only where the locale uses that category', async () => {
    const source = Object.fromEntries(
      ['zero', 'one', 'two', 'few', 'many', 'other'].map((suffix) => [
        `count_${suffix}`,
        suffix === 'one' ? 'new {count}' : '{count}',
      ]),
    )
    await seedFile('en-US', source)
    await seedFile('ja-JP', { count_other: '{count}' })
    const result = await diffMessages({
      locale: 'ja-JP',
      readOldEn: async () => ({ ...source, count_one: 'old {count}' }),
    })
    expect(result.thisChange.modified).toEqual(['count_one'])
    expect(result.translationWork['ja-JP']).toEqual({
      missing: [],
      present: [],
      covered: [],
    })
  })

  it('partitions translation work into translationWork vs legacyMissing', async () => {
    await seedFile('en-US', { old: 'o', new1: 'n1', new2: 'n2' })
    await seedFile('fr-FR', { old: 'o', new1: 'N1' })
    const result = await diffMessages({
      locale: 'fr-FR',
      readOldEn: async () => ({ old: 'o' }),
    })
    expect(result.translationWork['fr-FR'].missing).toEqual(['new2'])
    expect(result.translationWork['fr-FR'].present).toEqual(['new1'])
    expect(result.legacyMissing['fr-FR']).toBe(0)
  })

  it('counts legacyMissing for pre-existing missing keys', async () => {
    await seedFile('en-US', { kept: 'k', lost1: 'l1', lost2: 'l2', new1: 'n1' })
    await seedFile('fr-FR', { kept: 'K' })
    const result = await diffMessages({
      locale: 'fr-FR',
      readOldEn: async () => ({ kept: 'k', lost1: 'l1', lost2: 'l2' }),
    })
    expect(result.translationWork['fr-FR'].missing).toEqual(['new1'])
    expect(result.legacyMissing['fr-FR']).toBe(2)
  })
})

describe('getMessagesDir / setMessagesDir', () => {
  it('returns the currently configured dir', () => {
    setMessagesDir('/tmp/example')
    expect(getMessagesDir()).toBe('/tmp/example')
  })
})

describe('missingKeysByLocale', () => {
  it('reports missing keys for every non-en-US locale', async () => {
    await seedFile('en-US', { a: 'a', b: 'b', c: { d: 'd' } })
    await seedFile('fr-FR', { a: 'A', c: { d: 'D' } })
    await seedFile('de-DE', { a: 'A' })
    const result = await missingKeysByLocale()
    expect(result['fr-FR']).toEqual(['b'])
    expect(result['de-DE']).toEqual(['b', 'c.d'])
    for (const locale of Object.keys(result)) {
      expect(locale).not.toBe('en-US')
    }
  })

  it('does not report plural categories unused by the locale', async () => {
    const source = Object.fromEntries(
      ['zero', 'one', 'two', 'few', 'many', 'other'].map((suffix) => [
        `count_${suffix}`,
        '{count}',
      ]),
    )
    await seedFile('en-US', source)
    await seedFile('ja-JP', { count_other: '{count}' })

    const result = await missingKeysByLocale()

    expect(result['ja-JP']).toEqual([])
  })
})

async function seedNonEnLocales(data: Record<string, unknown>) {
  for (const locale of Object.keys(LOCALE_TO_FILE) as Array<
    keyof typeof LOCALE_TO_FILE
  >) {
    if (locale === 'en-US') continue
    await seedFile(locale, data)
  }
}

describe('auditMessages', () => {
  it('reports per-locale coverage and counts total keys from en-US', async () => {
    await seedFile('en-US', { a: 'a', b: 'b', c: 'c' })
    await seedNonEnLocales({ a: 'A', b: 'B', c: 'C' })
    await seedFile('fr-FR', { a: 'A', b: 'B' })
    await seedFile('de-DE', { a: 'A', b: 'B', c: 'C' })
    const result = await auditMessages({
      // Snapshot current en-US so introducedKeys is empty (unit-test isolation
      // from the real git ref). Production check uses git HEAD.
      readOldEn: async () => ({ a: 'a', b: 'b', c: 'c' }),
    })
    const nonEnCount = locales.filter((l) => l !== 'en-US').length
    expect(result.totalKeys).toBe(3)
    expect(result.valid).toBe(true)
    expect(result.summary.localesAudited).toBe(nonEnCount)
    expect(result.summary.localesComplete).toBe(nonEnCount - 1)
    expect(result.summary.localesWithMissing).toBe(1)
    expect(result.summary.totalMissing).toBe(1)
    expect(result.summary.totalUntranslatedEnglish).toBe(0)
    expect(result.locales['fr-FR']).toMatchObject({
      total: 3,
      present: 2,
      missing: 1,
      missingKeys: ['c'],
      coverage: 2 / 3,
    })
    expect(result.locales['de-DE']).toMatchObject({
      total: 3,
      present: 3,
      missing: 0,
      missingKeys: [],
      coverage: 1,
    })
  })

  it('excludes en-US from the audit', async () => {
    await seedFile('en-US', { a: 'a' })
    await seedNonEnLocales({ a: 'A' })
    const result = await auditMessages({
      readOldEn: async () => ({ a: 'a' }),
    })
    expect(result.locales['en-US']).toBeUndefined()
  })

  it('restricts to --locale when provided', async () => {
    await seedFile('en-US', { a: 'a', b: 'b' })
    await seedNonEnLocales({ a: 'A' })
    await seedFile('fr-FR', { a: 'A' })
    await seedFile('de-DE', { a: 'A' })
    const result = await auditMessages({
      locale: 'fr-FR',
      readOldEn: async () => ({ a: 'a', b: 'b' }),
    })
    expect(result.summary.localesAudited).toBe(1)
    expect(Object.keys(result.locales)).toEqual(['fr-FR'])
    expect(result.locales['fr-FR'].missing).toBe(1)
  })

  it('restricts structural validation to --locale', async () => {
    await seedFile('en-US', { a: 'a' })
    await seedFile('fr-FR', { a: 'A' })
    await seedFile('de-DE', { orphan: 'O' })
    const result = await auditMessages({
      locale: 'fr-FR',
      readOldEn: async () => ({ a: 'a' }),
    })
    expect(result.valid).toBe(true)
  })

  it('reports orphan keys via the embedded validation result', async () => {
    await seedFile('en-US', { a: 'a' })
    await seedNonEnLocales({ a: 'A' })
    await seedFile('fr-FR', { a: 'A', orphan: 'O' })
    const result = await auditMessages({
      readOldEn: async () => ({ a: 'a' }),
    })
    expect(result.valid).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('orphan')
  })

  it('fails introduced keys that are identical to en-US', async () => {
    await seedFile('en-US', { kept: 'k', brandNew: 'Remove participant?' })
    await seedNonEnLocales({ kept: 'K', brandNew: 'Remove participant?' })
    const result = await auditMessages({
      readOldEn: async () => ({ kept: 'k' }),
    })
    expect(result.introducedKeys).toEqual(['brandNew'])
    expect(result.summary.totalUntranslatedEnglish).toBe(
      locales.filter((l) => l !== 'en-US').length,
    )
    expect(result.locales['fr-FR'].untranslatedEnglishKeys).toEqual([
      'brandNew',
    ])
  })

  it('does not fail legacy identical-to-en keys', async () => {
    await seedFile('en-US', { legacy: 'Remove', brandNew: 'New string' })
    await seedNonEnLocales({ legacy: 'Remove', brandNew: 'Nouvelle chaîne' })
    const result = await auditMessages({
      readOldEn: async () => ({ legacy: 'Remove' }),
    })
    expect(result.introducedKeys).toEqual(['brandNew'])
    expect(result.summary.totalUntranslatedEnglish).toBe(0)
    expect(result.locales['fr-FR'].untranslatedEnglishKeys).toEqual([])
  })

  it('auto-allows brand identical values on introduced keys', async () => {
    await seedFile('en-US', { brand: 'GitHub' })
    await seedNonEnLocales({ brand: 'GitHub' })
    const result = await auditMessages({
      readOldEn: async () => ({}),
    })
    expect(result.summary.totalUntranslatedEnglish).toBe(0)
  })

  it('changesOnly mode: only flags keys the diff introduced', async () => {
    await seedFile('en-US', { kept: 'k', pre: 'p', brandNew: 'b' })
    await seedNonEnLocales({ kept: 'K', pre: 'P' })
    await seedFile('fr-FR', { kept: 'K' })
    const result = await auditMessages({
      changesOnly: true,
      readOldEn: async () => ({ kept: 'k', pre: 'p' }),
    })
    expect(result.changesOnly).toBe(true)
    expect(result.introducedKeys).toEqual(['brandNew'])
    // fr-FR has no "brandNew" but is missing the unchanged "pre" — that
    // is legacy debt and must not appear in changesOnly output.
    expect(result.locales['fr-FR'].missingKeys).toEqual(['brandNew'])
    expect(result.locales['fr-FR'].missing).toBe(1)
    // Every full locale that lacks the introduced key is flagged once for
    // it; no locale should be flagged for legacy debt ("pre", "kept").
    // Sparse overlays (en-GB, pt-BR) inherit the key — nothing to flag.
    for (const audit of Object.values(result.locales)) {
      if (isSparseLocale(audit.locale)) {
        expect(audit.missingKeys).toEqual([])
      } else {
        expect(audit.missingKeys).toEqual(['brandNew'])
      }
    }
  })

  it('changesOnly with no diff: all locales are clean even if behind', async () => {
    await seedFile('en-US', { kept: 'k', brandNew: 'b' })
    await seedFile('fr-FR', {})
    const result = await auditMessages({
      changesOnly: true,
      readOldEn: async () => ({ kept: 'k', brandNew: 'b' }),
    })
    expect(result.introducedKeys).toEqual([])
    expect(result.summary.totalMissing).toBe(0)
    expect(result.locales['fr-FR'].missing).toBe(0)
  })

  it('handles empty en-US as fully covered', async () => {
    await seedFile('en-US', {})
    const result = await auditMessages({
      readOldEn: async () => ({}),
    })
    expect(result.totalKeys).toBe(0)
    expect(result.summary.totalMissing).toBe(0)
    for (const audit of Object.values(result.locales)) {
      expect(audit.coverage).toBe(1)
    }
  })

  it('requires only the target locale plural categories', async () => {
    const source = Object.fromEntries(
      ['zero', 'one', 'two', 'few', 'many', 'other'].map((suffix) => [
        `count_${suffix}`,
        '{count}',
      ]),
    )
    await seedFile('en-US', source)
    await seedFile('ja-JP', { count_other: '{count}' })
    const result = await auditMessages({
      locale: 'ja-JP',
      readOldEn: async () => source,
    })
    expect(result.totalKeys).toBe(6)
    expect(result.locales['ja-JP'].total).toBe(1)
    expect(result.locales['ja-JP'].present).toBe(1)
    expect(result.locales['ja-JP'].coverage).toBe(1)
    expect(result.locales['ja-JP'].missingKeys).toEqual([])
  })
})
