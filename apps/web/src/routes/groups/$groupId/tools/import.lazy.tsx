import { createLazyFileRoute } from '@tanstack/react-router'

import { ExpenseFileImportPage } from '@/app/groups/[groupId]/expenses/csv-import-page'
import { Skeleton } from '@/components/ui/skeleton'
import { useEffectiveRuntimeFeatureFlags } from '@/lib/effective-runtime-feature-flags'

function ExpenseFileImportRoute() {
  const { flags, isLoading } = useEffectiveRuntimeFeatureFlags()
  if (isLoading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    )
  }
  return <ExpenseFileImportPage runtimeFeatureFlags={flags} />
}

export const Route = createLazyFileRoute('/groups/$groupId/tools/import')({
  component: ExpenseFileImportRoute,
  pendingComponent: () => (
    <div className="flex flex-col gap-4" aria-busy="true">
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-72 w-full" />
    </div>
  ),
})
