import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'

import { CreateExpenseFab } from '@/app/groups/create-expense-fab'
import { SyncedAccountPreferencesProvider } from '@/components/account-preferences-sync'
import {
  MascotProvider,
  useMascotState,
} from '@/components/mascot/mascot-context'
import { render, screen, within } from '@/test/test-utils'

const state = vi.hoisted(() => ({
  pathname: '/',
  currentGroup: null as {
    groupId: string
    group: { id: string; archived: boolean }
    currentInvitation: null
  } | null,
  navigate: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
  useLocation: ({ select }: { select: (value: unknown) => unknown }) =>
    select({ pathname: state.pathname }),
  useNavigate: () => state.navigate,
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string
    children?: React.ReactNode
    [key: string]: unknown
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('@/app/groups/[groupId]/current-group-context', () => ({
  useCurrentGroupOrNull: () => state.currentGroup,
}))

vi.mock('@/trpc/client', () => ({
  trpc: {
    overview: {
      get: {
        useQuery: () => ({
          data: {
            groups: [
              {
                id: 'group-1',
                name: 'Trip',
                displayName: null,
                archived: false,
                ledger: { currency: '$', currencyCode: 'USD' },
              },
            ],
          },
        }),
      },
    },
    groups: {
      get: {
        useQuery: () => ({ data: undefined, isPending: false, error: null }),
      },
    },
  },
}))

vi.mock('@/app/groups/[groupId]/expenses/ai-expense-preview', () => ({
  AiExpensePreview: () => null,
}))

vi.mock('@/app/groups/[groupId]/expenses/create-from-receipt-button', () => ({
  CreateFromReceiptButton: ({
    open,
    onOpenChange,
    onFlowActiveChange,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onFlowActiveChange: (active: boolean) => void
  }) =>
    open ? (
      <dialog open aria-label="Scan receipt">
        <button
          type="button"
          onClick={() => {
            onOpenChange(false)
            onFlowActiveChange(true)
          }}
        >
          Review receipt
        </button>
        <button type="button" onClick={() => onFlowActiveChange(false)}>
          Close receipt
        </button>
      </dialog>
    ) : null,
  ReceiptScanTrigger: () => null,
}))

vi.mock('@/app/groups/[groupId]/expenses/voice-expense-button', () => ({
  VoiceExpenseButton: ({
    open,
    onOpenChange,
    onFlowActiveChange,
  }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    onFlowActiveChange: (active: boolean) => void
  }) => {
    const [review, setReview] = React.useState(false)
    if (!open && !review) return null
    if (review) {
      return (
        <dialog open aria-label="Voice expense review">
          <button
            type="button"
            onClick={() => {
              setReview(false)
              onFlowActiveChange(false)
            }}
          >
            Close voice
          </button>
        </dialog>
      )
    }
    return (
      <dialog open aria-label="Voice expense">
        <button
          type="button"
          onClick={() => {
            onOpenChange(false)
            onFlowActiveChange(true)
            setReview(true)
          }}
        >
          Review voice expense
        </button>
      </dialog>
    )
  },
}))

describe('CreateExpenseFab', () => {
  function MascotActionProbe() {
    const mascot = useMascotState()
    return (
      <div data-testid="mascot-actions">
        {mascot?.actions.map((action) => (
          <button key={action.id} type="button" onClick={action.onSelect}>
            {action.label}
          </button>
        ))}
      </div>
    )
  }

  it('does not render outside a group context', () => {
    render(<CreateExpenseFab enableReceiptExtract enableVoiceExpense />)

    expect(
      screen.queryByTestId('expense-action-control'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Open expense actions' }),
    ).not.toBeInTheDocument()
  })

  it('renders the desktop composite and mobile speed dial together', () => {
    state.currentGroup = {
      groupId: 'group-1',
      group: { id: 'group-1', archived: false },
      currentInvitation: null,
    }

    render(<CreateExpenseFab enableReceiptExtract enableVoiceExpense />)

    const control = screen.getByTestId('expense-action-control')
    expect(
      within(control).getByRole('button', { name: 'Add expense' }),
    ).toHaveAttribute('href', '/groups/$groupId/expenses/create')
    expect(
      within(control).getByRole('button', { name: 'Voice expense' }),
    ).toBeInTheDocument()
    expect(
      within(control).getByRole('button', { name: 'Scan receipt' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Open expense actions' }),
    ).toBeInTheDocument()

    state.currentGroup = null
  })

  it('registers expense actions with Bill instead of rendering duplicate controls', async () => {
    state.currentGroup = {
      groupId: 'group-1',
      group: { id: 'group-1', archived: false },
      currentInvitation: null,
    }

    const { user } = render(
      <SyncedAccountPreferencesProvider
        value={{
          defaultCurrencyCode: 'USD',
          timeZone: 'UTC',
          locale: 'en-US',
          theme: 'system',
          mascot: 'bill',
          aiCategoryExtractEnabled: true,
          aiReceiptScanEnabled: true,
          aiVoiceExpenseEnabled: true,
        }}
      >
        <MascotProvider>
          <CreateExpenseFab enableReceiptExtract enableVoiceExpense />
          <MascotActionProbe />
        </MascotProvider>
      </SyncedAccountPreferencesProvider>,
    )

    expect(screen.queryByTestId('expense-action-control')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Open expense actions' }),
    ).toBeNull()

    const actions = await screen.findByTestId('mascot-actions')
    expect(
      within(actions).getByRole('button', { name: 'Add expense' }),
    ).toBeInTheDocument()
    expect(
      within(actions).getByRole('button', { name: 'Voice expense' }),
    ).toBeInTheDocument()
    expect(
      within(actions).getByRole('button', { name: 'Scan receipt' }),
    ).toBeInTheDocument()
    // Import moved to the Tools tab and is no longer a mascot action.
    expect(
      within(actions).queryByRole('button', { name: 'Import expenses' }),
    ).toBeNull()

    await user.click(
      within(actions).getByRole('button', { name: 'Add expense' }),
    )
    expect(state.navigate).toHaveBeenCalledWith({
      to: '/groups/$groupId/expenses/create',
      params: { groupId: 'group-1' },
    })

    state.currentGroup = null
  })

  it('routes a known-group manual action directly to the expense form', async () => {
    state.currentGroup = {
      groupId: 'group-1',
      group: { id: 'group-1', archived: false },
      currentInvitation: null,
    }

    render(
      <CreateExpenseFab
        enableReceiptExtract={false}
        enableVoiceExpense={false}
      />,
    )

    // Scope the query to the desktop wrapper so both surfaces stay valid.
    const control = screen.getByTestId('expense-action-control')
    const addExpense = within(control).getByRole('button', {
      name: 'Add expense',
    })
    expect(addExpense).toHaveAttribute(
      'href',
      '/groups/$groupId/expenses/create',
    )
    state.currentGroup = null
  })

  it('keeps the action surfaces hidden through capture and review', async () => {
    state.currentGroup = {
      groupId: 'group-1',
      group: { id: 'group-1', archived: false },
      currentInvitation: null,
    }

    const { user } = render(
      <CreateExpenseFab enableReceiptExtract enableVoiceExpense />,
    )

    await user.click(screen.getByRole('button', { name: 'Voice expense' }))
    expect(
      screen.queryByTestId('expense-action-control'),
    ).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('button', { name: 'Review voice expense' }),
    )
    expect(
      screen.queryByTestId('expense-action-control'),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Close voice' }))
    expect(screen.getByTestId('expense-action-control')).toBeInTheDocument()

    state.currentGroup = null
  })

  it('hides the action surfaces on group budget routes', () => {
    state.pathname = '/groups/group-1/budgets'
    state.currentGroup = {
      groupId: 'group-1',
      group: { id: 'group-1', archived: false },
      currentInvitation: null,
    }

    render(<CreateExpenseFab enableReceiptExtract enableVoiceExpense />)

    expect(
      screen.queryByTestId('expense-action-control'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Open expense actions' }),
    ).not.toBeInTheDocument()

    state.pathname = '/'
    state.currentGroup = null
  })

  it('collapses to a single primary action when no AI surface is enabled', () => {
    state.currentGroup = {
      groupId: 'group-1',
      group: { id: 'group-1', archived: false },
      currentInvitation: null,
    }

    render(
      <CreateExpenseFab
        enableReceiptExtract={false}
        enableVoiceExpense={false}
      />,
    )

    // Desktop control still offers manual create.
    const control = screen.getByTestId('expense-action-control')
    expect(
      within(control).getByRole('button', { name: 'Add expense' }),
    ).toHaveAttribute('href', '/groups/$groupId/expenses/create')
    // Mobile collapses to a single button now that import lives in Tools:
    // no speed-dial trigger and no import action anywhere.
    expect(
      screen.queryByRole('button', { name: 'Open expense actions' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Import expenses' }),
    ).not.toBeInTheDocument()
    expect(screen.getByTestId('create-expense-fab-mobile')).toHaveAttribute(
      'href',
      '/groups/$groupId/expenses/create',
    )
    state.currentGroup = null
  })

  it('offers no import action on the expense list (import lives in Tools)', () => {
    state.pathname = '/groups/group-1/expenses'
    state.currentGroup = {
      groupId: 'group-1',
      group: { id: 'group-1', archived: false },
      currentInvitation: null,
    }

    render(
      <CreateExpenseFab
        enableReceiptExtract={false}
        enableVoiceExpense={false}
      />,
    )

    expect(screen.getByTestId('expense-action-control')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Import expenses' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('menuitem', { name: 'Import expenses' }),
    ).not.toBeInTheDocument()
    // Without AI surfaces the mobile FAB goes straight to manual create.
    expect(screen.getByTestId('create-expense-fab-mobile')).toHaveAttribute(
      'href',
      '/groups/$groupId/expenses/create',
    )

    state.pathname = '/'
    state.currentGroup = null
  })

  it('keeps the SpeedDial when at least one AI surface is available', () => {
    state.currentGroup = {
      groupId: 'group-1',
      group: { id: 'group-1', archived: false },
      currentInvitation: null,
    }

    render(<CreateExpenseFab enableReceiptExtract enableVoiceExpense={false} />)

    // Scan enabled, voice disabled: still falls into the SpeedDial path
    // because the user gets two affordances (scan + create).
    expect(
      screen.getByRole('button', { name: 'Open expense actions' }),
    ).toBeInTheDocument()

    state.currentGroup = null
  })

  it('keeps closed SpeedDial actions inert until the menu is opened', async () => {
    state.currentGroup = {
      groupId: 'group-1',
      group: { id: 'group-1', archived: false },
      currentInvitation: null,
    }

    const { container, user } = render(
      <CreateExpenseFab enableReceiptExtract enableVoiceExpense={false} />,
    )
    const manualAction = container.querySelector<HTMLButtonElement>(
      '[data-speed-dial-action][aria-label="Add expense"]',
    )

    expect(manualAction).toBeDisabled()
    expect(manualAction).toHaveClass('pointer-events-none')
    manualAction?.click()
    expect(state.navigate).not.toHaveBeenCalled()

    await user.click(
      screen.getByRole('button', { name: 'Open expense actions' }),
    )

    expect(manualAction).toBeEnabled()
    expect(manualAction).toHaveClass('pointer-events-auto')

    state.currentGroup = null
  })
})
