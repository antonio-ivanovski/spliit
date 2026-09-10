import { execSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { locales, type Locale } from '../../../packages/domain/src/i18n'

/** Filename for a locale message file — always `<locale>.json`. */
export function localeFileName(locale: Locale): string {
  return `${locale}.json`
}

/** @deprecated Prefer localeFileName — kept as a Record for existing call sites. */
export const LOCALE_TO_FILE: Record<Locale, string> = Object.fromEntries(
  locales.map((locale) => [locale, localeFileName(locale)]),
) as Record<Locale, string>

let messagesDir: string = join(process.cwd(), 'apps/web/src/messages')

export function getMessagesDir(): string {
  return messagesDir
}

export function setMessagesDir(dir: string): void {
  messagesDir = dir
}

function fileFor(locale: Locale): string {
  return join(messagesDir, localeFileName(locale))
}

function gitPathFor(locale: Locale): string {
  return `apps/web/src/messages/${localeFileName(locale)}`
}

export async function readMessagesFile(
  locale: Locale,
): Promise<Record<string, unknown>> {
  const content = await readFile(fileFor(locale), 'utf8')
  return JSON.parse(content)
}

export async function writeMessagesFile(
  locale: Locale,
  data: Record<string, unknown>,
): Promise<void> {
  const content = JSON.stringify(data, null, 2) + '\n'
  await writeFile(fileFor(locale), content)
}

export async function readGitBlob(
  ref: string,
  locale: Locale,
): Promise<Record<string, unknown> | null> {
  const relPath = gitPathFor(locale)
  try {
    const content = execSync(`git show ${ref}:${relPath}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return JSON.parse(content)
  } catch {
    return null
  }
}

export async function readStagedBlob(
  locale: Locale,
): Promise<Record<string, unknown> | null> {
  const relPath = gitPathFor(locale)
  try {
    const content = execSync(`git show :${relPath}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return JSON.parse(content)
  } catch {
    return null
  }
}
