import type { TFunction } from 'i18next'

import type { DelimitedRowIssue, ImportDetection } from '@spliit/domain/import'

/**
 * UI-side lookups for stable backend message codes. Every resolver below falls
 * back to the raw English message when the code has no key yet, so
 * unknown/future codes never render blank or crash. Interpolation uses single
 * braces (`{name}`); none of the current messages need plural variants (their
 * counts are embedded numerals without singular/plural alternation), and no
 * param is ever named `count` so i18next plural resolution never triggers.
 *
 * Backend codes are dynamic (`ExpenseImport.issues.${code}`), so they cannot be
 * part of the generated static key union the way the existing literal keys are.
 * The cast below is contained to this helper; `defaultValue` guarantees the
 * English fallback when a key has not been added centrally yet.
 */
type I18nKey = Parameters<TFunction>[0]

function translateCoded(
  t: TFunction,
  key: string,
  params: Record<string, string | number> | undefined,
  fallback: string,
): string {
  const translated = t(key as I18nKey, { ...params, defaultValue: fallback })
  return typeof translated === 'string' && translated ? translated : fallback
}

/** Row issues render via `ExpenseImport.issues.<code>`. */
export function translateImportIssue(
  issue: Pick<DelimitedRowIssue, 'code' | 'message' | 'params'>,
  t: TFunction,
): string {
  return translateCoded(
    t,
    `ExpenseImport.issues.${issue.code}`,
    issue.params,
    issue.message,
  )
}

/** Inference detections render via `ExpenseImport.detections.<code>`. */
export function translateImportDetection(
  entry: Pick<ImportDetection, 'code' | 'message' | 'params'>,
  t: TFunction,
): string {
  return translateCoded(
    t,
    `ExpenseImport.detections.${entry.code}`,
    entry.params,
    entry.message,
  )
}

type CodedCause = { code?: unknown; params?: unknown }

/**
 * Resolve a thrown import failure for the wizard error Alert. Prefers the
 * stable code forwarded by the API error formatter
 * (`error.data.importCode`/`importParams` over HTTP, `cause.code`/`params` for
 * in-process callers and domain parse failures thrown with `new Error(message,
 * { cause })`), translated via `ExpenseImport.apiErrors.<code>` (tRPC) or
 * `ExpenseImport.parseErrors.<code>` (domain parse path). Anything else —
 * worker transport errors, mapping validation throws, uncoded upstreams — falls
 * back to the raw English message.
 */
export function translateImportError(
  error: unknown,
  t: TFunction,
  fallbackMessage: string,
): string {
  const fallback =
    error instanceof Error && error.message ? error.message : fallbackMessage
  const shaped = error as {
    data?: { importCode?: unknown; importParams?: unknown }
    cause?: CodedCause | null
  } | null
  const apiCode = shaped?.data?.importCode
  if (typeof apiCode === 'string' && apiCode) {
    const params =
      shaped?.data?.importParams && typeof shaped.data.importParams === 'object'
        ? (shaped.data.importParams as Record<string, string | number>)
        : undefined
    return translateCoded(
      t,
      `ExpenseImport.apiErrors.${apiCode}`,
      params,
      fallback,
    )
  }
  const cause = shaped?.cause
  if (
    cause &&
    typeof cause === 'object' &&
    typeof cause.code === 'string' &&
    cause.code
  ) {
    const params =
      cause.params && typeof cause.params === 'object'
        ? (cause.params as Record<string, string | number>)
        : undefined
    // In-process callers (createCaller, tests) expose the same `{ code,
    // params }` pair on `cause` for both API and domain-parse failures, so
    // try both namespaces before falling back to English. The sentinel can
    // never collide with a real translation.
    const MISSING = '__missing_import_message__'
    for (const namespace of ['apiErrors', 'parseErrors'] as const) {
      const translated = t(
        `ExpenseImport.${namespace}.${cause.code}` as I18nKey,
        {
          ...params,
          defaultValue: MISSING,
        },
      )
      if (
        typeof translated === 'string' &&
        translated !== MISSING &&
        translated
      ) {
        return translated
      }
    }
  }
  return fallback
}
