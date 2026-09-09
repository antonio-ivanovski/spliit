import { createLazyFileRoute } from '@tanstack/react-router'

import GroupToolsPage from '@/app/groups/[groupId]/tools/tools-page'

export const Route = createLazyFileRoute('/groups/$groupId/tools/')({
  component: GroupToolsPage,
})
