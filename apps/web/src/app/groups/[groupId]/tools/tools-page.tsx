import { Link } from '@tanstack/react-router'
import { FileSpreadsheet } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useCurrentGroupOrNull } from '@/app/groups/[groupId]/current-group-context'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

const IMPORT_STEPS = [
  {
    titleKey: 'Tools.import.steps.choose.title',
    detailKey: 'Tools.import.steps.choose.detail',
  },
  {
    titleKey: 'Tools.import.steps.map.title',
    detailKey: 'Tools.import.steps.map.detail',
  },
  {
    titleKey: 'Tools.import.steps.review.title',
    detailKey: 'Tools.import.steps.review.detail',
  },
] as const

export default function GroupToolsPage() {
  const { t } = useTranslation()
  // Keep the page usable in isolated renders as well as inside the group
  // layout; the optional context returns null when no provider is mounted.
  const groupContext = useCurrentGroupOrNull()
  const { group, groupId, viewer, currentInvitation } = groupContext ?? {}
  const resolvedGroupId = groupId ?? ''
  // The tab itself stays visible to everyone so the tools remain
  // discoverable; each card gates its own action.
  const canMutate =
    Boolean(group) &&
    (viewer?.canMutate ?? !currentInvitation) &&
    !group?.archived

  return (
    <div className="mb-4 flex flex-col gap-4">
      <div className="px-1">
        <h1 className="text-xl font-semibold tracking-tight">
          {t('Tools.title')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('Tools.description')}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileSpreadsheet
              className="size-5 text-muted-foreground"
              aria-hidden="true"
            />
            {t('Tools.import.title')}
          </CardTitle>
          <CardDescription>{t('Tools.import.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <ol className="grid gap-3 text-sm">
            {IMPORT_STEPS.map((step, index) => (
              <li key={step.titleKey} className="flex items-start gap-3">
                <span
                  aria-hidden="true"
                  className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold"
                >
                  {index + 1}
                </span>
                <p>
                  <span className="font-medium">{t(step.titleKey)}</span>
                  <span className="text-muted-foreground">
                    {' — '}
                    {t(step.detailKey)}
                  </span>
                </p>
              </li>
            ))}
          </ol>
          <div className="space-y-2 border-t border-border/70 pt-5">
            <Button
              type="button"
              disabled={!canMutate}
              nativeButton={!canMutate || !resolvedGroupId}
              render={
                canMutate && resolvedGroupId ? (
                  <Link
                    to="/groups/$groupId/tools/import"
                    params={{ groupId: resolvedGroupId }}
                  />
                ) : undefined
              }
            >
              {t('Tools.import.start')}
            </Button>
            {!canMutate ? (
              <p className="text-xs text-muted-foreground">
                {group?.archived
                  ? t('Tools.import.archivedNotice')
                  : t('Tools.import.readOnlyNotice')}
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
