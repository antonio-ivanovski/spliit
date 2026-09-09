import * as z from 'zod'

import { categoryIdSchema } from './categories'
import {
  conversionSourceSchema,
  optionalExpenseConversionSchema,
} from './conversion'
import type { RecurrenceRule, SplitMode } from './enums'
import { itemsExceedExpenseAmount } from './itemized-expenses'
import { recurrenceConfigSchema } from './recurring-expenses'
import { MAX_STORED_SHARES, getDisplayShareErrorKey } from './shares'
import {
  parseTimeMinutes,
  timeZoneSchema,
  toSecondPrecision,
} from './timezones'

const groupFormFields = {
  name: z.string().min(2, { error: 'min2' }).max(50, { error: 'max50' }),
  information: z.string().optional(),
  currency: z.string().min(1, { error: 'min1' }).max(5, { error: 'max5' }),
  currencyCode: z
    .union([z.string().min(3).max(4).nullish(), z.literal('')])
    .describe(
      'ISO-4217 3-letter code or 3–4 char crypto ticker, or empty for custom',
    ),
  participants: z
    .array(
      z.object({
        id: z.string().optional(),
        name: z.string().min(2, { error: 'min2' }).max(50, { error: 'max50' }),
      }),
    )
    .min(1),
}

function validateGroupParticipants(
  { participants }: { participants: Array<{ name: string }> },
  ctx: z.RefinementCtx,
) {
  participants.forEach((participant, i) => {
    participants.slice(0, i).forEach((otherParticipant) => {
      if (otherParticipant.name === participant.name) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicateParticipantName',
          path: ['participants', i, 'name'],
        })
      }
    })
  })
}

export const groupFormSchema = z
  .object(groupFormFields)
  .superRefine(validateGroupParticipants)

export type GroupFormValues = z.infer<typeof groupFormSchema>

export const groupUpdateFormSchema = z
  .object(groupFormFields)
  .superRefine(validateGroupParticipants)

export type GroupUpdateFormValues = z.infer<typeof groupUpdateFormSchema>

// Friend-ledger creation form. The caller picks exactly one of three modes:
// known peer account, email (which may resolve to an existing account or a
// pending email invitation), or a shareable link. The exact-one invariant is
// enforced with a superRefine because Zod discriminated unions don't compose
// cleanly with `optional()` fields across all three paths.
export const friendFormSchema = z
  .object({
    peerAccountId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Exactly one of peerAccountId, peerEmail, or useLink must be set.',
      ),
    peerEmail: z.string().email().optional(),
    temporaryName: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe(
        "Required when useLink is true; used as the friend's display name until they sign up.",
      ),
    useLink: z
      .boolean()
      .optional()
      .describe(
        'Create via shareable link. Exactly one of peerAccountId, peerEmail, or useLink must be set.',
      ),
    currency: z.string().min(1),
    currencyCode: z.string().optional(),
    information: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    const modes = [
      !!data.peerAccountId,
      !!data.peerEmail,
      !!data.useLink,
    ].filter(Boolean).length
    if (modes !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Select exactly one: a friend, an email, or a shareable link.',
        path: ['peerAccountId'],
      })
    }
    if (data.useLink && !data.temporaryName?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'temporaryName is required for link invites',
        path: ['temporaryName'],
      })
    }
  })

export type FriendFormValues = z.infer<typeof friendFormSchema>

const splitModeValues = [
  'EVENLY',
  'BY_SHARES',
  'BY_PERCENTAGE',
  'BY_AMOUNT',
  'ITEMIZED',
] as const satisfies readonly [SplitMode, ...SplitMode[]]
const splitModeSchema = z.enum(splitModeValues).default('EVENLY')

const paidBySplitModeSchema = z.enum(splitModeValues).default('BY_AMOUNT')

const recurrenceRuleValues = [
  'NONE',
  'DAILY',
  'WEEKLY',
  'MONTHLY',
] as const satisfies readonly [RecurrenceRule, ...RecurrenceRule[]]
const recurrenceRuleSchema = z.enum(recurrenceRuleValues).default('NONE')

const documentsSchema = z
  .array(
    z.object({
      id: z.string(),
      url: z.string().url(),
      fileName: z.string().min(1).nullable().optional(),
      contentType: z.string().min(1).nullable().optional(),
      width: z.number().int().min(1).nullable().optional(),
      height: z.number().int().min(1).nullable().optional(),
    }),
  )
  .default([])

// Row shape used by the form schema. `shares` is a number in user-facing
// units of the selected expense currency (the same currency as `amount`),
// with the following per-mode meaning:
//   - BY_AMOUNT / ITEMIZED: currency major units
//   - BY_PERCENTAGE:        display percentage
//   - BY_SHARES:            display share (up to two decimal places)
//   - EVENLY:               inclusion marker (any non-zero means "in")
// Shares are stored as raw user input (string) and coerced to number
// at validation time, matching the main `amount` field. This lets
// BY_AMOUNT inputs preserve intermediate decimal states like "10."
// while typing.
const formPaidForRowSchema = z.object({
  participant: z.string(),
  // Zod 4 rejects NaN at the number type with a raw English message; key the
  // type error so the UI can translate it (a partial input like "-" coerces
  // to NaN before the mode-aware share refinement runs).
  shares: z.coerce.number({ error: 'invalidNumber' }),
})

const formPaidByRowSchema = z.object({
  participant: z.string(),
  shares: z.coerce.number({ error: 'invalidNumber' }),
})

// Row shape used by the API/domain schema. Shares are integers:
//   - BY_PERCENTAGE:  basis points (10000 = 100%)
//   - BY_AMOUNT / ITEMIZED: minor units of the expense currency
//   - BY_SHARES:      fixed share units (100 = 1 displayed share)
//   - EVENLY:         ignored / inclusion marker
// The per-mode valid range is enforced by `validatePaidForRow` /
// `validatePaidByRow` in the parent refinement because the row schema
// itself is polymorphic.
const apiPaidForRowSchema = z.object({
  participant: z.string(),
  shares: z
    .number()
    .int()
    .describe(
      'Integer units. Meaning depends on splitMode: basis points for BY_PERCENTAGE (10000=100%), minor units for BY_AMOUNT, fixed share units for BY_SHARES (100 = 1 displayed share).',
    ),
})

const apiPaidByRowSchema = z.object({
  participant: z.string(),
  shares: z
    .number()
    .int()
    .describe(
      'Integer units. Meaning depends on paidBySplitMode: basis points for BY_PERCENTAGE (10000=100%), minor units for BY_AMOUNT, fixed share units for BY_SHARES (100 = 1 displayed share).',
    ),
})

const itemSplitModeSchema = z
  .enum(['EVENLY', 'BY_SHARES', 'BY_PERCENTAGE', 'BY_AMOUNT'] as const)
  .default('EVENLY')

const itemFormPaidForRowSchema = z.object({
  participant: z.string(),
  shares: z.coerce.number({ error: 'invalidNumber' }),
})

const itemApiPaidForRowSchema = z.object({
  participant: z.string(),
  shares: z
    .number()
    .int()
    .describe(
      'Integer units. Meaning depends on the item splitMode: basis points for BY_PERCENTAGE (10000=100%), minor units for BY_AMOUNT, fixed share units for BY_SHARES (100 = 1 displayed share).',
    ),
})

const itemRowDuplicateGuard = (
  rows: Array<{ participant: string }>,
  ctx: z.RefinementCtx,
) => {
  const seen = new Set<string>()
  rows.forEach((row, i) => {
    if (seen.has(row.participant)) {
      ctx.addIssue({
        code: 'custom',
        message: 'duplicateParticipant',
        path: [i, 'participant'],
      })
    } else {
      seen.add(row.participant)
    }
  })
}

type ItemShareRow = { shares: number }

/**
 * Mode-aware magnitude validation for an itemized paid-for row. The row itself
 * is polymorphic; the parent schema knows the owning split mode and passes it
 * through. `BY_SHARES` rows are stored as positive fixed units (`1 ≤ shares ≤
 * MAX_STORED_SHARES`); negative values are never valid for paid-for/default
 * shares. `BY_AMOUNT` rows may be signed so discounts and negative items can be
 * allocated without changing the meaning of the other split modes.
 */
export function validateItemShareRow(
  row: ItemShareRow,
  splitMode: z.infer<typeof itemSplitModeSchema>,
  ctx: z.RefinementCtx,
  path: (string | number)[],
) {
  if (splitMode !== 'BY_SHARES') return
  if (row.shares < 1 || row.shares > MAX_STORED_SHARES) {
    ctx.addIssue({
      code: 'custom',
      message: 'sharesInvalid',
      path,
    })
  }
}

const validateItemShareTotal = (
  rows: ItemShareRow[],
  splitMode: z.infer<typeof itemSplitModeSchema>,
  targetAmount: number,
  ctx: z.RefinementCtx,
  path: (string | number)[],
  amountMessage: string,
  percentageMessage: string,
) => {
  if (rows.length === 0) return
  const sum = rows.reduce((total, { shares }) => total + shares, 0)
  if (splitMode === 'BY_AMOUNT' && sum !== targetAmount) {
    ctx.addIssue({ code: 'custom', message: amountMessage, path })
  } else if (splitMode === 'BY_PERCENTAGE' && sum !== 10000) {
    ctx.addIssue({ code: 'custom', message: percentageMessage, path })
  }
}

const validateDisplayItemShareTotal = (
  rows: ItemShareRow[],
  splitMode: z.infer<typeof itemSplitModeSchema>,
  targetAmount: number,
  ctx: z.RefinementCtx,
  path: (string | number)[],
  amountMessage: string,
  percentageMessage: string,
) => {
  if (rows.length === 0) return
  const sum = rows.reduce((total, { shares }) => total + shares, 0)
  if (splitMode === 'BY_AMOUNT' && Math.abs(sum - targetAmount) > 0.01) {
    ctx.addIssue({ code: 'custom', message: amountMessage, path })
  } else if (splitMode === 'BY_PERCENTAGE' && Math.abs(sum - 100) > 0.01) {
    ctx.addIssue({ code: 'custom', message: percentageMessage, path })
  }
}

const savedSplitRowSchema = z.object({
  participant: z.string().min(1),
  shares: z.number().int(),
})

const splitPresetModeSchema = z.enum(['EVENLY', 'BY_SHARES', 'BY_PERCENTAGE'])
export const splitPresetTargetSchema = z.enum(['PAID_BY', 'PAID_FOR'])

/** A reusable, amount-independent split for exactly one expense side. */
export const splitPresetSchema = z
  .object({
    target: splitPresetTargetSchema,
    splitMode: splitPresetModeSchema,
    participants: z.array(savedSplitRowSchema).min(1),
  })
  .superRefine((split, ctx) => {
    const seen = new Set<string>()
    split.participants.forEach((row, i) => {
      if (seen.has(row.participant)) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicateParticipant',
          path: ['participants', i, 'participant'],
        })
      }
      seen.add(row.participant)

      if (split.splitMode === 'BY_SHARES') {
        if (row.shares < 1 || row.shares > MAX_STORED_SHARES) {
          ctx.addIssue({
            code: 'custom',
            message: 'sharesInvalid',
            path: ['participants', i, 'shares'],
          })
        }
      } else if (split.splitMode === 'BY_PERCENTAGE' && row.shares < 1) {
        ctx.addIssue({
          code: 'custom',
          message: 'percentageInvalid',
          path: ['participants', i, 'shares'],
        })
      }
    })

    if (split.splitMode === 'BY_PERCENTAGE') {
      const sum = split.participants.reduce(
        (total, row) => total + row.shares,
        0,
      )
      if (sum !== 10000) {
        ctx.addIssue({
          code: 'custom',
          message: 'percentageSum',
          path: ['participants'],
        })
      }
    }
  })

export type SavedSplitPreset = z.infer<typeof splitPresetSchema>

// Legacy account-bundle compatibility shape. New reusable splits use
// `splitPresetSchema` above; this remains only so old account exports and
// older clients can be parsed while their default is converted on import.
// It captures the same data as an expense's `paidFor` + `splitMode`, expressed
// in storage units (BY_PERCENTAGE basis points, BY_AMOUNT minor units,
// BY_SHARES fixed share units where 100 = 1 displayed share, EVENLY inclusion
// markers). ITEMIZED was never valid for the legacy default.
export const defaultSplitSchema = z
  .object({
    splitMode: z
      .enum(['EVENLY', 'BY_SHARES', 'BY_PERCENTAGE', 'BY_AMOUNT'])
      .describe('ITEMIZED is rejected — only flat split modes are allowed.'),
    paidFor: z
      .array(
        z.object({
          participant: z.string(),
          shares: z
            .number()
            .int()
            .describe(
              'Integer units. Meaning depends on splitMode: basis points for BY_PERCENTAGE (10000=100%), minor units for BY_AMOUNT, fixed share units for BY_SHARES (100 = 1 displayed share).',
            ),
        }),
      )
      .min(1),
  })
  .superRefine((split, ctx) => {
    if (split.splitMode === 'BY_PERCENTAGE') {
      const sum = split.paidFor.reduce((s, { shares }) => s + shares, 0)
      if (sum !== 10000) {
        ctx.addIssue({
          code: 'custom',
          message: 'percentageSum',
          path: ['paidFor'],
        })
      }
    } else if (split.splitMode === 'BY_AMOUNT') {
      // BY_AMOUNT sums to the expense amount (minor units). We cannot
      // validate the sum here without the amount — the API enforces it
      // post-merge by checking against the persisted group base amount.
    } else if (split.splitMode === 'BY_SHARES') {
      // BY_SHARES fixed units are positive: `1 <= shares <= MAX_STORED_SHARES`
      // (100 = 1 displayed share). A zero row is a removed participant; the
      // positive constraint is enforced here so a negative persisted value is
      // rejected as well.
    }
    const seen = new Set<string>()
    split.paidFor.forEach((row, i) => {
      if (seen.has(row.participant)) {
        ctx.addIssue({
          code: 'custom',
          message: 'duplicateParticipant',
          path: ['paidFor', i, 'participant'],
        })
      } else {
        seen.add(row.participant)
      }
      if (split.splitMode === 'BY_SHARES') {
        if (row.shares < 1 || row.shares > MAX_STORED_SHARES) {
          ctx.addIssue({
            code: 'custom',
            message: 'sharesInvalid',
            path: ['paidFor', i, 'shares'],
          })
        }
      }
    })
  })

export type SavedDefaultSplit = z.infer<typeof defaultSplitSchema>

export const expenseItemFormInputSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().min(1, { error: 'itemTitleRequired' }),
    unitPrice: z.coerce
      .number()
      .refine((v) => Number.isFinite(v), 'invalidNumber')
      .refine((v) => v !== 0, 'amountNotZero')
      .refine((v) => Math.abs(v) <= 10_000_000, 'amountTenMillion'),
    quantity: z.coerce.number().int().min(1, { error: 'itemQuantityMin1' }),
    paidFor: z
      .array(itemFormPaidForRowSchema)
      .min(0)
      .superRefine((paidFor, ctx) => {
        itemRowDuplicateGuard(paidFor, ctx)
      }),
    splitMode: itemSplitModeSchema,
  })
  .superRefine((item, ctx) => {
    // Every item row validates against its owning split mode with the
    // issue pointing at the actual `shares` field.
    item.paidFor.forEach((row, i) => {
      validateDisplayShareForMode(
        row.shares,
        item.splitMode,
        ['paidFor', i, 'shares'],
        ctx,
        { allowNegative: item.splitMode === 'BY_AMOUNT' },
      )
    })
    validateDisplayItemShareTotal(
      item.paidFor,
      item.splitMode,
      item.unitPrice * item.quantity,
      ctx,
      ['paidFor'],
      'amountSum',
      'percentageSum',
    )
  })

export const expenseItemApiSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().min(1, { error: 'itemTitleRequired' }),
    unitPrice: z
      .number()
      .int()
      .refine((value) => value !== 0, 'amountNotZero')
      .describe('Integer minor units of the expense currency.'),
    quantity: z.number().int().min(1, { error: 'itemQuantityMin1' }),
    amount: z
      .number()
      .int()
      .refine((value) => value !== 0, 'amountNotZero')
      .describe('Integer minor units. Must equal unitPrice * quantity.'),
    paidFor: z
      .array(itemApiPaidForRowSchema)
      .min(0)
      .superRefine((paidFor, ctx) => {
        itemRowDuplicateGuard(paidFor, ctx)
      }),
    splitMode: itemSplitModeSchema,
  })
  .superRefine((item, ctx) => {
    item.paidFor.forEach((row, i) => {
      if (item.splitMode === 'BY_SHARES') {
        validateItemShareRow(row, item.splitMode, ctx, ['paidFor', i, 'shares'])
      } else if (
        item.splitMode === 'BY_AMOUNT' ? row.shares === 0 : row.shares <= 0
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'noZeroShares',
          path: ['paidFor', i, 'shares'],
        })
      }
    })
    if (item.amount !== item.unitPrice * item.quantity) {
      ctx.addIssue({
        code: 'custom',
        message: 'amountSum',
        path: ['amount'],
      })
    }
    validateItemShareTotal(
      item.paidFor,
      item.splitMode,
      item.amount,
      ctx,
      ['paidFor'],
      'amountSum',
      'percentageSum',
    )
  })

export type ExpenseFormItemValues = z.infer<typeof expenseItemFormInputSchema>
export type ExpenseApiItem = z.infer<typeof expenseItemApiSchema>

const itemizedRemainderFormSchema = z.object({
  paidFor: z
    .array(itemFormPaidForRowSchema)
    .min(0)
    .superRefine((paidFor, ctx) => {
      itemRowDuplicateGuard(paidFor, ctx)
    }),
  splitMode: itemSplitModeSchema,
})

// The remainder's own `splitMode` decides the unit of each row; errors point
// at the row's `shares` field under the `itemizedRemainder` prefix.
const itemizedRemainderFormRows = (
  remainder: z.infer<typeof itemizedRemainderFormSchema>,
  ctx: z.RefinementCtx,
) => {
  remainder.paidFor.forEach((row, i) => {
    validateDisplayShareForMode(
      row.shares,
      remainder.splitMode,
      ['itemizedRemainder', 'paidFor', i, 'shares'],
      ctx,
      { allowNegative: remainder.splitMode === 'BY_AMOUNT' },
    )
  })
}

const itemizedRemainderApiSchema = z.object({
  paidFor: z
    .array(itemApiPaidForRowSchema)
    .min(0)
    .superRefine((paidFor, ctx) => {
      itemRowDuplicateGuard(paidFor, ctx)
    }),
  splitMode: itemSplitModeSchema,
})

/**
 * Mode-aware magnitude validation for the itemized-remainder rows. The
 * remainder's own `splitMode` decides the unit of `shares`, so the same rule as
 * the flat paid-for rows applies. Errors point at the `shares` field of the
 * offending row under the `itemizedRemainder` prefix.
 */
function validateItemizedRemainderShareRows(
  remainder: {
    splitMode: z.infer<typeof itemSplitModeSchema>
    paidFor: Array<{ shares: number }>
  },
  ctx: z.RefinementCtx,
) {
  remainder.paidFor.forEach((row, i) => {
    validateShareRowForMode(
      row.shares,
      remainder.splitMode,
      ['itemizedRemainder', 'paidFor', i, 'shares'],
      ctx,
      { allowNegative: remainder.splitMode === 'BY_AMOUNT' },
    )
  })
}

/**
 * Shared mode-aware validator for polymorphic `paidFor` / `paidBy` rows. The
 * row schema itself only constrains the integer type; the per-mode magnitude /
 * precision is enforced here so the same call can serve the flat expense
 * schema, item schemas, the itemized remainder, and saved default splits.
 */
function validateShareRowForMode(
  shares: number,
  mode: SplitMode,
  path: (string | number)[],
  ctx: z.RefinementCtx,
  options: { allowNegative?: boolean } = {},
) {
  const { allowNegative = false } = options
  if (mode === 'BY_SHARES') {
    // Stored fixed units are positive: `1 ≤ shares ≤ MAX_STORED_SHARES`.
    // Signed values are only valid on deliberately signed BY_AMOUNT paths,
    // never for BY_SHARES.
    if (shares < 1 || shares > MAX_STORED_SHARES) {
      ctx.addIssue({
        code: 'custom',
        message: 'sharesInvalid',
        path,
      })
    }
    return
  }
  if (!allowNegative && shares <= 0) {
    ctx.addIssue({ code: 'custom', message: 'noZeroShares', path })
  }
}

const paidByDuplicateGuard = (
  paidByList: Array<{ participant: string }>,
  ctx: z.RefinementCtx,
) => {
  const seen = new Set<string>()
  paidByList.forEach((row, i) => {
    if (seen.has(row.participant)) {
      ctx.addIssue({
        code: 'custom',
        message: 'duplicateParticipant',
        path: [i, 'participant'],
      })
    } else {
      seen.add(row.participant)
    }
  })
}

// paidByList BY_AMOUNT sum check, shared by both schemas. `paidByList`
// shares are in the selected expense currency (same units as `amount`).
const paidByAmountSumOk = (sum: number, target: number): boolean =>
  sum === target

/**
 * Form-side counterpart of `validateShareRowForMode` — operates on the
 * user-facing display units and reports the existing `noZeroShares` /
 * `sharesInvalid` / `invalidNumber` keys so the UI messages stay consistent.
 *
 * The per-row decision is delegated to `getDisplayShareErrorKey` — the same
 * single source the UI row-error summary consumes — so the schema and the
 * summary can never drift apart. `NaN` shares (partial inputs like `"-"`) are
 * rejected as `invalidNumber` instead of silently passing every numeric
 * comparison.
 *
 * Signed BY_AMOUNT rows (paid-by, item, and itemized-remainder) pass
 * `allowNegative: true`; the other modes retain positive weights.
 */
function validateDisplayShareForMode(
  value: number,
  mode: SplitMode,
  path: (string | number)[],
  ctx: z.RefinementCtx,
  options: { allowNegative?: boolean } = {},
) {
  const errorKey = getDisplayShareErrorKey(value, mode, options)
  if (errorKey) {
    ctx.addIssue({ code: 'custom', message: errorKey, path })
  }
}

// `expenseFormInputSchema` validates the user-facing form values:
// numbers in display units (decimal major units for amounts,
// display percentages for BY_PERCENTAGE). Conversion to storage units
// happens in `submit-values.ts` before the values reach the API.
export const expenseFormInputSchema = z
  .object({
    expenseDay: z.iso.date(),
    expenseTime: z.string().refine((value) => {
      try {
        parseTimeMinutes(value)
        return true
      } catch {
        return false
      }
    }, 'invalidTime'),
    expenseTimeZone: timeZoneSchema,
    title: z
      .string({
        error: (issue) =>
          issue.input === undefined ? 'titleRequired' : undefined,
      })
      .min(2, { error: 'min2' }),
    category: categoryIdSchema,
    // Text inputs feed raw strings into react-hook-form; coerce at the
    // schema boundary so empty / numeric strings round-trip to numbers
    // before the major-unit refines run.
    amount: z.coerce
      .number()
      .refine((amount) => !Number.isNaN(amount), 'invalidNumber')
      .refine((amount) => amount != 0, 'amountNotZero')
      // Major-unit ceiling: $10,000,000 equivalent (matches the prior
      // 10_000_000_00 minor-unit ceiling; same error key for i18n).
      .refine((amount) => amount <= 10_000_000, 'amountTenMillion'),
    originalCurrency: z.union([
      z.string().min(3).max(4).nullish(),
      z.literal(''),
    ]),
    conversionRate: z.coerce
      .number()
      .refine((r) => !Number.isNaN(r), 'invalidNumber')
      .refine((r) => r > 0, 'ratePositive')
      .optional(),
    // Form-local toggle: EXCHANGE | CUSTOM | undefined (undefined = group currency).
    // Mapped to the API `conversion` discriminant in submit-values.
    conversionType: conversionSourceSchema.optional(),
    paidBySplitMode: paidBySplitModeSchema,
    paidByList: z
      .array(formPaidByRowSchema)
      .min(1, { error: 'paidByMin1' })
      .superRefine((paidByList, ctx) => {
        paidByDuplicateGuard(paidByList, ctx)
      }),
    paidFor: z.array(formPaidForRowSchema).min(1, { error: 'paidForMin1' }),
    isMultiPayer: z.boolean().default(false),
    splitMode: splitModeSchema,
    documents: documentsSchema,
    notes: z.string().optional(),
    // Authoritative series cadence. `recurrenceRule` below remains accepted
    // for legacy imports until the API compatibility layer is removed.
    recurrence: recurrenceConfigSchema.nullish(),
    recurrenceRule: recurrenceRuleSchema,
    items: z.array(expenseItemFormInputSchema).optional(),
    itemizedRemainder: itemizedRemainderFormSchema.optional(),
  })
  .superRefine((expense, ctx) => {
    // A zero amount is already invalid at the amount field. Avoid reporting
    // the same state as a share-input problem while the user fixes it.
    if (expense.amount !== 0) {
      expense.paidByList.forEach(({ shares }, i) => {
        validateDisplayShareForMode(
          shares,
          expense.paidBySplitMode,
          ['paidByList', i, 'shares'],
          ctx,
          { allowNegative: true },
        )
      })
      expense.paidFor.forEach(({ shares }, i) => {
        validateDisplayShareForMode(
          shares,
          expense.splitMode,
          ['paidFor', i, 'shares'],
          ctx,
        )
      })
    }

    switch (expense.splitMode) {
      case 'EVENLY':
        break
      case 'BY_SHARES':
        break
      case 'BY_AMOUNT': {
        const sum = expense.paidFor.reduce((sum, { shares }) => sum + shares, 0)
        // Two-decimal currencies can drift by ±0.01 due to rounding.
        if (Math.abs(sum - expense.amount) > 0.01) {
          ctx.addIssue({
            code: 'custom',
            message: 'amountSum',
            path: ['paidFor'],
          })
        }
        break
      }
      case 'BY_PERCENTAGE': {
        const sum = expense.paidFor.reduce((sum, { shares }) => sum + shares, 0)
        if (Math.abs(sum - 100) > 0.01) {
          ctx.addIssue({
            code: 'custom',
            message: 'percentageSum',
            path: ['paidFor'],
          })
        }
        break
      }
    }
    switch (expense.paidBySplitMode) {
      case 'EVENLY':
        break
      case 'BY_SHARES':
        break
      case 'BY_AMOUNT': {
        // paidBy shares are entered in the same currency as `amount` (the
        // selected expense currency), so the sum always compares to it.
        const sum = expense.paidByList.reduce(
          (sum, { shares }) => sum + shares,
          0,
        )
        if (Math.abs(sum - expense.amount) > 0.01) {
          ctx.addIssue({
            code: 'custom',
            message: 'paidByAmountSum',
            path: ['paidByList'],
          })
        }
        break
      }
      case 'BY_PERCENTAGE': {
        const sum = expense.paidByList.reduce(
          (sum, { shares }) => sum + shares,
          0,
        )
        if (Math.abs(sum - 100) > 0.01) {
          ctx.addIssue({
            code: 'custom',
            message: 'paidByPercentageSum',
            path: ['paidByList'],
          })
        }
        break
      }
    }
  })
  .superRefine((expense, ctx) => {
    const items = expense.items ?? []
    if (expense.splitMode !== 'ITEMIZED') return

    if (items.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'paidForMin1',
        path: ['items'],
      })
      return
    }

    items.forEach((item, index) => {
      if (item.paidFor.length === 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'paidForMin1',
          path: ['items', index, 'paidFor'],
        })
      }
    })

    const itemsSum = items.reduce(
      (sum, item) => sum + item.unitPrice * item.quantity,
      0,
    )
    if (itemsExceedExpenseAmount(itemsSum, expense.amount)) {
      ctx.addIssue({
        code: 'custom',
        message: 'amountSum',
        path: ['items'],
      })
    }

    const remainderAmount = expense.amount - itemsSum
    if (remainderAmount !== 0 && expense.itemizedRemainder) {
      itemizedRemainderFormRows(expense.itemizedRemainder, ctx)
      validateDisplayItemShareTotal(
        expense.itemizedRemainder.paidFor,
        expense.itemizedRemainder.splitMode,
        remainderAmount,
        ctx,
        ['itemizedRemainder', 'paidFor'],
        'amountSum',
        'percentageSum',
      )
    }
  })

/**
 * Shared cross-cutting item validations for both form and API schemas. Ensures
 * ITEMIZED mode has at least one item, no item with empty paidFor in ITEMIZED
 * mode, and items don't exceed the expense amount.
 */
export function validateExpenseItems(
  items: ExpenseApiItem[],
  amount: number,
  splitMode: string,
  ctx: z.RefinementCtx,
  itemizedRemainder?: z.infer<typeof itemizedRemainderApiSchema>,
): void {
  if (splitMode === 'ITEMIZED' && items.length === 0) {
    ctx.addIssue({
      code: 'custom',
      message: 'paidForMin1',
      path: ['items'],
    })
    return
  }

  items.forEach((item, i) => {
    if (splitMode === 'ITEMIZED' && item.paidFor.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'paidForMin1',
        path: ['items', i, 'paidFor'],
      })
    }
  })

  const itemsSum = items.reduce((sum, item) => sum + item.amount, 0)
  if (itemsExceedExpenseAmount(itemsSum, amount)) {
    ctx.addIssue({
      code: 'custom',
      message: 'amountSum',
      path: ['items'],
    })
  }

  const remainderAmount = amount - itemsSum
  if (splitMode === 'ITEMIZED' && itemizedRemainder && remainderAmount !== 0) {
    validateItemShareTotal(
      itemizedRemainder.paidFor,
      itemizedRemainder.splitMode,
      remainderAmount,
      ctx,
      ['itemizedRemainder', 'paidFor'],
      'amountSum',
      'percentageSum',
    )
  }

  if (splitMode === 'ITEMIZED' && itemizedRemainder) {
    validateItemizedRemainderShareRows(itemizedRemainder, ctx)
  }
}

export type ExpenseFormInputValues = z.infer<typeof expenseFormInputSchema>

// `expenseApiSchema` validates the API/domain payload: amounts in
// integer minor units (expense currency), BY_PERCENTAGE shares in basis
// points summing to 10000, BY_AMOUNT shares summing to amount. Conversion
// is optional — absent means same currency as the group/ledger base.
// Used by create/update/import tRPC procedures and the API helpers.
export const expenseApiSchema = z
  .object({
    expenseDate: z.coerce.date().transform(toSecondPrecision),
    expenseTimeZone: timeZoneSchema,
    title: z.string().min(2, 'min2'),
    category: categoryIdSchema,
    // Expense-currency minor units (what the user typed). Server computes
    // the ledger-currency total from `conversion` when present.
    amount: z
      .number()
      .int()
      .refine((amount) => amount != 0, 'amountNotZero')
      // Prisma Int max (~2.1e9). For decimal_digits=2 this is ~$21M; for BTC
      // (8 digits) ~21 BTC. Form major-unit ceiling stays 10_000_000.
      .refine((amount) => amount <= 2_147_483_647, 'amountTenMillion')
      .describe(
        'Integer minor units of the expense currency (e.g. cents), not decimal. Max Int32.',
      ),
    conversion: optionalExpenseConversionSchema.describe(
      'Optional FX conversion to the ledger base currency. Absent means same currency as the group.',
    ),
    paidBySplitMode: paidBySplitModeSchema,
    paidByList: z
      .array(apiPaidByRowSchema)
      .min(1, { error: 'paidByMin1' })
      .superRefine((paidByList, ctx) => {
        paidByDuplicateGuard(paidByList, ctx)
      }),
    paidFor: z.array(apiPaidForRowSchema).min(1, { error: 'paidForMin1' }),
    isMultiPayer: z
      .boolean()
      .default(false)
      .describe(
        'Whether multiple participants paid. When false, paidByList must contain a single row.',
      ),
    splitMode: splitModeSchema,
    documents: documentsSchema,
    notes: z.string().optional(),
    recurrence: recurrenceConfigSchema.nullish(),
    recurrenceRule: recurrenceRuleSchema,
    items: z.array(expenseItemApiSchema).max(100).optional(),
    itemizedRemainder: itemizedRemainderApiSchema
      .optional()
      .describe(
        'How the leftover amount (total minus item subtotals) is split across participants.',
      ),
  })
  .superRefine((expense, ctx) => {
    expense.paidFor.forEach(({ shares }, i) => {
      validateShareRowForMode(
        shares,
        expense.splitMode,
        ['paidFor', i, 'shares'],
        ctx,
      )
    })
    expense.paidByList.forEach(({ shares }, i) => {
      validateShareRowForMode(
        shares,
        expense.paidBySplitMode,
        ['paidByList', i, 'shares'],
        ctx,
        { allowNegative: true },
      )
      // The signed paid-by path (negative BY_AMOUNT income expenses) is the
      // only deliberate exception; a zero payer row is still invalid in every
      // mode, while BY_SHARES range/precision is handled by the validator
      // above.
      if (expense.paidBySplitMode !== 'BY_SHARES' && shares === 0) {
        ctx.addIssue({
          code: 'custom',
          message: 'noZeroShares',
          path: ['paidByList', i, 'shares'],
        })
      }
    })

    switch (expense.splitMode) {
      case 'EVENLY':
        break
      case 'BY_SHARES':
        break
      case 'BY_AMOUNT': {
        const sum = expense.paidFor.reduce((sum, { shares }) => sum + shares, 0)
        if (sum !== expense.amount) {
          ctx.addIssue({
            code: 'custom',
            message: 'amountSum',
            path: ['paidFor'],
          })
        }
        break
      }
      case 'BY_PERCENTAGE': {
        const sum = expense.paidFor.reduce((s, { shares }) => s + shares, 0)
        if (sum !== 10000) {
          ctx.addIssue({
            code: 'custom',
            message: 'percentageSum',
            path: ['paidFor'],
          })
        }
        break
      }
    }
    switch (expense.paidBySplitMode) {
      case 'EVENLY':
        break
      case 'BY_SHARES':
        break
      case 'BY_AMOUNT': {
        // Shares are always in expense currency (= `amount`).
        const sum = expense.paidByList.reduce(
          (sum, { shares }) => sum + shares,
          0,
        )
        if (!paidByAmountSumOk(sum, expense.amount)) {
          ctx.addIssue({
            code: 'custom',
            message: 'paidByAmountSum',
            path: ['paidByList'],
          })
        }
        break
      }
      case 'BY_PERCENTAGE': {
        const sum = expense.paidByList.reduce((s, { shares }) => s + shares, 0)
        if (sum !== 10000) {
          ctx.addIssue({
            code: 'custom',
            message: 'paidByPercentageSum',
            path: ['paidByList'],
          })
        }
        break
      }
    }
  })
  .superRefine((expense, ctx) => {
    const items = expense.items ?? []
    // Items are always in expense currency (= `amount`).
    validateExpenseItems(
      items,
      expense.amount,
      expense.splitMode,
      ctx,
      expense.itemizedRemainder,
    )
    // Exchange cannot price empty/custom codes — only ISO-ish codes.
    if (
      expense.conversion?.type === 'exchange' &&
      expense.conversion.currency.length !== 3
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'exchangeRequiresIsoCurrency',
        path: ['conversion', 'currency'],
      })
    }
  })

export type Expense = z.infer<typeof expenseApiSchema>

/**
 * Input to the admin bulk-categorize apply step. Each row pairs an expense id
 * with the destination category. The server validates that the expense is
 * eligible for the bulk operation (still on `general`, scoped to the group's
 * ledger, non-settlement, etc.) before applying the change in a single
 * transaction.
 */
export const bulkUpdateExpenseCategoriesInputSchema = z.object({
  groupId: z.string().min(1),
  fromCategoryId: categoryIdSchema
    .default(categoryIdSchema.options[0])
    .describe(
      "Recategorize expenses currently in this category. Defaults to 'general'.",
    ),
  triggeredByAiConfidence: z
    .boolean()
    .optional()
    .describe(
      'Whether this bulk update was triggered by an AI confidence workflow.',
    ),
  changes: z
    .array(
      z.object({
        expenseId: z.string().min(1),
        categoryId: categoryIdSchema,
      }),
    )
    .min(1)
    .max(2000),
})

export type BulkUpdateExpenseCategoriesInput = z.infer<
  typeof bulkUpdateExpenseCategoriesInputSchema
>

export type SplittingOptions = {
  // Used for saving default splitting options in localStorage
  splitMode: SplitMode
  paidFor: ExpenseFormInputValues['paidFor'] | null
}
