import { useLocation, useNavigate } from '@tanstack/react-router'
import { Cloud, Plus, Settings, Users } from 'lucide-react'
import { useReducedMotion } from 'motion/react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { useTranslation } from 'react-i18next'

import { useSyncedAccountPreferences } from '@/components/account-preferences-sync'
import {
  SpeedDial,
  SpeedDialAction,
  SpeedDialContent,
  SpeedDialItem,
  SpeedDialLabel,
  SpeedDialTrigger,
} from '@/components/ui/speed-dial'
import { isMobileGroupNavPath } from '@/lib/mobile-nav'
import { useCurrentAccount } from '@/lib/use-current-account'
import { useOnlineStatus } from '@/lib/use-online-status'
import { cn } from '@/lib/utils'

import {
  hasDiscoveredMascotActions,
  markMascotActionsDiscovered,
  subscribeMascotActionsDiscovered,
} from './mascot-actions-discovery'
import {
  DEFAULT_REACTION_DURATION,
  isExpressiveMascotReaction,
  useMascotController,
  useMascotState,
  type MascotAction,
} from './mascot-context'
import {
  canDragMascot,
  dialPlacementFromPin,
  dropHitsReject,
  pinFromClient,
  readMascotPin,
  subscribeFinePointer,
  subscribeMascotPin,
  writeMascotPin,
  type MascotPin,
} from './mascot-pin'
import { getMascotDefinition } from './mascot-registry'
import {
  hasDiscoveredMascotSettings,
  markMascotSettingsDiscovered,
  subscribeMascotSettingsDiscovered,
} from './mascot-settings-discovery'
import {
  buildMascotSpeechCycle,
  coachSpeechForActions,
  isCoachSpeechLine,
  OFFLINE_SPEECH_LINE,
  type MascotSpeechLine,
} from './mascot-speech'
import { MascotSpeechBubble } from './mascot-speech-bubble'

const SPEECH_DISMISS_MS = 3_000
const DRAG_THRESHOLD_PX = 8
const OFFLINE_FAILURE_LOOP_MS = DEFAULT_REACTION_DURATION.failure

const mascotActionElevation =
  'shadow-[0_1px_3px_rgba(15,23,42,0.08),0_8px_20px_-6px_rgba(15,23,42,0.18),0_18px_36px_-10px_rgba(15,23,42,0.12)] ring-1 ring-black/10 dark:shadow-[0_6px_14px_rgba(0,0,0,0.55),0_18px_36px_-6px_rgba(0,0,0,0.62),0_0_16px_hsl(var(--primary)/0.14),0_0_0_1px_hsl(var(--primary)/0.32)] dark:ring-1 dark:ring-primary/30'

const mascotActionFill = 'bg-card dark:bg-[hsl(24_9%_20%)]'

function subscribeToBodyMutations(callback: () => void) {
  if (
    typeof document === 'undefined' ||
    typeof MutationObserver === 'undefined'
  )
    return () => undefined
  const observer = new MutationObserver(callback)
  observer.observe(document.body, { childList: true, subtree: true })
  return () => observer.disconnect()
}

function hasOpenDialog() {
  if (typeof document === 'undefined') return false
  return Boolean(
    document.querySelector('[role="dialog"], [role="alertdialog"]'),
  )
}

function hasFixedActionBar() {
  if (typeof document === 'undefined') return false
  return Boolean(document.querySelector('[data-fixed-action-bar]'))
}

export function MascotHost() {
  const preferences = useSyncedAccountPreferences()
  const mascot = useMascotState()
  const { react } = useMascotController()
  const { data: account, isPending } = useCurrentAccount()
  const isOnline = useOnlineStatus()
  const offline = !isOnline
  const welcomedAccountRef = useRef<string | null>(null)
  const pathname = useLocation({ select: (location) => location.pathname })
  const navigate = useNavigate()
  const { t } = useTranslation()
  const reducedMotion = useReducedMotion()
  const [openScope, setOpenScope] = useState<string | null>(null)
  const [speech, setSpeech] = useState<{
    path: string
    line: MascotSpeechLine
  } | null>(null)
  const [welcomeFor, setWelcomeFor] = useState<string | null>(null)
  const [coachedAccountId, setCoachedAccountId] = useState<string | null>(null)
  const [dragPx, setDragPx] = useState<{ x: number; y: number } | null>(null)
  const cycleRef = useRef({ path: '', index: 0 })
  const speechLine = speech?.path === pathname ? speech.line : null
  const hostRef = useRef<HTMLDivElement>(null)
  const didDragRef = useRef(false)
  const dragSession = useRef<{
    pointerId: number
    startX: number
    startY: number
    centerX: number
    centerY: number
    width: number
    height: number
    moved: boolean
  } | null>(null)
  const dialogOpen = useSyncExternalStore(
    subscribeToBodyMutations,
    hasOpenDialog,
    () => false,
  )
  const actionBarOpen = useSyncExternalStore(
    subscribeToBodyMutations,
    hasFixedActionBar,
    () => false,
  )
  const settingsDiscovered = useSyncExternalStore(
    subscribeMascotSettingsDiscovered,
    () => hasDiscoveredMascotSettings(account?.id),
    () => false,
  )
  const actionsDiscovered = useSyncExternalStore(
    subscribeMascotActionsDiscovered,
    () => hasDiscoveredMascotActions(account?.id),
    () => false,
  )
  const pin = useSyncExternalStore(
    subscribeMascotPin,
    () => readMascotPin(account?.id),
    () => null,
  )
  const finePointer = useSyncExternalStore(
    subscribeFinePointer,
    canDragMascot,
    () => false,
  )

  const homeActions = useMemo<MascotAction[]>(
    () =>
      pathname === '/'
        ? [
            {
              id: 'create-friend-ledger',
              label: t('Groups.createFriendLedgerCard.title'),
              icon: Users,
              onSelect: () => void navigate({ to: '/friends/create' }),
            },
            {
              id: 'import-group',
              label: t('Groups.importGroup'),
              icon: Cloud,
              onSelect: () => void navigate({ to: '/groups/import' }),
            },
            {
              id: 'create-group',
              label: t('Groups.createGroupCard.title'),
              icon: Plus,
              primary: true,
              onSelect: () => void navigate({ to: '/groups/create' }),
            },
          ]
        : [],
    [navigate, pathname, t],
  )

  const actions =
    offline || !mascot
      ? []
      : mascot.actions.length
        ? mascot.actions
        : homeActions
  const expressive = Boolean(
    mascot && isExpressiveMascotReaction(mascot.reaction),
  )
  const blockedByOverlay = dialogOpen && !expressive
  const aboveMobileNav = isMobileGroupNavPath(pathname)
  const hasPrimaryAction = actions.some((action) => action.primary)
  const reactionExpansion = expressive && !offline
  const hiddenSurface = pathname.endsWith('/expenses/print')
  const compactSurface = pathname.endsWith('/tools/import')
  const interactionScope = `${pathname}:${blockedByOverlay ? 'blocked' : 'active'}`
  const hasActions = actions.length > 0
  const interactive = hasActions && !blockedByOverlay
  const open = interactive && openScope === interactionScope
  const docked = Boolean(
    (compactSurface || !hasPrimaryAction) &&
    !open &&
    !speechLine &&
    !reactionExpansion &&
    !mascot?.busy,
  )
  const showSettings = interactive && !settingsDiscovered
  const showActionBadge = hasActions && !open && !blockedByOverlay
  const nudgeActions = showActionBadge && !actionsDiscovered
  const pinned = Boolean(pin) && finePointer
  const placement = dialPlacementFromPin(pinned ? pin : null)
  const aiReceiptOrVoice = Boolean(
    preferences?.aiFeaturesEnabled !== false &&
    (preferences?.aiReceiptScanEnabled !== false ||
      preferences?.aiVoiceExpenseEnabled !== false),
  )
  const speechLines = useMemo(
    () =>
      buildMascotSpeechCycle({
        pathname,
        aiReceiptOrVoice,
        settingsDiscovered,
      }),
    [aiReceiptOrVoice, pathname, settingsDiscovered],
  )

  const openMascotSettings = useCallback(() => {
    markMascotSettingsDiscovered(account?.id)
    setSpeech(null)
    setOpenScope(null)
    void navigate({
      to: '/account/settings',
      hash: 'account-preference-mascot',
    })
  }, [account?.id, navigate])

  const handlePersonalityTap = useCallback(() => {
    if (offline) {
      setSpeech({ path: pathname, line: OFFLINE_SPEECH_LINE })
      return
    }
    if (cycleRef.current.path !== pathname) {
      cycleRef.current = { path: pathname, index: 0 }
    }
    const line = speechLines[cycleRef.current.index % speechLines.length]
    cycleRef.current.index += 1
    setSpeech({ path: pathname, line })
    mascot?.react('welcome', 900)
  }, [mascot, offline, pathname, speechLines])

  useEffect(() => {
    if (!speechLine) return
    const timer = window.setTimeout(() => {
      setSpeech(null)
    }, SPEECH_DISMISS_MS)
    return () => window.clearTimeout(timer)
  }, [speechLine])

  const definition = getMascotDefinition(preferences?.mascot)
  const accountId = account?.id ?? null

  if (mascot?.reaction === 'welcome' && accountId && welcomeFor !== accountId) {
    setWelcomeFor(accountId)
  } else if (!accountId && welcomeFor) {
    setWelcomeFor(null)
    setCoachedAccountId(null)
  }

  if (
    accountId &&
    welcomeFor === accountId &&
    coachedAccountId !== accountId &&
    !actionsDiscovered &&
    hasActions &&
    !blockedByOverlay &&
    !docked &&
    mascot?.reaction === 'idle'
  ) {
    const line = coachSpeechForActions(actions.map((action) => action.id))
    if (line) {
      setCoachedAccountId(accountId)
      setSpeech({ path: pathname, line })
    }
  }

  useEffect(() => {
    if (!account?.id) {
      welcomedAccountRef.current = null
      return
    }
    if (hiddenSurface || !definition) return
    if (offline) return
    // Keep dense/non-primary routes compact on entry. Prominent routes still
    // receive the welcome reaction and coaching cue.
    if (!hasPrimaryAction) return
    if (welcomedAccountRef.current === account.id) return
    welcomedAccountRef.current = account.id
    react('welcome')
  }, [account?.id, definition, hasPrimaryAction, hiddenSurface, offline, react])

  useEffect(() => {
    if (!account?.id || hiddenSurface || !definition || !offline) return
    const play = () => {
      react('failure', OFFLINE_FAILURE_LOOP_MS + 400)
    }
    play()
    const interval = window.setInterval(play, OFFLINE_FAILURE_LOOP_MS)
    return () => {
      window.clearInterval(interval)
      react('idle')
    }
  }, [account?.id, definition, hiddenSurface, offline, react])

  function onTriggerPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!finePointer || blockedByOverlay || event.button !== 0) return
    const host = hostRef.current
    if (!host) return
    const rect = host.getBoundingClientRect()
    dragSession.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      width: rect.width,
      height: rect.height,
      moved: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onTriggerPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const session = dragSession.current
    if (!session || session.pointerId !== event.pointerId) return
    const dx = event.clientX - session.startX
    const dy = event.clientY - session.startY
    if (!session.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
      session.moved = true
      didDragRef.current = true
      setOpenScope(null)
      setSpeech(null)
    }
    setDragPx({
      x: session.centerX + dx,
      y: session.centerY + dy,
    })
  }

  function onTriggerPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    const session = dragSession.current
    if (!session || session.pointerId !== event.pointerId) return
    dragSession.current = null
    if (!session.moved) return
    const clientX = session.centerX + (event.clientX - session.startX)
    const clientY = session.centerY + (event.clientY - session.startY)
    setDragPx(null)
    if (!account?.id) return
    if (dropHitsReject(clientX, clientY, session.width, session.height)) {
      return
    }
    writeMascotPin(account.id, pinFromClient(clientX, clientY))
  }

  if (hiddenSurface || !definition || !mascot || (!isPending && !account)) {
    return null
  }

  const Character = definition.Character

  const positionClassName = cn(
    'fixed',
    !pinned && !dragPx && 'end-3 sm:end-5',
    blockedByOverlay ? 'z-40' : expressive ? 'z-70' : 'z-60',
    !pinned &&
      !dragPx &&
      (actionBarOpen
        ? 'bottom-[calc(4.65rem+env(safe-area-inset-bottom))]'
        : aboveMobileNav
          ? 'bottom-[calc(4.65rem+env(safe-area-inset-bottom))] sm:bottom-5'
          : 'bottom-[calc(0.65rem+env(safe-area-inset-bottom))] sm:bottom-5'),
    placement === 'top-start' && 'flex-col-reverse items-start',
    placement === 'top-end' && 'flex-col-reverse items-end',
    placement === 'bottom-start' && 'items-start',
    finePointer && !blockedByOverlay && 'cursor-grab',
    dragPx && 'cursor-grabbing',
  )

  const positionStyle = dragPx
    ? {
        left: dragPx.x,
        top: dragPx.y,
        right: 'auto',
        bottom: 'auto',
        transform: 'translate(-50%, -50%)',
      }
    : pinned && pin
      ? pinStyle(pin)
      : undefined

  return (
    <SpeedDial
      ref={hostRef}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!interactive) return
        if (nextOpen) {
          markMascotActionsDiscovered(account?.id)
          setSpeech(null)
        }
        setOpenScope(nextOpen ? interactionScope : null)
      }}
      className={positionClassName}
      style={positionStyle}
      data-testid={docked ? 'bill-mascot-docked' : 'bill-mascot'}
      data-mascot-size={
        compactSurface
          ? 'compact'
          : hasPrimaryAction
            ? 'primary'
            : docked
              ? 'compact'
              : 'expanded'
      }
      data-reaction={mascot.reaction}
      data-mascot-docked={docked ? 'true' : 'false'}
      data-mascot-offline={offline ? 'true' : 'false'}
      data-mascot-blocked={blockedByOverlay ? 'true' : 'false'}
      data-mascot-pinned={pinned ? 'true' : 'false'}
      data-mascot-placement={placement}
    >
      <SpeedDialContent
        className={cn(
          'gap-2 pe-1',
          placement.startsWith('top') ? 'pt-1.5' : 'pb-1.5',
          placement.startsWith('top') && 'flex-col',
          placement.endsWith('start') && 'items-start',
        )}
      >
        {actions.map(({ id, label, icon: Icon, onSelect, primary }) => (
          <SpeedDialItem
            key={id}
            className={cn(
              'gap-2.5',
              placement.endsWith('start') && 'flex-row-reverse',
            )}
          >
            <SpeedDialLabel
              className={cn(
                'border-border/80 px-3 py-2 text-sm backdrop-blur-none dark:border-white/18',
                mascotActionFill,
                mascotActionElevation,
              )}
            >
              {label}
            </SpeedDialLabel>
            <SpeedDialAction
              aria-label={label}
              onClick={() => {
                setOpenScope(null)
                setSpeech(null)
                onSelect()
              }}
              className={cn(
                'flex size-12 items-center justify-center rounded-2xl border transition-[transform,background-color] duration-200 hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring',
                mascotActionElevation,
                primary
                  ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90 dark:border-primary dark:bg-primary dark:text-primary-foreground'
                  : cn(
                      'border-border/80 text-foreground hover:bg-accent dark:border-white/18',
                      mascotActionFill,
                    ),
              )}
            >
              <Icon className="size-5" aria-hidden="true" />
            </SpeedDialAction>
          </SpeedDialItem>
        ))}
        {showSettings && (
          <SpeedDialItem
            className={cn(
              'gap-2.5',
              placement.endsWith('start') && 'flex-row-reverse',
            )}
          >
            <SpeedDialLabel
              className={cn(
                'border-border/80 px-2.5 py-1.5 text-xs text-muted-foreground backdrop-blur-none dark:border-white/18',
                mascotActionFill,
                mascotActionElevation,
              )}
            >
              {t('Mascot.settingsAction')}
            </SpeedDialLabel>
            <SpeedDialAction
              aria-label={t('Mascot.settingsAction')}
              data-testid="bill-mascot-settings"
              onClick={openMascotSettings}
              className={cn(
                'flex size-9 items-center justify-center rounded-xl border border-border/80 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring dark:border-white/18',
                mascotActionFill,
                mascotActionElevation,
              )}
            >
              <Settings className="size-4" aria-hidden="true" />
            </SpeedDialAction>
          </SpeedDialItem>
        )}
      </SpeedDialContent>
      <div className="relative">
        {speechLine &&
          !blockedByOverlay &&
          (!hasActions || isCoachSpeechLine(speechLine)) && (
            <MascotSpeechBubble
              data-testid="bill-mascot-speech"
              side={placement.startsWith('top') ? 'bottom' : 'top'}
              align={placement.endsWith('start') ? 'start' : 'end'}
              className={
                !reducedMotion ? 'animate-in fade-in-0 zoom-in-95' : undefined
              }
            >
              <output className="block" aria-live="polite">
                {t(speechLine.messageKey, { name: t(definition.nameKey) })}
              </output>
              {speechLine.showSettings && (
                <button
                  type="button"
                  className="mt-1.5 text-xs font-medium text-primary underline-offset-2 hover:underline"
                  onClick={openMascotSettings}
                >
                  {t('Mascot.noActionSettings')}
                </button>
              )}
            </MascotSpeechBubble>
          )}
        <SpeedDialTrigger
          aria-label={
            hasActions
              ? open
                ? t('Mascot.closeActions')
                : t('Mascot.openActions')
              : t('Mascot.greetBill')
          }
          aria-hidden={blockedByOverlay ? true : undefined}
          data-testid="bill-mascot-trigger"
          data-reaction={mascot.reaction}
          className={cn(
            'group relative rounded-[2rem] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
            compactSurface
              ? 'h-12 w-12 opacity-80 transition-opacity hover:opacity-100'
              : docked
                ? 'h-16 w-16'
                : 'h-[118px] w-[108px]',
            blockedByOverlay && 'pointer-events-none',
          )}
          onPointerDown={onTriggerPointerDown}
          onPointerMove={onTriggerPointerMove}
          onPointerUp={onTriggerPointerUp}
          onPointerCancel={onTriggerPointerUp}
          onClick={(event) => {
            if (blockedByOverlay) {
              event.preventDefault()
              return
            }
            if (didDragRef.current) {
              event.preventDefault()
              didDragRef.current = false
              return
            }
            if (hasActions) return
            event.preventDefault()
            handlePersonalityTap()
          }}
        >
          <span
            className={cn(
              'absolute inset-x-1 bottom-0 h-12 rounded-full bg-[hsl(var(--mascot-stroke)/0.12)] blur-xl transition-opacity duration-300',
              open ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
              docked && 'opacity-0',
            )}
          />
          <Character
            className="relative h-full w-full drop-shadow-[0_14px_14px_hsl(var(--mascot-ink)/0.22)] dark:drop-shadow-[0_18px_22px_hsl(0_0%_0%/0.55)]"
            docked={docked}
            open={open}
            reaction={mascot.reaction}
            reactionKey={mascot.reactionKey}
          />
          {showActionBadge && (
            <span
              data-testid="bill-mascot-action-badge"
              data-mascot-nudge={nudgeActions ? 'true' : 'false'}
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute z-10 flex items-center justify-center rounded-full bg-primary text-primary-foreground ring-2 ring-background',
                'shadow-[0_4px_10px_rgba(15,23,42,0.28)] dark:shadow-[0_0_12px_hsl(var(--primary)/0.55)]',
                docked ? 'start-2 top-4 size-5' : 'start-0.5 top-0.5 size-6',
              )}
            >
              <Plus
                className={docked ? 'size-3' : 'size-3.5'}
                strokeWidth={3}
              />
            </span>
          )}
        </SpeedDialTrigger>
      </div>
    </SpeedDial>
  )
}

function pinStyle(pin: MascotPin): CSSProperties {
  return {
    left: `${pin.x}vw`,
    top: `${pin.y}vh`,
    right: 'auto',
    bottom: 'auto',
    transform: 'translate(-50%, -50%)',
  }
}
