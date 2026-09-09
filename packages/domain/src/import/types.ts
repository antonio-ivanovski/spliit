export type NormalizedSourceParticipant = {
  sourceId: string
  sourceName: string
}

export type NormalizedSourceDocument = {
  sourceId: string
  sourceUrl: string
  width: number
  height: number
}

export type NormalizedSourceActivity = {
  time: string
  activityType:
    | 'UPDATE_GROUP'
    | 'CREATE_EXPENSE'
    | 'UPDATE_EXPENSE'
    | 'DELETE_EXPENSE'
  participantSourceId: string | null
  expenseSourceId: string | null
  data: string | null
}

/**
 * Interpolation params for a coded user-facing import message. Values are plain
 * scalars that survive worker structured-clone and superjson transport.
 * Suffix-style params (`receivedSuffix`, `titlePart`, `detail`) carry
 * preformatted English fragments (user file content, column labels) that are
 * intentionally not translated; single braces (`{name}`) match i18next
 * interpolation used by the web UI.
 */
export type ImportMessageParams = Record<string, string | number>

import type { RecurrenceFrequency } from '../enums'
import type { RecurrenceConfig, RecurrenceEnd } from '../recurring-expenses'

export type { RecurrenceConfig, RecurrenceEnd, RecurrenceFrequency }

export type NormalizedSourceExpense = {
  /** Stable upstream id used to reconnect imported activity subjects. */
  sourceId?: string | null
  /**
   * Stable upstream creation timestamp used only to recover spliit.app
   * documents.
   */
  sourceCreatedAt?: string | null
  title: string
  expenseDate: string
  category: string
  amountCurrency: string | null
  amount: number
  originalAmount: number | null
  originalCurrency: string | null
  conversionRate: number | null
  paidBySourceId: string
  paidBy: Array<{ sourceId: string; shares: number }>
  paidFor: Array<{ sourceId: string; shares: number }>
  splitMode: 'EVENLY' | 'BY_SHARES' | 'BY_PERCENTAGE' | 'BY_AMOUNT'
  /** Legacy alias retained for old import callers during the schema cutover. */
  recurrenceRule: 'NONE' | 'DAILY' | 'WEEKLY' | 'MONTHLY'
  recurrence?: RecurrenceConfig | null
  notes: string | null
  /** Present for export v3, including when the source array is empty. */
  sourceDocuments?: NormalizedSourceDocument[]
}

export type NormalizedSource = {
  provider: 'SPLIIT' | 'SPLITWISE'
  /** Null identifies the original unversioned spliit.app export. */
  exportVersion?: 3 | null
  sourceGroupId: string
  sourceUrl: string | null
  name: string
  information?: string | null
  currency: string
  currencyCode: string | null
  participants: NormalizedSourceParticipant[]
  expenses: NormalizedSourceExpense[]
  /** Derived from exportVersion, never inferred from document array contents. */
  documentSource?: 'EMBEDDED' | 'DISCOVERY' | 'NONE'
  /** Presence means the source supplied authoritative historical activity. */
  activities?: NormalizedSourceActivity[]
}

export type ImportParseResult =
  | { ok: true; source: NormalizedSource }
  | {
      ok: false
      error: string
      /**
       * Stable message identifier for UI translation. Kept alongside the
       * English `error` (tests/logs/compat depend on it). Absent only for fully
       * dynamic upstream passthroughs that have no static source text.
       */
      code?: string
      params?: ImportMessageParams
    }
