import { z } from 'zod'

import { getRecurringSeriesProgress } from '../../../../lib/api/series-progress'
import {
  groupAccessFields,
  scopedGroupReadProcedure,
  groupViewerArgs,
  loadGroupViewer,
} from '../../../init'
import { recurringSeriesProgressOutputSchema } from '../../../outputs/expenses'

export const seriesProgressProcedure = scopedGroupReadProcedure(
  'spliit:expenses:read',
)
  .input(
    z.object({
      groupId: z.string().min(1),
      seriesId: z.string().min(1),
      ...groupAccessFields,
    }),
  )
  .output(recurringSeriesProgressOutputSchema)
  .query(async ({ input, ctx }) => {
    const { group } = await loadGroupViewer(groupViewerArgs(input, ctx))
    return getRecurringSeriesProgress(group.id, input.seriesId)
  })
