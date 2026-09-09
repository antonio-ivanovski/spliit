import { z } from 'zod'

import { groupFormSchema } from '@spliit/domain'

import { createGroup } from '../../../lib/api'
import {
  CREATE_OPERATIONS,
  createRequestIdSchema,
  runIdempotentCreate,
} from '../../../lib/api/idempotency'
import { apiProcedure } from '../../init'
import { createGroupOutputSchema } from '../../outputs/groups'

export const createGroupProcedure = apiProcedure('spliit:groups:manage')
  .input(
    z.object({
      requestId: createRequestIdSchema,
      groupFormValues: groupFormSchema,
    }),
  )
  .output(createGroupOutputSchema)
  .mutation(async ({ input: { requestId, groupFormValues }, ctx }) => {
    const account = ctx.auth.user
    const { value } = await runIdempotentCreate({
      accountId: account.id,
      operation: CREATE_OPERATIONS.group,
      requestId,
      input: { groupFormValues },
      execute: async (tx) => {
        const result = await createGroup(groupFormValues, {
          adminAccountId: account.id,
          tx,
        })
        return { groupId: result.group.id }
      },
    })
    return value
  })
