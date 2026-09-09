import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AccountSettingsPage } from '@/app/account/settings'
import { render, screen, waitFor } from '@/test/test-utils'

const mocks = vi.hoisted(() => ({
  useCurrentAccount: vi.fn(),
  updateProfile: vi.fn(),
  invalidateAccount: vi.fn(),
  invalidateGroups: vi.fn(),
  invalidateInvitations: vi.fn(),
  refetchAccount: vi.fn(),
  toast: vi.fn(),
  useRouterNavigate: vi.fn(),
  accountGroups: vi.fn(),
}))

vi.mock('@/lib/use-current-account', () => ({
  useCurrentAccount: mocks.useCurrentAccount,
}))

vi.mock('@/components/require-auth', () => ({
  RequireAuth: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock(import('@/lib/upload'), async (importOriginal) => ({
  ...(await importOriginal()),
  prepareProfileImage: vi.fn(),
}))

vi.mock('@/app/account/account-preferences', () => ({
  AccountPreferences: () => (
    <section data-testid="app-preferences-mock">
      <h2>App preferences</h2>
    </section>
  ),
}))

vi.mock('@/app/account/ai-preferences', () => ({
  AccountAiPreferences: () => (
    <section data-testid="ai-preferences-mock">
      <h2>AI features</h2>
    </section>
  ),
}))

vi.mock('@/app/account/notifications-preferences', () => ({
  NotificationsPreferences: () => (
    <section data-testid="notifications-mock">
      <h2>Notifications</h2>
    </section>
  ),
}))

vi.mock('@/trpc/client', () => ({
  trpc: {
    useUtils: () => ({
      account: {
        invalidate: mocks.invalidateAccount,
        authorizedClients: { invalidate: vi.fn() },
      },
      groups: { invalidate: mocks.invalidateGroups },
      invitations: { invalidate: mocks.invalidateInvitations },
    }),
    account: {
      // The settings page renders the connected-apps section, which reads
      // these two.
      authorizedClients: {
        useQuery: () => ({
          data: { clients: [] },
          isPending: false,
          isError: false,
        }),
      },
      revokeAuthorizedClient: {
        useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      },
      groups: {
        useQuery: () => ({
          data: { groups: mocks.accountGroups() },
          isPending: false,
          isError: false,
          refetch: vi.fn(),
        }),
      },
      updateProfile: {
        useMutation: () => ({ mutateAsync: mocks.updateProfile }),
      },
      removeProfileImage: {
        useMutation: () => ({ mutateAsync: vi.fn() }),
      },
      setProfileImage: {
        useMutation: () => ({ mutateAsync: vi.fn() }),
      },
    },
    uploads: {
      profileImagePresign: {
        useMutation: () => ({ mutateAsync: vi.fn() }),
      },
    },
  },
}))

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: mocks.toast }),
}))

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual('@tanstack/react-router')
  return {
    ...actual,
    useNavigate: () => mocks.useRouterNavigate,
    useLocation: () => ({ hash: window.location.hash }),
    Link: ({
      to,
      search,
      children,
      ...props
    }: {
      to: string
      search?: unknown
      children?: React.ReactNode
      [key: string]: unknown
    }) => (
      <a href={to} data-search={JSON.stringify(search)} {...props}>
        {children}
      </a>
    ),
  }
})

const accountFixture = {
  id: 'account-1',
  name: 'Current Name',
  email: 'user@example.com',
  emailVerified: true,
  image: null,
  isAnonymous: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.updateProfile.mockResolvedValue(undefined)
  mocks.invalidateAccount.mockResolvedValue(undefined)
  mocks.invalidateGroups.mockResolvedValue(undefined)
  mocks.invalidateInvitations.mockResolvedValue(undefined)
  mocks.refetchAccount.mockResolvedValue(undefined)
  mocks.useCurrentAccount.mockReturnValue({
    data: accountFixture,
    isPending: false,
    isRefetching: false,
    error: null,
    refetch: mocks.refetchAccount,
  })
  mocks.accountGroups.mockReturnValue([])
})

describe('AccountSettingsPage', () => {
  it('renders a single h1 and six h2 sections in the documented order', () => {
    render(<AccountSettingsPage />)

    const headings = screen.getAllByRole('heading')
    const h1Count = headings.filter(
      (heading) => heading.tagName === 'H1',
    ).length
    expect(h1Count).toBe(1)

    const h2Names = headings
      .filter((heading) => heading.tagName === 'H2')
      .map((heading) => heading.textContent ?? '')
    expect(h2Names).toEqual([
      'Profile',
      'App preferences',
      'Connected apps',
      'Backups & export',
      'Notifications',
      'AI features',
    ])
  })

  it('disables the profile Save button until the name changes', async () => {
    const { user } = render(<AccountSettingsPage />)
    const saveButton = screen.getByRole('button', { name: /save changes/i })
    expect(saveButton).toBeDisabled()

    const nameInput = screen.getByRole('textbox', { name: /display name/i })
    await user.clear(nameInput)
    await user.type(nameInput, 'New Name')

    await waitFor(() => {
      expect(saveButton).not.toBeDisabled()
    })
  })

  it('renders anonymous recovery as a row inside Profile without a separate card', () => {
    mocks.useCurrentAccount.mockReturnValue({
      data: {
        ...accountFixture,
        email: 'guest-1@anonymous.placeholder.local',
        isAnonymous: true,
      },
      isPending: false,
      isRefetching: false,
      error: null,
      refetch: mocks.refetchAccount,
    })

    render(<AccountSettingsPage />)

    expect(screen.getByRole('heading', { name: 'Profile' })).toBeInTheDocument()
    expect(screen.getByText('Sign in link')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Replace sign in link' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Add email' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Link to account')).not.toBeInTheDocument()
    expect(screen.queryByText('Coming soon')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'Anonymous account' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Saved and confirmed')).not.toBeInTheDocument()
    expect(
      screen.queryByDisplayValue('guest-1@anonymous.placeholder.local'),
    ).not.toBeInTheDocument()
  })

  it('lets GitHub accounts without a real email add one', () => {
    mocks.useCurrentAccount.mockReturnValue({
      data: {
        ...accountFixture,
        email: '789@github.placeholder.local',
        emailVerified: false,
        isAnonymous: false,
      },
      isPending: false,
      isRefetching: false,
      error: null,
      refetch: mocks.refetchAccount,
    })

    render(<AccountSettingsPage />)

    expect(screen.getByText('No email')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Add email' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByDisplayValue('789@github.placeholder.local'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Sign in link')).not.toBeInTheDocument()
  })

  it('opens the lightweight account export configuration modal', async () => {
    const { user } = render(<AccountSettingsPage />)

    await user.click(screen.getByRole('button', { name: /^export$/i }))

    expect(
      screen.getByRole('dialog', { name: /export account backup/i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/ledgers selected/i)).toBeInTheDocument()
  })

  it('opens the Spliit Cloud importer from the backup section', () => {
    render(<AccountSettingsPage />)

    const importLink = screen.getByRole('button', { name: /^import$/i })
    expect(importLink).toHaveAttribute('href', '/groups/import')
    expect(importLink).toHaveAttribute(
      'data-search',
      JSON.stringify({ source: 'spliit-cloud' }),
    )
  })

  it('shows a mixed section checkbox when a group override makes selection partial', async () => {
    mocks.accountGroups.mockReturnValue([
      {
        id: 'group-1',
        displayName: 'Alpha',
        groupType: 'GROUP',
        archived: false,
        preference: { starred: false, hidden: false },
      },
      {
        id: 'group-2',
        displayName: 'Beta',
        groupType: 'GROUP',
        archived: false,
        preference: { starred: false, hidden: false },
      },
    ])
    const { user } = render(<AccountSettingsPage />)

    await user.click(screen.getByRole('button', { name: /^export$/i }))
    await user.click(screen.getByRole('checkbox', { name: /^Alpha/ }))

    expect(screen.getByRole('checkbox', { name: /^Groups/ })).toHaveAttribute(
      'aria-checked',
      'mixed',
    )
  })
})
