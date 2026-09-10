import { access, copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { locales, type Locale } from '../../../packages/domain/src/i18n'
import { LANGUAGE_FAMILIES } from './families'
import { localeFileName } from './fs-helpers'
import { GUIDES_DIR, assertCompletedGuide, resolveGuideInput } from './guides'

const DOMAIN_I18N = 'packages/domain/src/i18n.ts'
const LOCALE_SWITCHER = 'apps/web/src/components/locale-switcher-data.ts'
const I18N_REACT = 'apps/web/src/i18n/react.tsx'
const FAMILIES_FILE = 'scripts/i18n/src/families.ts'
const MESSAGES_DIR = 'apps/web/src/messages'

export type InitLocaleOptions = {
  code: string
  label: string
  flag: string
  /** Language family id from LANGUAGE_FAMILIES (required for plan dispatch). */
  family: string
  /** Completed Markdown locale guide to copy into scripts/i18n/guides. */
  guide: string
  rtl?: boolean
  from?: Locale
  /**
   * Start as a sparse overlay (empty message file, inherits everything).
   * Requires fallback resolution — defaults to en-US.
   */
  sparse?: boolean
  /** Direct fallback parent for a sparse overlay (e.g. en-GB for en-AU). */
  fallback?: string
  /** Project root (defaults to cwd). */
  root?: string
}

export type InitLocaleResult = {
  code: string
  family: string
  filesTouched: string[]
  nextSteps: string[]
}

function assertValidLocaleCode(code: string): void {
  if (code === 'en-US') {
    throw new Error('cannot init en-US (it is the source of truth)')
  }
  if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(code)) {
    throw new Error(
      `invalid locale code "${code}" — expected like "sv" or "sv-SE"`,
    )
  }
  if ((locales as readonly string[]).includes(code)) {
    throw new Error(`locale "${code}" already exists`)
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Insert a `key: value` entry into an object literal that uses `as const` /
 * `satisfies`, keeping approximate alphabetical order by key string.
 */
export function insertObjectEntry(
  source: string,
  objectStartMarker: string,
  key: string,
  valueLiteral: string,
): string {
  const start = source.indexOf(objectStartMarker)
  if (start < 0) {
    throw new Error(`could not find object marker: ${objectStartMarker}`)
  }

  // Find the opening `{` after the marker
  const brace = source.indexOf('{', start)
  if (brace < 0) throw new Error('object brace not found')

  let depth = 0
  let end = -1
  for (let i = brace; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) throw new Error('unclosed object literal')

  const body = source.slice(brace + 1, end)
  const lines = body.split('\n')
  const entryLines = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^\s*['"]?[A-Za-z]/.test(line))

  const newKeyQuoted = key.includes('-') ? `'${key}'` : key
  const newLine = `  ${newKeyQuoted}: ${valueLiteral},`

  // Insert before the first existing key that sorts after `key`
  let insertAt = lines.length
  for (const { line, index } of entryLines) {
    const match = /^\s*(['"]?)([^'":]+)\1\s*:/.exec(line)
    if (!match) continue
    const existing = match[2]
    if (existing.localeCompare(key) > 0) {
      insertAt = index
      break
    }
  }

  // If inserting at end of body, ensure previous last entry has a comma
  const nextLines = [...lines]
  if (insertAt === lines.length) {
    // find last non-empty line in body and ensure trailing comma
    for (let i = nextLines.length - 1; i >= 0; i--) {
      if (nextLines[i].trim().length === 0) continue
      if (/,\s*$/.test(nextLines[i])) break
      if (/^\s*\}/.test(nextLines[i])) continue
      nextLines[i] = nextLines[i].replace(/\s*$/, ',')
      break
    }
    nextLines.push(newLine)
  } else {
    nextLines.splice(insertAt, 0, newLine)
  }

  return source.slice(0, brace + 1) + nextLines.join('\n') + source.slice(end)
}

export function addRtlLocale(source: string, code: string): string {
  // Prefer a Set/array named RTL_LOCALES; fall back to legacy `locale === 'he'`.
  if (/RTL_LOCALES/.test(source)) {
    if (source.includes(`'${code}'`) || source.includes(`"${code}"`)) {
      return source
    }
    return source.replace(
      /(RTL_LOCALES\s*=\s*(?:new Set\()?\[)([^\]]*)(\])/,
      (_m, open: string, body: string, close: string) => {
        const trimmed = body.trim()
        const addition =
          trimmed.length === 0
            ? `'${code}'`
            : `${trimmed.replace(/,\s*$/, '')}, '${code}'`
        return `${open}${addition}${close}`
      },
    )
  }

  // Migrate hardcoded he check to a set including the new code.
  if (/locale === 'he'/.test(source) || /locale === "he"/.test(source)) {
    const members = code === 'he' ? `'he'` : `'he', '${code}'`
    return source
      .replace(
        /document\.documentElement\.dir = locale === ['"]he['"] \? 'rtl' : 'ltr'/,
        `document.documentElement.dir = RTL_LOCALES.has(locale) ? 'rtl' : 'ltr'`,
      )
      .replace(
        /(export function I18nProvider)/,
        `const RTL_LOCALES = new Set([${members}])\n\n$1`,
      )
  }

  throw new Error('could not update RTL locale handling in react.tsx')
}

/** Insert a locale code into a family's locales: [...] array in families.ts. */
export function addLocaleToFamilySource(
  source: string,
  familyId: string,
  code: string,
): string {
  const familyStart = source.indexOf(`id: '${familyId}'`)
  if (familyStart < 0) {
    throw new Error(`unknown language family: ${familyId}`)
  }
  const localesKey = source.indexOf('locales:', familyStart)
  if (localesKey < 0) throw new Error(`locales array not found for ${familyId}`)
  const bracket = source.indexOf('[', localesKey)
  const endBracket = source.indexOf(']', bracket)
  if (bracket < 0 || endBracket < 0) {
    throw new Error(`locales array brackets not found for ${familyId}`)
  }
  const body = source.slice(bracket + 1, endBracket)
  if (body.includes(`'${code}'`) || body.includes(`"${code}"`)) {
    return source
  }
  const entries = body
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^['"]|['"]$/g, ''))
  entries.push(code)
  entries.sort((a, b) => a.localeCompare(b))
  const rendered = entries.map((e) => `'${e}'`).join(', ')
  return source.slice(0, bracket + 1) + rendered + source.slice(endBracket)
}

export async function initLocale(
  opts: InitLocaleOptions,
): Promise<InitLocaleResult> {
  assertValidLocaleCode(opts.code)
  if (opts.from && !(locales as readonly string[]).includes(opts.from)) {
    throw new Error(`unknown --from locale: ${opts.from}`)
  }
  const sparse = !!opts.sparse
  if (opts.fallback && !sparse) {
    throw new Error('--fallback requires --sparse')
  }
  if (opts.from && sparse) {
    throw new Error('--from and --sparse are mutually exclusive')
  }
  if (opts.fallback) {
    if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(opts.fallback)) {
      throw new Error(
        `invalid --fallback locale "${opts.fallback}" — expected like "pt" or "en-GB"`,
      )
    }
    if (!(locales as readonly string[]).includes(opts.fallback)) {
      throw new Error(`unknown --fallback locale: ${opts.fallback}`)
    }
    if (opts.fallback === opts.code) {
      throw new Error('--fallback must differ from the new locale code')
    }
  }
  const familyIds = LANGUAGE_FAMILIES.map((f) => f.id)
  if (!familyIds.includes(opts.family)) {
    throw new Error(
      `unknown --family ${opts.family} — expected one of: ${familyIds.join(', ')}`,
    )
  }

  const root = opts.root ?? process.cwd()
  const filesTouched: string[] = []
  const messageRel = `${MESSAGES_DIR}/${opts.code}.json`
  const messagePath = join(root, messageRel)
  const guideRel = `${GUIDES_DIR}/${opts.code}.md`
  const guidePath = join(root, ...guideRel.split('/'))
  const guideInput = resolveGuideInput(root, opts.guide)

  await assertCompletedGuide(guideInput)
  if (await pathExists(messagePath)) {
    throw new Error(`message file already exists: ${messageRel}`)
  }
  if (await pathExists(guidePath)) {
    throw new Error(`translation guide already exists: ${guideRel}`)
  }

  // 1. domain localeLabels (+ localeFallbacks for sparse overlays)
  const domainPath = join(root, DOMAIN_I18N)
  const domainSrc = await readFile(domainPath, 'utf8')
  let domainNext = insertObjectEntry(
    domainSrc,
    'export const localeLabels',
    opts.code,
    `'${opts.label.replace(/'/g, "\\'")}'`,
  )
  if (sparse) {
    domainNext = insertObjectEntry(
      domainNext,
      'export const localeFallbacks',
      opts.code,
      `['${opts.fallback ?? 'en-US'}']`,
    )
  }
  await writeFile(domainPath, domainNext, 'utf8')
  filesTouched.push(DOMAIN_I18N)

  // 2. message file
  if (opts.from) {
    await copyFile(
      join(root, MESSAGES_DIR, localeFileName(opts.from)),
      messagePath,
    )
  } else {
    await writeFile(messagePath, '{}\n', 'utf8')
  }
  filesTouched.push(messageRel)

  // 3. locale-specific translation guide
  await copyFile(guideInput, guidePath)
  filesTouched.push(guideRel)

  // 4. localeFlags
  const switcherPath = join(root, LOCALE_SWITCHER)
  const switcherSrc = await readFile(switcherPath, 'utf8')
  const switcherNext = insertObjectEntry(
    switcherSrc,
    'export const localeFlags',
    opts.code,
    `'${opts.flag.replace(/'/g, "\\'")}'`,
  )
  await writeFile(switcherPath, switcherNext, 'utf8')
  filesTouched.push(LOCALE_SWITCHER)

  // 5. language family (for plan dispatch + default refs)
  const familiesPath = join(root, FAMILIES_FILE)
  const familiesSrc = await readFile(familiesPath, 'utf8')
  const familiesNext = addLocaleToFamilySource(
    familiesSrc,
    opts.family,
    opts.code,
  )
  await writeFile(familiesPath, familiesNext, 'utf8')
  filesTouched.push(FAMILIES_FILE)

  // 6. optional RTL
  if (opts.rtl) {
    const reactPath = join(root, I18N_REACT)
    const reactSrc = await readFile(reactPath, 'utf8')
    const reactNext = addRtlLocale(reactSrc, opts.code)
    await writeFile(reactPath, reactNext, 'utf8')
    filesTouched.push(I18N_REACT)
  }

  const nextSteps = sparse
    ? [
        `Sparse overlay inheriting from ${opts.fallback ?? 'en-US'} — only set keys that genuinely differ.`,
        `bun i18n set ${opts.code} <path> "<value>"   # rejects values identical to the parent`,
        `bun i18n prune --locale ${opts.code}         # dry run: list inheritable keys`,
        `bun i18n check --locale ${opts.code}`,
      ]
    : [
        `Read ${guideRel} together with ${GUIDES_DIR}/default.md before translating.`,
        `bun i18n next --locale ${opts.code} --size 40 --usages --json`,
        `bun i18n set ${opts.code} --stdin   # fill applyTemplate / translate keys`,
        `# repeat next → set until next.done === true`,
        `bun i18n check --locale ${opts.code}`,
      ]

  return {
    code: opts.code,
    family: opts.family,
    filesTouched,
    nextSteps,
  }
}
