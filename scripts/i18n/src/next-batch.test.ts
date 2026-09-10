import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { assertFamiliesCoverAllLocales } from './families'
import { addLocaleToFamilySource } from './init-locale'
import {
  LOCALE_TO_FILE,
  nextTranslationBatch,
  setMessagesDir,
  setStrings,
} from './lib'

describe('families cover domain locales', () => {
  it('stays in sync with domain locales', () => {
    expect(() => assertFamiliesCoverAllLocales()).not.toThrow()
  })
})

describe('addLocaleToFamilySource', () => {
  it('inserts a locale into the named family alphabetically', () => {
    const source = `
export const LANGUAGE_FAMILIES = [
  {
    id: 'germanic',
    label: 'Germanic',
    locales: ['de-DE', 'nl-NL'],
    refsHint: 'de-DE',
  },
]
`
    const next = addLocaleToFamilySource(source, 'germanic', 'sv-SE')
    expect(next).toContain("locales: ['de-DE', 'nl-NL', 'sv-SE']")
  })
})

describe('nextTranslationBatch', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'i18n-next-'))
    setMessagesDir(dir)
    for (const locale of Object.keys(LOCALE_TO_FILE)) {
      await writeFile(join(dir, `${locale}.json`), '{}\n')
    }
    await writeFile(
      join(dir, 'en-US.json'),
      JSON.stringify({ a: 'A', b: 'B', c: 'C', d: 'D' }, null, 2) + '\n',
    )
    await writeFile(join(dir, 'fr-FR.json'), '{}\n')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns the first size missing keys and advances after set', async () => {
    const first = await nextTranslationBatch({
      locale: 'fr-FR',
      size: 2,
      usages: false,
    })
    expect(first.done).toBe(false)
    expect(first.remaining).toBe(4)
    expect(first.completed).toBe(0)
    expect(first.batch).toBe(1)
    expect(first.keys.map((k) => k.key)).toEqual(['a', 'b'])
    expect(first.guidePaths).toEqual({
      baseline: 'scripts/i18n/guides/default.md',
      locales: { 'fr-FR': 'scripts/i18n/guides/fr-FR.md' },
    })
    expect(first.applyTemplate).toEqual({ a: '', b: '' })
    expect(first.setCommand).toContain('set fr-FR --stdin')
    expect(first.nextCommand).toContain('next --locale fr-FR')

    await setStrings('fr-FR', { a: 'α', b: 'β' })

    const second = await nextTranslationBatch({
      locale: 'fr-FR',
      size: 2,
      usages: false,
    })
    expect(second.remaining).toBe(2)
    expect(second.completed).toBe(2)
    expect(second.batch).toBe(2)
    expect(second.keys.map((k) => k.key)).toEqual(['c', 'd'])

    await setStrings('fr-FR', { c: 'γ', d: 'δ' })

    const done = await nextTranslationBatch({
      locale: 'fr-FR',
      size: 2,
      usages: false,
    })
    expect(done.done).toBe(true)
    expect(done.keys).toEqual([])
    expect(done.remaining).toBe(0)
    expect(done.checkCommand).toContain('check --locale fr-FR')
  })
})
