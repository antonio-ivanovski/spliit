import { createFileRoute, redirect } from '@tanstack/react-router'

import { expenseImportSearchSchema } from '@/router/schemas'

/**
 * The expense file importer moved to the Tools tab. Keep the previous URL
 * working for bookmarks and in-flight links by redirecting, preserving search
 * params (including `editRow` deep links).
 */
export const Route = createFileRoute('/groups/$groupId/expenses/import')({
  validateSearch: expenseImportSearchSchema,
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: '/groups/$groupId/tools/import',
      params: { groupId: params.groupId },
      search,
    })
  },
})
