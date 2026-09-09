import { Check } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function WizardProgress<TStep extends string>(props: {
  steps: ReadonlyArray<{ id: TStep; label: string }>
  currentStep: TStep
  /** Every step renders completed (used for terminal success states). */
  completed?: boolean
  ariaLabel?: string
  className?: string
}) {
  const currentIndex = props.steps.findIndex(
    ({ id }) => id === props.currentStep,
  )

  return (
    <ol
      aria-label={props.ariaLabel ?? 'Progress'}
      className={cn(
        'grid min-w-0 gap-2 text-sm',
        props.steps.length === 3 && 'grid-cols-3',
        props.className,
      )}
    >
      {props.steps.map((step, index) => {
        const isCurrent = !props.completed && index === currentIndex
        const isComplete = Boolean(props.completed) || index < currentIndex
        return (
          <li
            key={step.id}
            aria-current={isCurrent ? 'step' : undefined}
            className={cn(
              'flex min-w-0 items-center gap-2 rounded-md border px-2 py-2 sm:px-3',
              isCurrent && 'border-primary bg-primary/5 font-medium',
              !isCurrent && !isComplete && 'text-muted-foreground',
              isComplete && 'border-primary/30 text-foreground',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'inline-flex size-5 shrink-0 items-center justify-center rounded-full border text-xs',
                isCurrent && 'border-primary text-primary',
                isComplete &&
                  'border-primary bg-primary text-primary-foreground',
              )}
            >
              {isComplete ? <Check className="size-3" /> : index + 1}
            </span>
            <span className="truncate">{step.label}</span>
            <span className="sr-only">
              {isCurrent ? ', current step' : isComplete ? ', completed' : ''}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

export function WizardStepHeader(props: {
  eyebrow: string
  title: string
  description?: string
  focusOnChange?: boolean
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (!props.focusOnChange) return
    const heading = headingRef.current
    if (!heading) return
    heading.scrollIntoView?.({ block: 'start' })
    heading.focus({ preventScroll: true })
  }, [props.focusOnChange, props.title])

  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm tracking-wide text-muted-foreground uppercase">
        {props.eyebrow}
      </p>
      <h1
        ref={headingRef}
        tabIndex={props.focusOnChange ? -1 : undefined}
        className="text-2xl leading-none font-semibold"
      >
        {props.title}
      </h1>
      {props.description && (
        <p className="text-sm text-muted-foreground">{props.description}</p>
      )}
    </div>
  )
}

export function WizardNav(props: {
  back?: { label: string; onClick: () => void }
  continue?: {
    label: ReactNode
    onClick?: () => void
    form?: string
    disabled?: boolean
    describedBy?: string
  }
}) {
  if (!props.back && !props.continue) return null

  return (
    <div
      data-wizard-nav
      className="sticky bottom-[var(--mobile-nav-height)] z-30 -mx-1 border-t border-border/70 bg-background pt-3 pb-[calc(0.75rem+var(--safe-area-bottom))] sm:bottom-0 sm:-mx-2 sm:pt-4 sm:pb-[calc(1rem+var(--safe-area-bottom))]"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-1 sm:px-2">
        {props.back ? (
          <Button variant="ghost" onClick={props.back.onClick} type="button">
            {props.back.label}
          </Button>
        ) : (
          <span />
        )}
        {props.continue && (
          <Button
            type={props.continue.form ? 'submit' : 'button'}
            form={props.continue.form}
            onClick={props.continue.onClick}
            aria-describedby={props.continue.describedBy}
            disabled={
              props.continue.disabled ||
              (!props.continue.form && !props.continue.onClick)
            }
          >
            {props.continue.label}
          </Button>
        )}
      </div>
    </div>
  )
}
