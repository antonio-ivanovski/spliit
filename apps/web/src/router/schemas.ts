import { z } from 'zod'

import { categoryIdSchema } from '@spliit/domain'

/**
 * Path-param and search-param schemas for every route that needs typed values.
 * These are wired up via `params.parse` / `validateSearch` on each
 * `createFileRoute(...)` definition, so consumers can call `Route.useParams()`
 * / `Route.useSearch()` (or `getRouteApi(...).useParams()` / `.useSearch()`
 * from code-split files) and get strongly-typed values out of the URL.
 *
 * The route shapes here are intentionally permissive (`z.string().catch(...)`
 * for free-form fields, `z.optional()` for everything) so that an out-of-band
 * navigation never throws a `PathParamError` / `SearchParamError` at the user —
 * the page just renders with sensible defaults.
 */

const cuidLike = z.string().min(1).catch('')

export const groupIdParamSchema = cuidLike
export const expenseIdParamSchema = cuidLike

const optionalString = z.string().optional().catch(undefined)

const numericString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, 'expected a numeric string')
  .optional()
  .catch(undefined)

const integerString = z
  .string()
  .regex(/^-?\d+$/, 'expected an integer string')
  .optional()
  .catch(undefined)

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'expected an ISO date')
  .optional()
  .catch(undefined)

const globalExpensesReturnTo = z
  .string()
  .regex(/^\/expenses(?:\?[^#]*)?$/)
  .optional()
  .catch(undefined)

/**
 * Search-param schema for the `/groups/import` wizard. The `prefill` field
 * carries an encoded `spliit.app` group URL when the user arrived from the
 * not-found hand-off; the wizard opens on the destination step when this is
 * set. The `source` field selects the active import-source tab.
 */
export const importGroupSearchSchema = z.object({
  prefill: z.string().optional(),
  source: z
    .enum(['spliit', 'spliit-cloud', 'splitwise', 'tricount', 'settleup'])
    .optional(),
})

/**
 * Bearer tokens on `/groups/$groupId`. Child `validateSearch` schemas must
 * include these fields so they are not stripped; `retainSearchParams` on the
 * parent keeps them across in-group navigations.
 */
export const groupAccessSearchSchema = z.object({
  invite: z.string().optional(),
  viewKey: z.string().optional(),
})

/**
 * Search-param schema for the `/groups/$groupId` route.
 *
 * `friendLinkInvite` carries the invite URL returned by `friends.create` on the
 * link path. The layout surfaces it as a one-time dialog so the user can
 * copy/share it before continuing.
 *
 * The `exp*` fields drive the expense-list filter panel. Multi-value filters
 * (categories, paid by/for, currencies) are encoded as comma-separated strings
 * so a single search param holds the whole set; they are parsed to arrays by
 * the expense-filters hook. `expShowSettlements` flips the settlement
 * visibility alongside the other filters (it is omitted when at the default
 * `true`).
 */
export const groupSearchSchema = groupAccessSearchSchema.extend({
  seriesId: optionalString,
  friendLinkInvite: optionalString,
  returnTo: globalExpensesReturnTo,
  expCategories: z.string().optional().catch(undefined),
  expPaidBy: z.string().optional().catch(undefined),
  expPaidByMatch: z.enum(['any', 'all', 'exact']).optional().catch(undefined),
  expPaidFor: z.string().optional().catch(undefined),
  expPaidForMatch: z.enum(['any', 'all', 'exact']).optional().catch(undefined),
  expDateFrom: dateString,
  expDateTo: dateString,
  expMinAmount: numericString,
  expMaxAmount: numericString,
  expCurrencies: z.string().optional().catch(undefined),
  expShowSettlements: z.enum(['true', 'false']).optional().catch(undefined),
  expSortBy: z
    .enum(['expenseDate', 'createdAt', 'amount'])
    .optional()
    .catch(undefined),
  expSortDir: z.enum(['asc', 'desc']).optional().catch(undefined),
})

export const groupParamsSchema = z.object({
  groupId: groupIdParamSchema,
})

export const expenseParamsSchema = z.object({
  groupId: groupIdParamSchema,
  expenseId: expenseIdParamSchema,
})

export const editExpenseSearchSchema = groupAccessSearchSchema.extend({
  scope: z.enum(['OCCURRENCE', 'THIS_AND_FUTURE']).optional().catch(undefined),
  returnTo: globalExpensesReturnTo,
})

export const homeSearchSchema = z.object({
  redirect: optionalString,
  mode: z.enum(['sign-in', 'sign-up']).optional().catch(undefined),
  email: optionalString,
  invitation: optionalString,
})

export const globalExpensesSearchSchema = z.object({
  q: optionalString,
  groups: optionalString,
  categories: optionalString,
  paidBy: optionalString,
  paidByMatch: z.enum(['any', 'all', 'exact']).optional().catch(undefined),
  paidFor: optionalString,
  paidForMatch: z.enum(['any', 'all', 'exact']).optional().catch(undefined),
  dateFrom: dateString,
  dateTo: dateString,
  minAmount: numericString,
  maxAmount: numericString,
  currencies: optionalString,
  showSettlements: z.enum(['true', 'false']).optional().catch(undefined),
  sortBy: z
    .enum(['expenseDate', 'createdAt', 'amount'])
    .optional()
    .catch(undefined),
  sortDir: z.enum(['asc', 'desc']).optional().catch(undefined),
  expenseId: optionalString,
  expenseGroupId: optionalString,
})

export const expensePreviewSearchSchema = groupAccessSearchSchema.extend({
  returnTo: globalExpensesReturnTo,
})

export const expenseImportSearchSchema = groupAccessSearchSchema.extend({
  editRow: optionalString,
})

export const forgotPasswordSearchSchema = z.object({
  email: optionalString,
})

export const resetPasswordSearchSchema = z.object({
  token: optionalString,
  error: optionalString,
})

export const completeProfileSearchSchema = z.object({
  redirect: optionalString,
})

export const oauthFlowSearchSchema = z.object({
  oauth_query: optionalString,
  client_id: optionalString,
  scope: optionalString,
})

export const createExpenseSearchSchema = groupAccessSearchSchema.extend({
  settlement: optionalString,
  /** Legacy alias for `settlement=yes` bookmarks. */
  reimbursement: optionalString,
  settlements: optionalString,
  amount: numericString,
  from: optionalString,
  to: optionalString,
  title: optionalString,
  date: dateString,
  categoryId: categoryIdSchema.optional().catch(undefined),
  originalCurrency: optionalString,
  imageUrl: optionalString,
  imageWidth: integerString,
  imageHeight: integerString,
  items: optionalString,
  payer: optionalString,
  participants: optionalString,
  // When set, the create form pre-populates from this source expense
  // and overrides `expenseDate` to today (a.k.a. "Make a copy" flow).
  fromExpenseId: z.string().optional().catch(undefined),
  returnTo: globalExpensesReturnTo,
})

export const balancesSearchSchema = groupAccessSearchSchema.extend({
  currencyDisplay: z.enum(['group', 'original']).optional().catch(undefined),
  view: z.enum(['simple', 'visual']).optional().catch(undefined),
  settlementMode: z
    .enum(['individual', 'subgroups'])
    .optional()
    .catch(undefined),
})

export type CreateExpenseSearch = z.infer<typeof createExpenseSearchSchema>
export type CompleteProfileSearch = z.infer<typeof completeProfileSearchSchema>
export type ResetPasswordSearch = z.infer<typeof resetPasswordSearchSchema>
export type ForgotPasswordSearch = z.infer<typeof forgotPasswordSearchSchema>
export type HomeSearch = z.infer<typeof homeSearchSchema>
