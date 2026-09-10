import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { locales } from '../../../packages/domain/src/i18n'
import { initLocale } from './init-locale'
import {
  LOCALE_TO_FILE,
  auditMessages,
  diffMessages,
  nextTranslationBatch,
  packMessages,
  pruneLocale,
  setMessagesDir,
  setString,
  validateAllMessages,
} from './lib'

let dir: string

async function seedFile(locale: string, data: unknown) {
  await writeFile(join(dir, `${locale}.json`), JSON.stringify(data) + '\n')
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'i18n-sparse-'))
  await mkdir(dir, { recursive: true })
  setMessagesDir(dir)
  for (const locale of Object.keys(LOCALE_TO_FILE)) {
    await writeFile(join(dir, `${locale}.json`), '{}\n')
  }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('sparse overlay audit', () => {
  it('passes an override-only en-GB file with zero missing', async () => {
    await seedFile('en-US', { a: 'A', b: 'B' })
    await seedFile('en-GB', { a: 'A-GB' })
    const result = await auditMessages({
      locale: 'en-GB',
      readOldEn: async () => ({ a: 'A', b: 'B' }),
    })
    expect(result.summary.totalMissing).toBe(0)
    expect(result.locales['en-GB'].missingKeys).toEqual([])
    expect(result.locales['en-GB'].overrides).toBe(1)
    expect(result.locales['en-GB'].present).toBe(2)
  })

  it('covers pt-BR keys through the pt parent bundle', async () => {
    await seedFile('en-US', { a: 'A' })
    await seedFile('pt', { a: 'APT' })
    await seedFile('pt-BR', {})
    const result = await auditMessages({
      locale: 'pt-BR',
      readOldEn: async () => ({ a: 'A' }),
    })
    expect(result.summary.totalMissing).toBe(0)
    expect(result.locales['pt-BR'].overrides).toBe(0)
  })

  it('inherits through gaps in the parent bundle', async () => {
    // pt is behind on b, but pt-BR still resolves it via en-US.
    await seedFile('en-US', { a: 'A', b: 'B' })
    await seedFile('pt', { a: 'APT' })
    await seedFile('pt-BR', {})
    const result = await auditMessages({
      locale: 'pt-BR',
      readOldEn: async () => ({ a: 'A', b: 'B' }),
    })
    expect(result.locales['pt-BR'].missingKeys).toEqual([])
  })

  it('does not require inherited plural forms', async () => {
    const enUS = Object.fromEntries(
      ['zero', 'one', 'two', 'few', 'many', 'other'].map((suffix) => [
        `k_${suffix}`,
        `{count} ${suffix}`,
      ]),
    )
    await seedFile('en-US', enUS)
    await seedFile('en-GB', {})
    const result = await validateAllMessages('en-GB')
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })
})

describe('sparse overlay set gate', () => {
  it('rejects en-GB values identical to the inherited en-US value', async () => {
    await seedFile('en-US', { a: 'A' })
    await seedFile('en-GB', {})
    await expect(setString('en-GB', 'a', 'A')).rejects.toThrow(
      /inherited value from en-US/,
    )
    await expect(setString('en-GB', 'a', 'A-GB')).resolves.toMatchObject({
      count: 1,
    })
  })

  it('allows pt-BR values that pin the pt parent wording', async () => {
    await seedFile('en-US', { a: 'A' })
    await seedFile('pt', { a: 'APT' })
    await seedFile('pt-BR', {})
    await expect(setString('pt-BR', 'a', 'APT')).resolves.toMatchObject({
      count: 1,
    })
  })

  it('still rejects English copies in sparse locales', async () => {
    await seedFile('en-US', { a: 'Remove participant?' })
    await seedFile('pt', {})
    await seedFile('pt-BR', {})
    await expect(
      setString('pt-BR', 'a', 'Remove participant?'),
    ).rejects.toThrow(/English/)
  })
})

describe('pruneLocale', () => {
  it('dry-runs by default and lists inheritable keys', async () => {
    await seedFile('en-US', { same: 'S', diff: 'D', onlyEn: 'E' })
    await seedFile('en-GB', { same: 'S', diff: 'D-GB', extra: 'X' })
    const result = await pruneLocale('en-GB')
    expect(result.against).toBe('en-US')
    expect(result.identical).toEqual(['same'])
    expect(result.kept).toBe(2)
    expect(result.removed).toBe(1)
    expect(result.written).toBe(false)
    // Dry run leaves the file untouched.
    expect(JSON.parse(await readFile(join(dir, 'en-GB.json'), 'utf8'))).toEqual(
      { same: 'S', diff: 'D-GB', extra: 'X' },
    )
  })

  it('removes identical keys against an explicit parent', async () => {
    await seedFile('en-US', { a: 'A' })
    await seedFile('pt', { a: 'APT', b: 'BPT' })
    await seedFile('pt-BR', { a: 'APT', b: 'BBR' })
    const result = await pruneLocale('pt-BR', {
      against: 'pt',
      write: true,
    })
    expect(result.identical).toEqual(['a'])
    expect(result.written).toBe(true)
    expect(JSON.parse(await readFile(join(dir, 'pt-BR.json'), 'utf8'))).toEqual(
      { b: 'BBR' },
    )
  })
})

describe('sparse overlay diff and pack', () => {
  it('reports inherited changed keys as covered, not missing', async () => {
    await seedFile('en-US', { a: 'A2' })
    await seedFile('en-GB', {})
    const result = await diffMessages({
      locale: 'en-GB',
      readOldEn: async () => ({ a: 'A1' }),
    })
    expect(result.translationWork['en-GB'].missing).toEqual([])
    expect(result.translationWork['en-GB'].covered).toEqual(['a'])
  })

  it('hides inherited keys from missing-queue packs', async () => {
    await seedFile('en-US', { a: 'A', b: 'B' })
    await seedFile('en-GB', { a: 'A-GB' })
    const result = await packMessages({ locale: 'en-GB' })
    expect(result.total).toBe(0)
    expect(result.keys).toEqual([])
  })

  it('keeps inherited keys for review in changes-only packs', async () => {
    await seedFile('en-US', { a: 'A', b: 'B' })
    await seedFile('en-GB', { a: 'A-GB' })
    const result = await packMessages({
      locale: 'en-GB',
      changesOnly: true,
      readOldEn: async () => ({}),
    })
    // a is stored and current; b is inherited — both introduced, only b
    // needs a (possible) override decision.
    expect(result.total).toBe(1)
    const inherited = result.keys.find((k) => k.key === 'b')
    expect(inherited?.byLocale?.['en-GB']?.status).toBe('ok')
    expect(inherited?.byLocale?.['en-GB']?.current).toBeNull()
  })

  it('auto-includes the parent bundle as a ref', async () => {
    await seedFile('en-US', { a: 'A' })
    await seedFile('pt', { a: 'APT' })
    await seedFile('pt-BR', {})
    const result = await packMessages({
      locale: 'pt-BR',
      keys: ['a'],
    })
    expect(result.refs).toContain('pt')
    expect(result.keys[0].values['pt']).toBe('APT')
  })

  it('reports done for fully covered overlays', async () => {
    await seedFile('en-US', { a: 'A' })
    await seedFile('en-GB', {})
    const result = await nextTranslationBatch({ locale: 'en-GB' })
    expect(result.done).toBe(true)
    expect(result.remaining).toBe(0)
  })
})

describe('initLocale sparse overlays', () => {
  it('registers a fallback entry and starts with an empty file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'i18n-init-sparse-'))
    await mkdir(join(root, 'packages/domain/src'), { recursive: true })
    await mkdir(join(root, 'apps/web/src/components'), { recursive: true })
    await mkdir(join(root, 'apps/web/src/messages'), { recursive: true })
    await mkdir(join(root, 'scripts/i18n/src'), { recursive: true })
    await mkdir(join(root, 'scripts/i18n/guides'), { recursive: true })
    await writeFile(
      join(root, 'packages/domain/src/i18n.ts'),
      "export const localeLabels = { 'en-US': 'English' } as const\n" +
        'export const localeFallbacks = {} as const\n',
    )
    await writeFile(
      join(root, 'apps/web/src/components/locale-switcher-data.ts'),
      "export const localeFlags = { 'en-US': '🇺🇸' } as const\n",
    )
    await writeFile(
      join(root, 'scripts/i18n/src/families.ts'),
      "export const LANGUAGE_FAMILIES = [{ id: 'germanic', locales: ['de-DE'] }]\n",
    )
    await writeFile(join(root, 'apps/web/src/messages/en-US.json'), '{}\n')
    await writeFile(join(root, 'new-guide.md'), '# xx guide\nUse x.\n')

    const result = await initLocale({
      code: 'xx',
      label: 'Test',
      flag: '🏳️',
      family: 'germanic',
      guide: 'new-guide.md',
      root,
      sparse: true,
      fallback: 'pt',
    })
    expect(result.filesTouched).toContain('packages/domain/src/i18n.ts')
    await expect(
      readFile(join(root, 'packages/domain/src/i18n.ts'), 'utf8'),
    ).resolves.toContain(`xx: ['pt']`)
    await expect(
      readFile(join(root, 'apps/web/src/messages/xx.json'), 'utf8'),
    ).resolves.toBe('{}\n')
    expect(result.nextSteps.join('\n')).toContain('Sparse overlay')
    await rm(root, { recursive: true, force: true })
  })

  it('rejects --fallback without --sparse', async () => {
    await expect(
      initLocale({
        code: 'zz',
        label: 'Test',
        flag: '🏳️',
        family: 'romance',
        guide: 'scripts/i18n/guides/default.md',
        fallback: 'pt',
      }),
    ).rejects.toThrow('--fallback requires --sparse')
  })
})

describe('sparse locale inventory', () => {
  it('tracks exactly the migrated overlays', () => {
    expect(locales.filter((l) => ['en-GB', 'pt-BR'].includes(l))).toHaveLength(
      2,
    )
  })
})
