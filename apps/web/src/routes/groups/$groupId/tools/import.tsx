import { createFileRoute } from '@tanstack/react-router'

import { expenseImportSearchSchema } from '@/router/schemas'

export const Route = createFileRoute('/groups/$groupId/tools/import')({
  validateSearch: expenseImportSearchSchema,
})
