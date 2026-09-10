import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  classifyEnglishIdentity,
  isAutoAllowedEnglishIdentity,
} from './english-identity'
import {
  assertCompletedGuide,
  assertGuideInventory,
  getGuidePaths,
} from './guides'
import { addRtlLocale, initLocale, insertObjectEntry } from './init-locale'
import {
  LOCALE_TO_FILE,
  getKeysAcrossLocales,
  packMessages,
  setMessagesDir,
  setString,
  setStrings,
} from './lib'
import { findUsages, usageSearchKey } from './usages'

describe('translation guides', () => {
  it('keeps one completed guide per non-en-US locale', async () => {
    await expect(assertGuideInventory()).resolves.toBeUndefined()
    const paths = await getGuidePaths({
      locales: ['fr-FR', 'en-GZ'],
    })
    expect(paths.baseline).toBe('scripts/i18n/guides/default.md')
    expect(paths.locales).toEqual({
      'fr-FR': 'scripts/i18n/guides/fr-FR.md',
      'en-GZ': 'scripts/i18n/guides/en-GZ.md',
    })
  })

  it('rejects missing, non-Markdown, and unfinished guide inputs', async () => {
    await expect(
      assertCompletedGuide('/tmp/does-not-exist.md'),
    ).rejects.toThrow('guide file does not exist')
    await expect(assertCompletedGuide('/tmp/guide.txt')).rejects.toThrow(
      'must be Markdown',
    )

    const dir = await mkdtemp(join(tmpdir(), 'i18n-guide-'))
    const file = join(dir, 'guide.md')
    await writeFile(file, '# TODO\n')
    await expect(assertCompletedGuide(file)).rejects.toThrow('unfinished')
    await rm(dir, { recursive: true, force: true })
  })

  it('copies a completed guide when initializing a locale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'i18n-init-guide-'))
    await mkdir(join(root, 'packages/domain/src'), { recursive: true })
    await mkdir(join(root, 'apps/web/src/components'), { recursive: true })
    await mkdir(join(root, 'apps/web/src/messages'), { recursive: true })
    await mkdir(join(root, 'scripts/i18n/src'), { recursive: true })
    await mkdir(join(root, 'scripts/i18n/guides'), { recursive: true })
    await writeFile(
      join(root, 'packages/domain/src/i18n.ts'),
      "export const localeLabels = { 'en-US': 'English' } as const\n",
    )
    await writeFile(
      join(root, 'apps/web/src/components/locale-switcher-data.ts'),
      "export const localeFlags = { 'en-US': '🇺🇸' } as const\n",
    )
    await writeFile(
      join(root, 'scripts/i18n/src/families.ts'),
      "export const LANGUAGE_FAMILIES = [{ id: 'romance', locales: ['ca'] }]\n",
    )
    await writeFile(join(root, 'apps/web/src/messages/en-US.json'), '{}\n')
    await writeFile(
      join(root, 'new-guide.md'),
      '# zz guide\nUse neutral wording.\n',
    )

    const result = await initLocale({
      code: 'zz',
      label: 'Test',
      flag: '🏳️',
      family: 'romance',
      guide: 'new-guide.md',
      root,
    })
    expect(result.filesTouched).toContain('scripts/i18n/guides/zz.md')
    await expect(
      readFile(join(root, 'scripts/i18n/guides/zz.md'), 'utf8'),
    ).resolves.toContain('Use neutral wording')
    await rm(root, { recursive: true, force: true })
  })
})

describe('english-identity', () => {
  it('auto-allows brands, urls, and placeholder-only templates', () => {
    expect(isAutoAllowedEnglishIdentity('GitHub')).toBe(true)
    expect(isAutoAllowedEnglishIdentity('Spliit')).toBe(true)
    expect(isAutoAllowedEnglishIdentity('https://spliit.app/groups/…')).toBe(
      true,
    )
    expect(isAutoAllowedEnglishIdentity('1 {source} = {rate} {target}')).toBe(
      true,
    )
  })

  it('rejects sentence-like English copies without the flag', () => {
    const result = classifyEnglishIdentity(
      'Remove participant?',
      'Remove participant?',
    )
    expect(result).toEqual({ identical: true, allowed: false })
  })

  it('allows identical English when --allow-english is set', () => {
    const result = classifyEnglishIdentity('Remove', 'Remove', {
      allowEnglish: true,
    })
    expect(result).toEqual({
      identical: true,
      allowed: true,
      reason: 'flag',
    })
  })

  it('treats different values as not identical', () => {
    expect(classifyEnglishIdentity('Remove', 'Supprimer')).toEqual({
      identical: false,
    })
  })
})

describe('setStrings / english guard', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'i18n-set-'))
    await mkdir(dir, { recursive: true })
    setMessagesDir(dir)
    for (const locale of Object.keys(LOCALE_TO_FILE)) {
      await writeFile(join(dir, `${locale}.json`), '{}\n')
    }
    await writeFile(
      join(dir, 'en-US.json'),
      JSON.stringify(
        {
          title: 'Remove participant?',
          brand: 'GitHub',
          fmt: '1 {source} = {rate} {target}',
        },
        null,
        2,
      ) + '\n',
    )
    await writeFile(join(dir, 'fr-FR.json'), '{}\n')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('rejects identical English on set', async () => {
    await expect(
      setString('fr-FR', 'title', 'Remove participant?'),
    ).rejects.toThrow(/refusing to set title/)
  })

  it('accepts identical English with --allow-english', async () => {
    const result = await setString('fr-FR', 'title', 'Remove participant?', {
      allowEnglish: true,
    })
    expect(result.allowEnglishKeys).toEqual(['title'])
    const data = JSON.parse(await readFile(join(dir, 'fr-FR.json'), 'utf8'))
    expect(data.title).toBe('Remove participant?')
  })

  it('auto-allows brands without the flag', async () => {
    await setString('fr-FR', 'brand', 'GitHub')
    const data = JSON.parse(await readFile(join(dir, 'fr-FR.json'), 'utf8'))
    expect(data.brand).toBe('GitHub')
  })

  it('batch set writes all keys and dry-run does not write', async () => {
    const dry = await setStrings(
      'fr-FR',
      { title: 'Supprimer le participant ?', brand: 'GitHub' },
      { dryRun: true },
    )
    expect(dry.count).toBe(2)
    expect(dry.dryRun).toBe(true)
    expect(JSON.parse(await readFile(join(dir, 'fr-FR.json'), 'utf8'))).toEqual(
      {},
    )

    const written = await setStrings('fr-FR', {
      title: 'Supprimer le participant ?',
      brand: 'GitHub',
    })
    expect(written.count).toBe(2)
    const data = JSON.parse(await readFile(join(dir, 'fr-FR.json'), 'utf8'))
    expect(data.title).toBe('Supprimer le participant ?')
    expect(data.brand).toBe('GitHub')
  })

  it('batch set rejects if any entry is untranslated English', async () => {
    await expect(
      setStrings('fr-FR', {
        title: 'Remove participant?',
        brand: 'GitHub',
      }),
    ).rejects.toThrow(/refusing to set title/)
  })
})

describe('packMessages', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'i18n-pack-'))
    await mkdir(dir, { recursive: true })
    setMessagesDir(dir)
    for (const locale of Object.keys(LOCALE_TO_FILE)) {
      await writeFile(join(dir, `${locale}.json`), '{}\n')
    }
    await writeFile(
      join(dir, 'en-US.json'),
      JSON.stringify(
        {
          Members: {
            title: 'Members',
            remove: 'Remove participant?',
          },
        },
        null,
        2,
      ) + '\n',
    )
    await writeFile(
      join(dir, 'es.json'),
      JSON.stringify(
        {
          Members: {
            title: 'Miembros',
            remove: '¿Eliminar participante?',
          },
        },
        null,
        2,
      ) + '\n',
    )
    await writeFile(
      join(dir, 'fr-FR.json'),
      JSON.stringify({ Members: { title: 'Membres' } }, null, 2) + '\n',
    )
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('packs missing keys with en, refs, neighbors, and limit', async () => {
    const result = await packMessages({
      locale: 'fr-FR',
      refs: ['es'],
      limit: 10,
    })
    expect(result.total).toBe(1)
    expect(result.keys).toHaveLength(1)
    expect(result.keys[0]).toMatchObject({
      key: 'Members.remove',
      en: 'Remove participant?',
      values: { es: '¿Eliminar participante?' },
    })
    expect(result.keys[0].neighbors['Members.title']).toBe('Membres')
  })

  it('changesOnly filters to introduced keys', async () => {
    const result = await packMessages({
      locale: 'fr-FR',
      changesOnly: true,
      readOldEn: async () => ({
        Members: { title: 'Members', remove: 'Remove participant?' },
      }),
    })
    expect(result.total).toBe(0)
    expect(result.keys).toEqual([])
  })
})

describe('getKeysAcrossLocales', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'i18n-get-'))
    setMessagesDir(dir)
    for (const locale of Object.keys(LOCALE_TO_FILE)) {
      await writeFile(join(dir, `${locale}.json`), '{}\n')
    }
    await writeFile(
      join(dir, 'en-US.json'),
      JSON.stringify({ hello: 'Hello' }, null, 2) + '\n',
    )
    await writeFile(
      join(dir, 'fr-FR.json'),
      JSON.stringify({ hello: 'Bonjour' }, null, 2) + '\n',
    )
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns per-locale values with null for missing', async () => {
    const result = await getKeysAcrossLocales(
      ['hello', 'missing'],
      ['en-US', 'fr-FR', 'de-DE'],
    )
    expect(result).toEqual({
      hello: { 'en-US': 'Hello', 'fr-FR': 'Bonjour', 'de-DE': null },
      missing: { 'en-US': null, 'fr-FR': null, 'de-DE': null },
    })
  })
})

describe('usages', () => {
  it('strips plural suffixes for search', () => {
    expect(usageSearchKey('previewWillCreate_one')).toBe('previewWillCreate')
    expect(usageSearchKey('Members.title')).toBe('Members.title')
  })

  it('finds full-key and keyPrefix+relative usages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'i18n-usages-'))
    const fileA = join(root, 'full.tsx')
    const fileB = join(root, 'prefixed.tsx')
    await writeFile(
      fileA,
      `export function A() {\n  return <Trans i18nKey="Homepage.title" />\n}\n`,
    )
    await writeFile(
      fileB,
      `const { t } = useTranslation(undefined, { keyPrefix: 'Members' })\n` +
        `export function B() {\n  return t('removeDialog.title')\n}\n`,
    )

    const homepage = await findUsages('Homepage.title', {
      root,
      projectRoot: root,
    })
    expect(homepage.some((h) => h.snippet.includes('Homepage.title'))).toBe(
      true,
    )

    const members = await findUsages('Members.removeDialog.title', {
      root,
      projectRoot: root,
    })
    expect(
      members.some((h) => h.snippet.includes("t('removeDialog.title')")),
    ).toBe(true)

    await rm(root, { recursive: true, force: true })
  })
})

describe('init-locale helpers', () => {
  it('inserts object entries in sorted order', () => {
    const source = `export const localeLabels = {
  'en-US': 'English (US)',
  es: 'Español',
} as const
`
    const next = insertObjectEntry(
      source,
      'export const localeLabels',
      'de-DE',
      "'Deutsch'",
    )
    expect(next).toContain("'de-DE': 'Deutsch'")
    const de = next.indexOf("'de-DE'")
    const en = next.indexOf("'en-US'")
    const es = next.indexOf('es:')
    expect(de).toBeGreaterThan(-1)
    expect(de).toBeLessThan(en)
    expect(en).toBeLessThan(es)
  })

  it('adds RTL locales to RTL_LOCALES set', () => {
    const source = `const RTL_LOCALES = new Set(['he'])

export function I18nProvider() {
  document.documentElement.dir = RTL_LOCALES.has(locale) ? 'rtl' : 'ltr'
}
`
    const next = addRtlLocale(source, 'ar')
    expect(next).toContain("'he', 'ar'")
  })
})
