import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  LANGUAGE_FAMILIES,
  assertFamiliesCoverAllLocales,
  nonEnLocales,
} from './families'
import {
  LOCALE_TO_FILE,
  packMessages,
  planTranslations,
  selectPlanMode,
  setMessagesDir,
} from './lib'

describe('selectPlanMode', () => {
  it('maps key counts to modes', () => {
    expect(selectPlanMode(0)).toBe('noop')
    expect(selectPlanMode(1)).toBe('oneshot')
    expect(selectPlanMode(2)).toBe('oneshot')
    expect(selectPlanMode(3)).toBe('single')
    expect(selectPlanMode(8)).toBe('single')
    expect(selectPlanMode(9)).toBe('parallel')
  })
})

describe('LANGUAGE_FAMILIES', () => {
  it('covers every non-en locale exactly once', () => {
    expect(() => assertFamiliesCoverAllLocales()).not.toThrow()
    const covered = LANGUAGE_FAMILIES.flatMap((f) => f.locales)
    expect(covered.sort()).toEqual([...nonEnLocales()].sort())
  })
})

describe('planTranslations', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'i18n-plan-'))
    await mkdir(dir, { recursive: true })
    setMessagesDir(dir)
    for (const locale of Object.keys(LOCALE_TO_FILE)) {
      await writeFile(join(dir, `${locale}.json`), '{}\n')
    }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function seedAllLocales(data: Record<string, unknown>) {
    for (const locale of Object.keys(LOCALE_TO_FILE)) {
      if (locale === 'en-US') continue
      await writeFile(
        join(dir, `${locale}.json`),
        JSON.stringify(data, null, 2) + '\n',
      )
    }
  }

  it('returns noop when there is no introduced work', async () => {
    await writeFile(
      join(dir, 'en-US.json'),
      JSON.stringify({ a: 'A' }, null, 2) + '\n',
    )
    await seedAllLocales({ a: 'X' })
    const plan = await planTranslations({
      readOldEn: async () => ({ a: 'A' }),
    })
    expect(plan.mode).toBe('noop')
    expect(plan.batches).toEqual([])
    expect(plan.summary.totalCells).toBe(0)
  })

  it('oneshots for 1–2 introduced keys', async () => {
    await writeFile(
      join(dir, 'en-US.json'),
      JSON.stringify({ a: 'A', b: 'B' }, null, 2) + '\n',
    )
    await seedAllLocales({})
    const plan = await planTranslations({
      readOldEn: async () => ({}),
    })
    expect(plan.mode).toBe('oneshot')
    expect(plan.keys.map((k) => k.key).sort()).toEqual(['a', 'b'])
    expect(plan.batches).toHaveLength(1)
    expect(plan.batches[0].id).toBe('oneshot')
    expect(plan.batches[0].prompt).toContain('usages')
    expect(plan.batches[0].prompt).toContain('scripts/i18n/guides/default.md')
    expect(plan.batches[0].prompt).toContain('scripts/i18n/guides/en-GZ.md')
    expect(plan.batches[0].guidePaths.locales['en-GZ']).toBe(
      'scripts/i18n/guides/en-GZ.md',
    )
    expect(plan.summary.missingCells).toBe(
      // Sparse overlays (en-GB, pt-BR) inherit new keys — no work cells.
      (nonEnLocales().length - 2) * 2,
    )
  })

  it('uses single mode for 3–8 keys', async () => {
    const en: Record<string, string> = {}
    for (let i = 0; i < 5; i++) en[`k${i}`] = `v${i}`
    await writeFile(join(dir, 'en-US.json'), JSON.stringify(en, null, 2) + '\n')
    await seedAllLocales({})
    const plan = await planTranslations({
      readOldEn: async () => ({}),
    })
    expect(plan.mode).toBe('single')
    expect(plan.batches).toHaveLength(1)
    expect(plan.batches[0].id).toBe('all-families')
  })

  it('uses parallel mode for 9+ keys with one batch per family needing work', async () => {
    const en: Record<string, string> = {}
    for (let i = 0; i < 10; i++) en[`k${i}`] = `v${i}`
    await writeFile(join(dir, 'en-US.json'), JSON.stringify(en, null, 2) + '\n')
    await seedAllLocales({})
    const plan = await planTranslations({
      readOldEn: async () => ({}),
    })
    expect(plan.mode).toBe('parallel')
    expect(plan.batches.map((b) => b.id).sort()).toEqual(
      LANGUAGE_FAMILIES.map((f) => f.id).sort(),
    )
    expect(plan.batches[0].prompt).toContain('translator')
    expect(plan.batches[0].packCommand).toContain('--locales')
    expect(plan.batches[0].packCommand).toContain('--keys')
  })

  it('counts stale cells when en is modified and locale already has the key', async () => {
    await writeFile(
      join(dir, 'en-US.json'),
      JSON.stringify({ title: 'New title' }, null, 2) + '\n',
    )
    await seedAllLocales({ title: 'Old translation' })
    const plan = await planTranslations({
      readOldEn: async () => ({ title: 'Old title' }),
    })
    expect(plan.keys).toEqual([
      { key: 'title', en: 'New title', change: 'modified' },
    ])
    expect(plan.summary.staleCells).toBe(nonEnLocales().length)
    expect(plan.summary.missingCells).toBe(0)
    expect(plan.mode).toBe('oneshot')
  })
})

describe('packMessages multi-locale', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'i18n-multipack-'))
    setMessagesDir(dir)
    for (const locale of Object.keys(LOCALE_TO_FILE)) {
      await writeFile(join(dir, `${locale}.json`), '{}\n')
    }
    await writeFile(
      join(dir, 'en-US.json'),
      JSON.stringify(
        {
          Members: { title: 'Members', remove: 'Remove' },
        },
        null,
        2,
      ) + '\n',
    )
    await writeFile(
      join(dir, 'fr-FR.json'),
      JSON.stringify({ Members: { title: 'Membres' } }, null, 2) + '\n',
    )
    await writeFile(
      join(dir, 'es.json'),
      JSON.stringify(
        { Members: { title: 'Miembros', remove: 'Eliminar' } },
        null,
        2,
      ) + '\n',
    )
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('packs multiple locales with byLocale status and in-family values', async () => {
    const result = await packMessages({
      locales: ['fr-FR', 'es'],
      keys: ['Members.title', 'Members.remove'],
    })
    expect(result.locales).toEqual(['fr-FR', 'es'])
    expect(result.guidePaths).toEqual({
      baseline: 'scripts/i18n/guides/default.md',
      locales: {
        'fr-FR': 'scripts/i18n/guides/fr-FR.md',
        es: 'scripts/i18n/guides/es.md',
      },
    })
    const remove = result.keys.find((k) => k.key === 'Members.remove')
    expect(remove).toBeTruthy()
    expect(remove!.byLocale!['fr-FR'].status).toBe('missing')
    expect(remove!.byLocale!['es'].status).toBe('ok')
    expect(remove!.byLocale!['fr-FR'].values.es).toBe('Eliminar')
    // title is ok in both → filtered out when using --keys that need work
    expect(result.keys.every((k) => k.key !== 'Members.title')).toBe(true)
  })

  it('marks stale when en was modified', async () => {
    await writeFile(
      join(dir, 'en-US.json'),
      JSON.stringify({ Members: { title: 'Team' } }, null, 2) + '\n',
    )
    await writeFile(
      join(dir, 'fr-FR.json'),
      JSON.stringify({ Members: { title: 'Membres' } }, null, 2) + '\n',
    )
    const result = await packMessages({
      locales: ['fr-FR'],
      keys: ['Members.title'],
      readOldEn: async () => ({ Members: { title: 'Members' } }),
    })
    expect(result.keys[0].byLocale!['fr-FR'].status).toBe('stale')
    expect(result.keys[0].byLocale!['fr-FR'].current).toBe('Membres')
  })
})
