import { z } from 'zod'

const expenseFileImportMatchSchema = z.object({
  key: z.string().min(1),
  kind: z.enum(['EXACT_IMPORT', 'EXISTING_EXPENSE', 'CURRENT_FILE']),
  expenseId: z.string().nullable(),
  sourceRowId: z.string().nullable(),
  title: z.string().nullable(),
  expenseDate: z.string().nullable(),
  amount: z.number().int().nullable(),
  currency: z.string().nullable(),
})

export const expenseFileImportDuplicatesOutputSchema = z.object({
  rows: z.array(
    z.object({
      rowId: z.string().min(1),
      rowNumber: z.number().int().positive(),
      matches: z.array(expenseFileImportMatchSchema),
    }),
  ),
})

export const expenseFileImportOutputSchema = z.object({
  // min(0), not positive(): a 0-import success path (e.g. all rows already
  // imported and approved as no-ops in the future) must stay representable.
  // Backward compatible: every success today still returns >= 1.
  importedCount: z.number().int().min(0),
  expenseIds: z.array(z.string().min(1)),
})
