import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type Locale } from '../../../packages/domain/src/i18n'
import { nonEnLocales } from './families'

export const GUIDES_DIR = 'scripts/i18n/guides'
export const DEFAULT_GUIDE_PATH = `${GUIDES_DIR}/default.md`

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
)

export type GuidePaths = {
  baseline: string
  locales: Record<string, string>
}

export type GuideValidationOptions = {
  /** Project root containing scripts/i18n/guides. */
  root?: string
  /** Validate and return only these locale guides. */
  locales?: readonly Locale[]
  /** Also reject missing/orphan locale files in the complete guide inventory. */
  requireInventory?: boolean
}

function guidePath(locale: Locale): string {
  return `${GUIDES_DIR}/${locale}.md`
}

function absolutePath(root: string, relativePath: string): string {
  return join(root, ...relativePath.split('/'))
}

function defaultProjectRoot(): string {
  return existsSync(join(process.cwd(), GUIDES_DIR))
    ? process.cwd()
    : REPOSITORY_ROOT
}

function isUnfinishedGuide(text: string): boolean {
  return /\b(?:TODO|TBD|FILL\s+IN)\b/i.test(text)
}

async function assertGuideFile(
  root: string,
  relativePath: string,
  label: string,
): Promise<void> {
  const path = absolutePath(root, relativePath)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new Error(`missing ${label} guide: ${relativePath}`)
  }
  if (text.trim().length === 0) {
    throw new Error(`${label} guide is empty: ${relativePath}`)
  }
  if (isUnfinishedGuide(text)) {
    throw new Error(`${label} guide is unfinished: ${relativePath}`)
  }
}

/** Validate a completed guide supplied to init-locale. */
export async function assertCompletedGuide(path: string): Promise<void> {
  if (!path.toLowerCase().endsWith('.md')) {
    throw new Error(`guide file must be Markdown (.md): ${path}`)
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new Error(`guide file does not exist: ${path}`)
  }
  if (text.trim().length === 0) {
    throw new Error(`guide file is empty: ${path}`)
  }
  if (isUnfinishedGuide(text)) {
    throw new Error(`guide file is unfinished: ${path}`)
  }
}

/**
 * Ensure the repository has one baseline and one locale guide for every
 * registered non-en-US locale, with no stray Markdown guide files.
 */
export async function assertGuideInventory(
  root = defaultProjectRoot(),
): Promise<void> {
  await assertGuideFile(root, DEFAULT_GUIDE_PATH, 'baseline')

  const expected = new Set(nonEnLocales().map((locale) => `${locale}.md`))
  const directory = absolutePath(root, GUIDES_DIR)
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch {
    throw new Error(`translation guide directory is missing: ${GUIDES_DIR}`)
  }

  const actual = new Set(entries.filter((entry) => entry.endsWith('.md')))
  const missing = [...expected].filter((entry) => !actual.has(entry)).sort()
  const orphan = [...actual]
    .filter((entry) => entry !== 'default.md' && !expected.has(entry))
    .sort()
  if (missing.length > 0 || orphan.length > 0) {
    const details = [
      missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
      orphan.length > 0 ? `orphaned: ${orphan.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('; ')
    throw new Error(`translation guide inventory is out of sync (${details})`)
  }

  await Promise.all(
    nonEnLocales().map((locale) =>
      assertGuideFile(root, guidePath(locale), locale),
    ),
  )
}

/**
 * Validate the guides needed by a command and return repo-relative paths for
 * prompts and machine-readable CLI output.
 */
export async function getGuidePaths(
  opts: GuideValidationOptions = {},
): Promise<GuidePaths> {
  const root = opts.root ?? defaultProjectRoot()
  const targetLocales = opts.locales
    ? [...new Set(opts.locales)]
    : nonEnLocales()

  if (opts.requireInventory ?? !opts.locales) {
    await assertGuideInventory(root)
  } else {
    await assertGuideFile(root, DEFAULT_GUIDE_PATH, 'baseline')
    await Promise.all(
      targetLocales.map((locale) =>
        assertGuideFile(root, guidePath(locale), locale),
      ),
    )
  }

  const localePaths: Record<string, string> = {}
  for (const locale of targetLocales) {
    if (locale === 'en-US') continue
    localePaths[locale] = guidePath(locale)
  }
  return { baseline: DEFAULT_GUIDE_PATH, locales: localePaths }
}

/** Resolve a user-supplied --guide path relative to a project root. */
export function resolveGuideInput(root: string, path: string): string {
  return isAbsolute(path) ? path : join(root, path)
}
