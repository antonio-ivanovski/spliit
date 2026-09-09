import { Plus } from 'lucide-react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import { markMascotActionsDiscovered } from '@/components/mascot/mascot-actions-discovery'
import {
  MascotProvider,
  useMascotActions,
  useMascotController,
  type MascotAction,
} from '@/components/mascot/mascot-context'
import { MascotHost } from '@/components/mascot/mascot-host'
import { writeMascotPin } from '@/components/mascot/mascot-pin'
import { markMascotSettingsDiscovered } from '@/components/mascot/mascot-settings-discovery'
import { act, render, screen, waitFor } from '@/test/test-utils'

const state = vi.hoisted(() => ({
  pathname: '/',
  mascot: 'bill' as 'bill' | 'off',
  navigate: vi.fn(),
  groupAction: vi.fn(),
  isPending: false,
  account: { id: 'account-1', name: 'Ada' } as {
    id: string
    name: string
  } | null,
}))

vi.mock('@tanstack/react-router', () => ({
  useLocation: ({ select }: { select: (value: unknown) => unknown }) =>
    select({ pathname: state.pathname }),
  useNavigate: () => state.navigate,
}))

vi.mock('@/components/account-preferences-sync', () => ({
  useSyncedAccountPreferences: () => ({ mascot: state.mascot }),
}))

vi.mock('@/lib/use-current-account', () => ({
  useCurrentAccount: () => ({
    data: state.account,
    isPending: state.isPending,
  }),
}))

const groupActions: MascotAction[] = [
  {
    id: 'add-expense',
    label: 'Add expense',
    icon: Plus,
    primary: true,
    onSelect: state.groupAction,
  },
]

const secondaryGroupActions: MascotAction[] = [
  {
    id: 'add-expense-secondary',
    label: 'Add expense',
    icon: Plus,
    onSelect: state.groupAction,
  },
]

function GroupActionRegistration() {
  useMascotActions('test-group', groupActions)
  return null
}

function NonPrimaryRegistration() {
  useMascotActions('test-group-secondary', secondaryGroupActions)
  return null
}

function CelebrateButton() {
  const mascot = useMascotController()
  return (
    <button type="button" onClick={() => mascot.react('success', 5_000)}>
      Celebrate
    </button>
  )
}

function renderHost(extra?: React.ReactNode) {
  return render(
    <MascotProvider>
      {extra}
      <MascotHost />
    </MascotProvider>,
  )
}

async function finishWelcome() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_300)
  })
  vi.useRealTimers()
}

describe('MascotHost', () => {
  beforeEach(() => {
    state.pathname = '/'
    state.mascot = 'bill'
    state.isPending = false
    state.account = { id: 'account-1', name: 'Ada' }
    localStorage.clear()
    sessionStorage.clear()
    vi.clearAllMocks()
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: true,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const node of document.querySelectorAll(
      '[role="dialog"], [role="alertdialog"], [data-fixed-action-bar]',
    )) {
      node.remove()
    }
  })

  it('stays absent until Bill is selected', () => {
    state.mascot = 'off'
    renderHost()

    expect(screen.queryByTestId('bill-mascot-trigger')).toBeNull()
  })

  it('still renders while the account session is pending', () => {
    state.isPending = true
    state.account = null
    renderHost()

    expect(
      screen.getByRole('button', { name: 'Open actions with Bill' }),
    ).toBeInTheDocument()
  })

  it('offers the conservative creation shortcuts on home', async () => {
    const { user } = renderHost()

    await user.click(
      screen.getByRole('button', { name: 'Open actions with Bill' }),
    )
    await user.click(screen.getByRole('menuitem', { name: 'Create a group' }))

    expect(state.navigate).toHaveBeenCalledWith({ to: '/groups/create' })
  })

  it('uses registered group actions instead of home shortcuts', async () => {
    state.pathname = '/groups/group-1/expenses'
    const { user } = renderHost(<GroupActionRegistration />)

    await user.click(
      screen.getByRole('button', { name: 'Open actions with Bill' }),
    )
    expect(screen.getByTestId('bill-mascot')).toHaveAttribute(
      'data-mascot-size',
      'primary',
    )
    expect(screen.queryByRole('menuitem', { name: 'Create group' })).toBeNull()

    await user.click(screen.getByRole('menuitem', { name: 'Add expense' }))
    expect(state.groupAction).toHaveBeenCalledOnce()
  })

  it('keeps registered non-primary route actions compact until opened', async () => {
    state.pathname = '/groups/group-1/activity'
    const { user } = renderHost(<NonPrimaryRegistration />)

    expect(screen.getByTestId('bill-mascot-docked')).toHaveAttribute(
      'data-mascot-size',
      'compact',
    )
    expect(screen.getByTestId('bill-mascot-action-badge')).toHaveClass(
      'start-2',
      'top-4',
      'size-5',
    )
    await user.click(
      screen.getByRole('button', { name: 'Open actions with Bill' }),
    )
    expect(screen.getByTestId('bill-mascot')).toHaveAttribute(
      'data-mascot-size',
      'expanded',
    )
    expect(screen.queryByTestId('bill-mascot-action-badge')).toBeNull()
    expect(
      screen.getByTestId('bill-mascot-trigger').querySelector('.lucide-x'),
    ).toBeNull()
  })

  it('keeps the expanded primary badge anchored to the full artwork', () => {
    state.pathname = '/groups/group-1/expenses'
    renderHost(<GroupActionRegistration />)

    expect(screen.getByTestId('bill-mascot-action-badge')).toHaveClass(
      'start-0.5',
      'top-0.5',
      'size-6',
    )
  })

  it('keeps the same trigger node when the route changes', () => {
    const { rerender } = renderHost()
    const trigger = screen.getByTestId('bill-mascot-trigger')

    state.pathname = '/feedback'
    rerender(
      <MascotProvider>
        <MascotHost />
      </MascotProvider>,
    )

    expect(screen.getByTestId('bill-mascot-trigger')).toBe(trigger)
  })

  it('becomes personality-only on routes without a contextual action', async () => {
    state.pathname = '/feedback'
    vi.useFakeTimers()
    const { user } = renderHost()
    await finishWelcome()

    expect(screen.getByTestId('bill-mascot-docked')).toHaveAttribute(
      'data-mascot-size',
      'compact',
    )
    const trigger = screen.getByRole('button', { name: 'Say hello to Bill' })
    await user.click(trigger)

    expect(screen.getByTestId('bill-mascot')).toHaveAttribute(
      'data-mascot-size',
      'expanded',
    )
    expect(trigger).toHaveAttribute('data-reaction', 'welcome')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByTestId('bill-mascot-speech')).toHaveTextContent(
      'Nothing I can help with here right now.',
    )
  })

  it('cycles speech lines on each tap and wraps around', async () => {
    state.pathname = '/feedback'
    const { user } = renderHost()

    const trigger = screen.getByRole('button', { name: 'Say hello to Bill' })
    await user.click(trigger)
    expect(screen.getByTestId('bill-mascot-speech')).toHaveTextContent(
      'Nothing I can help with here right now.',
    )

    await user.click(trigger)
    expect(screen.getByTestId('bill-mascot-speech')).toHaveTextContent(
      'I can fill an expense from a receipt or a voice note.',
    )

    await user.click(trigger)
    const speech = screen.getByTestId('bill-mascot-speech')
    expect(speech).toHaveTextContent(
      'You can change or turn me off in mascot settings.',
    )
    expect(
      screen.getByRole('button', { name: 'Mascot settings' }),
    ).toBeInTheDocument()

    await user.click(trigger)
    expect(screen.getByTestId('bill-mascot-speech')).toHaveTextContent(
      'Nothing I can help with here right now.',
    )
  })

  it('offers a settings action until it is used', async () => {
    const { user } = renderHost()

    await user.click(
      screen.getByRole('button', { name: 'Open actions with Bill' }),
    )
    await user.click(screen.getByTestId('bill-mascot-settings'))

    expect(state.navigate).toHaveBeenCalledWith({
      to: '/account/settings',
      hash: 'account-preference-mascot',
    })
    expect(screen.queryByTestId('bill-mascot-settings')).toBeNull()
  })

  it('hides the settings action after the mascot preference is changed', async () => {
    const { user } = renderHost()

    await user.click(
      screen.getByRole('button', { name: 'Open actions with Bill' }),
    )
    expect(screen.getByTestId('bill-mascot-settings')).toBeInTheDocument()

    markMascotSettingsDiscovered('account-1')
    await waitFor(() => {
      expect(screen.queryByTestId('bill-mascot-settings')).toBeNull()
    })
  })

  it('sits behind an open modal without docking', async () => {
    vi.useFakeTimers()
    renderHost()
    await finishWelcome()

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)

    await waitFor(() => {
      expect(screen.getByTestId('bill-mascot')).toHaveAttribute(
        'data-mascot-blocked',
        'true',
      )
    })
    expect(screen.queryByTestId('bill-mascot-docked')).toBeNull()
    expect(screen.getByTestId('bill-mascot-trigger')).toBeInTheDocument()

    dialog.remove()
  })

  it('docks on focused form routes but stays clickable', async () => {
    vi.useFakeTimers()
    state.pathname = '/groups/create'
    const { user } = renderHost()
    await finishWelcome()

    expect(screen.getByTestId('bill-mascot-docked')).toBeInTheDocument()
    const trigger = screen.getByTestId('bill-mascot-trigger')
    expect(trigger).toHaveAttribute('aria-label', 'Say hello to Bill')

    await user.click(trigger)
    expect(screen.getByTestId('bill-mascot-speech')).toBeInTheDocument()
  })

  it('keeps dense mobile group pages present in the compact state', async () => {
    state.pathname = '/groups/group-1/balances'
    vi.useFakeTimers()
    renderHost()
    await finishWelcome()

    expect(screen.getByTestId('bill-mascot-docked')).toHaveAttribute(
      'data-mascot-size',
      'compact',
    )
  })

  it('keeps the importer mascot unobtrusive', () => {
    state.pathname = '/groups/group-1/tools/import'
    renderHost()

    const host = screen.getByTestId('bill-mascot-docked')
    expect(host).toHaveAttribute('data-mascot-size', 'compact')
    expect(screen.getByTestId('bill-mascot-trigger')).toHaveClass(
      'h-12',
      'w-12',
      'opacity-80',
    )
  })

  it('explains the missing action on settings after a tap', async () => {
    state.pathname = '/account/settings'
    const { user } = renderHost()

    const trigger = screen.getByRole('button', { name: 'Say hello to Bill' })
    await user.click(trigger)

    expect(screen.getByTestId('bill-mascot-speech')).toHaveTextContent(
      'Nothing I can help with here right now.',
    )
  })

  it('undocks and rises above an overlay while celebrating', async () => {
    vi.useFakeTimers()
    state.pathname = '/groups/create'
    const { user } = renderHost(<CelebrateButton />)
    await finishWelcome()

    expect(screen.getByTestId('bill-mascot-docked')).toBeInTheDocument()

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.append(dialog)

    await waitFor(() => {
      expect(screen.getByTestId('bill-mascot-docked')).toHaveAttribute(
        'data-mascot-blocked',
        'true',
      )
    })

    await user.click(screen.getByRole('button', { name: 'Celebrate' }))

    const host = screen.getByTestId('bill-mascot')
    expect(host).toHaveAttribute('data-mascot-docked', 'false')
    expect(host).toHaveAttribute('data-mascot-blocked', 'false')
    expect(host).toHaveAttribute('data-reaction', 'success')
    expect(host.className).toContain('z-70')

    dialog.remove()
  })

  it('lifts above a fixed action bar on all breakpoints', async () => {
    renderHost()

    const bar = document.createElement('div')
    bar.setAttribute('data-fixed-action-bar', '')
    document.body.append(bar)

    await waitFor(() => {
      const host = screen.getByTestId('bill-mascot')
      expect(host.className).toContain(
        'bottom-[calc(4.65rem+env(safe-area-inset-bottom))]',
      )
      expect(host.className).not.toContain('sm:bottom-5')
    })

    bar.remove()
  })

  it('waves welcome whenever a signed-in account appears', async () => {
    const { unmount } = renderHost()
    await waitFor(() => {
      expect(screen.getByTestId('bill-mascot')).toHaveAttribute(
        'data-reaction',
        'welcome',
      )
    })

    unmount()
    renderHost()
    await waitFor(() => {
      expect(screen.getByTestId('bill-mascot')).toHaveAttribute(
        'data-reaction',
        'welcome',
      )
    })
  })

  it('waves again after logout and login', async () => {
    const { rerender } = renderHost()
    await waitFor(() => {
      expect(screen.getByTestId('bill-mascot')).toHaveAttribute(
        'data-reaction',
        'welcome',
      )
    })

    state.account = null
    rerender(
      <MascotProvider>
        <MascotHost />
      </MascotProvider>,
    )
    expect(screen.queryByTestId('bill-mascot')).toBeNull()

    state.account = { id: 'account-1', name: 'Ada' }
    rerender(
      <MascotProvider>
        <MascotHost />
      </MascotProvider>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('bill-mascot')).toHaveAttribute(
        'data-reaction',
        'welcome',
      )
    })
  })

  it('uses a stored pin on fine-pointer desktops and skips the default bottom dock', () => {
    const media = vi
      .spyOn(window, 'matchMedia')
      .mockImplementation((query: string) => ({
        matches: query.includes('pointer: fine'),
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }))
    writeMascotPin('account-1', { x: 30, y: 40 })

    renderHost()

    const host = screen.getByTestId('bill-mascot')
    expect(host).toHaveAttribute('data-mascot-pinned', 'true')
    expect(host.style.left).toContain('vw')
    expect(host.style.top).toContain('vh')
    expect(host.className).not.toContain(
      'bottom-[calc(0.65rem+env(safe-area-inset-bottom))]',
    )
    media.mockRestore()
  })

  it('coaches tap-to-add after welcome when expense actions are available', async () => {
    vi.useFakeTimers()
    state.pathname = '/groups/group-1/expenses'
    renderHost(<GroupActionRegistration />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_300)
    })

    const speech = screen.getByTestId('bill-mascot-speech')
    expect(speech).toHaveTextContent("I'm Bill — tap me to add an expense.")
    expect(speech.className).toContain('absolute')
    expect(speech.parentElement).toContainElement(
      screen.getByTestId('bill-mascot-trigger'),
    )
    expect(speech.querySelector('[data-mascot-speech-tail]')).not.toBeNull()
    const badge = screen.getByTestId('bill-mascot-action-badge')
    expect(badge).toHaveAttribute('data-mascot-nudge', 'true')
    vi.useRealTimers()
  })

  it('marks actions discovered when the speed dial opens and keeps the badge', async () => {
    vi.useFakeTimers()
    state.pathname = '/groups/group-1/expenses'
    const { user } = renderHost(<GroupActionRegistration />)
    await finishWelcome()

    const trigger = screen.getByRole('button', {
      name: 'Open actions with Bill',
    })
    await user.click(trigger)

    expect(localStorage.getItem('mascotActionsDiscovered:account-1')).toBe('1')
    expect(screen.queryByTestId('bill-mascot-speech')).toBeNull()
    expect(screen.queryByTestId('bill-mascot-action-badge')).toBeNull()

    await user.click(
      screen.getByRole('button', { name: "Close Bill's actions" }),
    )
    const badge = screen.getByTestId('bill-mascot-action-badge')
    expect(badge).toHaveAttribute('data-mascot-nudge', 'false')
  })

  it('does not coach again after actions have been discovered', async () => {
    markMascotActionsDiscovered('account-1')
    vi.useFakeTimers()
    state.pathname = '/groups/group-1/expenses'
    renderHost(<GroupActionRegistration />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_300)
    })

    expect(screen.queryByTestId('bill-mascot-speech')).toBeNull()
    expect(screen.getByTestId('bill-mascot-action-badge')).toHaveAttribute(
      'data-mascot-nudge',
      'false',
    )
    vi.useRealTimers()
  })

  it('hides the action badge on personality-only routes', () => {
    state.pathname = '/feedback'
    renderHost()

    expect(screen.queryByTestId('bill-mascot-action-badge')).toBeNull()
  })

  it('coaches tap-to-create on home after welcome', async () => {
    vi.useFakeTimers()
    renderHost()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_300)
    })

    expect(screen.getByTestId('bill-mascot-speech')).toHaveTextContent(
      "I'm Bill — tap me to create a group.",
    )
    vi.useRealTimers()
  })

  it('hides create actions and stays compact while offline', async () => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: false,
    })
    vi.useFakeTimers()
    renderHost(<GroupActionRegistration />)

    const host = screen.getByTestId('bill-mascot-docked')
    expect(host).toHaveAttribute('data-mascot-offline', 'true')
    expect(host).toHaveAttribute('data-mascot-docked', 'true')
    expect(host).toHaveAttribute('data-mascot-size', 'compact')
    expect(host).toHaveAttribute('data-reaction', 'failure')
    expect(screen.getByTestId('bill-mascot-trigger')).toHaveClass(
      'h-16',
      'w-16',
    )
    expect(
      screen.getByRole('button', { name: 'Say hello to Bill' }),
    ).toBeInTheDocument()
    expect(screen.queryByTestId('bill-mascot-action-badge')).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_600)
    })
    expect(screen.getByTestId('bill-mascot-docked')).toHaveAttribute(
      'data-reaction',
      'failure',
    )
  })

  it('stays compact on non-primary focused routes while offline', () => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: false,
    })
    state.pathname = '/groups/create'
    renderHost()

    expect(screen.getByTestId('bill-mascot-docked')).toHaveAttribute(
      'data-mascot-size',
      'compact',
    )
    expect(screen.getByTestId('bill-mascot-trigger')).toHaveClass(
      'h-16',
      'w-16',
    )
  })

  it('explains that create actions are unavailable when tapped offline', async () => {
    Object.defineProperty(navigator, 'onLine', {
      configurable: true,
      value: false,
    })
    const { user } = renderHost()

    await user.click(screen.getByRole('button', { name: 'Say hello to Bill' }))

    expect(screen.getByTestId('bill-mascot-speech')).toHaveTextContent(
      "I can't create anything while you're offline.",
    )
    expect(screen.getByTestId('bill-mascot')).toHaveAttribute(
      'data-reaction',
      'failure',
    )
  })
})
