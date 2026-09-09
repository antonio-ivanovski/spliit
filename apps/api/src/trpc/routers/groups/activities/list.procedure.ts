import { z } from 'zod'

import { getActivities } from '../../../../lib/api'
import { redactViewerDisplayName } from '../../../../lib/group-view'
import {
  groupAccessFields,
  scopedGroupReadProcedure,
  groupViewerArgs,
  loadGroupViewer,
} from '../../../init'
import { listActivitiesOutputSchema } from '../../../outputs/activities'

export const listGroupActivitiesProcedure = scopedGroupReadProcedure(
  'spliit:groups:read',
)
  .input(
    z.object({
      groupId: z.string(),
      cursor: z.number().int().min(0).optional().default(0),
      limit: z.number().int().min(1).max(100).optional().default(5),
      ...groupAccessFields,
    }),
  )
  .output(listActivitiesOutputSchema)
  .query(async ({ input: { groupId, cursor, limit, ...access }, ctx }) => {
    const { group, viewer } = await loadGroupViewer(
      groupViewerArgs({ groupId, ...access }, ctx),
    )
    const activities = await getActivities(group.id, {
      offset: cursor,
      length: limit + 1,
    })
    return {
      activities: activities.slice(0, limit).map((activity) => {
        const publicActivity =
          viewer.kind === 'ACTIVE'
            ? activity
            : {
                ...activity,
                ledgerId: 'public',
                actorId: null,
                actorName: activity.actorName
                  ? redactViewerDisplayName(activity.actorName)
                  : null,
                subjectId:
                  activity.subjectType === 'EXPENSE'
                    ? activity.subjectId
                    : null,
                data:
                  activity.data?.kind === 'invitation'
                    ? {
                        ...activity.data,
                        summary: undefined,
                        displayLabel: 'Invitation',
                        changes: activity.data.changes?.map((change) =>
                          change.field === 'destination'
                            ? { ...change, before: null, after: null }
                            : change,
                        ),
                      }
                    : activity.data,
              }
        return { ...publicActivity, expense: activity.expense ?? null }
      }),
      hasMore: !!activities[limit],
      nextCursor: cursor + limit,
    }
  })
