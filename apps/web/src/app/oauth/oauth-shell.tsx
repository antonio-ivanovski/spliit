import { Plug, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { PageShell } from '@/components/layout/page-shell'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

export function OAuthShell({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: React.ReactNode
}) {
  const { t } = useTranslation(undefined, { keyPrefix: 'OAuth.shell' })

  return (
    <PageShell
      width="full"
      className="relative min-h-[calc(100vh-5rem)] items-center justify-center overflow-hidden py-4 md:py-6"
    >
      <div className="absolute inset-0 -z-10 bg-[radial-gradient(circle_at_top,hsl(var(--primary)/0.1),transparent_42%)]" />
      <div className="grid w-full max-w-4xl gap-3.5">
        <section className="flex min-w-0 items-center justify-between gap-4 rounded-2xl border border-primary/15 bg-primary/[0.045] px-3.5 py-3 sm:px-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm shadow-primary/20">
              <Plug className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-xs font-semibold tracking-wide text-primary uppercase">
                {t('label')}
              </p>
              <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">
                {t('title')}
              </h1>
              <p className="text-xs text-muted-foreground sm:hidden">
                {t('mobileDescription')}
              </p>
            </div>
          </div>
          <div className="hidden max-w-xs min-w-0 items-center gap-2 border-s border-primary/15 ps-4 text-xs leading-5 text-muted-foreground sm:flex">
            <ShieldCheck
              className="size-4 shrink-0 text-primary"
              aria-hidden="true"
            />
            <p className="line-clamp-2">
              {t('authorityBullet')} {t('previewBullet')}
            </p>
          </div>
        </section>
        <Card className="min-w-0 border-border/80 shadow-lg shadow-primary/[0.04]">
          <CardHeader className="space-y-1 px-4 pt-4 sm:px-5">
            <CardTitle className="text-xl leading-tight sm:text-2xl">
              {title}
            </CardTitle>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent className="px-4 pb-4 sm:px-5">{children}</CardContent>
        </Card>
      </div>
    </PageShell>
  )
}
