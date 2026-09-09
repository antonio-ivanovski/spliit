import { z } from 'zod'

import { getRecurringExpenseSeries } from '../../../../lib/api'
import {
  groupAccessFields,
  scopedGroupReadProcedure,
  groupViewerArgs,
  loadGroupViewer,
} from '../../../init'
import { listRecurringExpenseSeriesOutputSchema } from '../../../outputs/expenses'

export const listRecurringExpenseSeriesProcedure = scopedGroupReadProcedure(
  'spliit:expenses:read',
)
  .input(
    z.object({
      groupId: z.string().min(1),
      cursor: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      seriesId: z.string().optional(),
      occurrenceCursor: z.number().int().positive().optional(),
      occurrenceLimit: z.number().int().min(1).max(100).optional(),
      ...groupAccessFields,
    }),
  )
  .output(listRecurringExpenseSeriesOutputSchema)
  .query(async ({ input, ctx }) => {
    const { group } = await loadGroupViewer(groupViewerArgs(input, ctx))
    return getRecurringExpenseSeries(group.id, {
      cursor: input.cursor,
      limit: input.limit,
      seriesId: input.seriesId,
      occurrenceCursor: input.occurrenceCursor,
      occurrenceLimit: input.occurrenceLimit,
    })
  })
