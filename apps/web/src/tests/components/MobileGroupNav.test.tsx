import { describe, expect, it, vi } from 'vitest'

import { GroupMobileAppBar, MobileGroupNav } from '@/components/mobile-shell'
import { render, screen } from '@/test/test-utils'

vi.mock('@tanstack/react-router', () => ({
  useLocation: ({ select }: { select: (value: unknown) => unknown }) =>
    select({ pathname: '/groups/group-1/expenses' }),
  Link: ({
    to,
    children,
    search,
    ...props
  }: {
    to: string
    children?: React.ReactNode
    search?: unknown
    [key: string]: unknown
  }) => (
    <a
      href={to}
      data-search={search ? JSON.stringify(search) : undefined}
      {...props}
    >
      {children}
    </a>
  ),
}))

vi.mock('@/components/account-menu', () => ({
  AccountMenu: () => <button type="button">Account</button>,
}))
vi.mock('@/components/currency-converter/currency-converter', () => ({
  CurrencyConverterButton: () => <button type="button">Currency</button>,
}))
vi.mock('@/components/locale-switcher', () => ({
  LocaleSwitcher: () => <button type="button">Locale</button>,
}))
vi.mock('@/components/theme-toggle', () => ({
  ThemeToggle: () => <button type="button">Theme</button>,
}))
vi.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
}))
vi.mock('@/app/groups/view-only-badge', () => ({
  ViewOnlyBadge: () => <span data-testid="view-only-badge">View only</span>,
}))
vi.mock('@/app/groups/[groupId]/use-group-access-search', () => ({
  useGroupAccessSearch: () => ({
    linkInviteToken: 'invite-token',
    viewKey: 'view-key',
  }),
}))

vi.mock('@/app/groups/[groupId]/current-group-context', () => ({
  useCurrentGroup: () => ({
    groupId: 'group-1',
    group: { id: 'group-1', name: 'Long group name', groupType: 'GROUP' },
    displayName: 'Long group name',
    viewer: { source: 'PUBLIC_LINK' },
  }),
}))

vi.mock('@/components/ui/responsive-dialog', () => ({
  ResponsiveDialog: ({ children }: React.PropsWithChildren) => children,
  ResponsiveDialogBody: ({ children }: React.PropsWithChildren) => children,
  ResponsiveDialogClose: ({ render }: { render: React.ReactNode }) => render,
  ResponsiveDialogContent: ({ children }: React.PropsWithChildren) => children,
  ResponsiveDialogHeader: ({ children }: React.PropsWithChildren) => children,
  ResponsiveDialogTitle: ({ children }: React.PropsWithChildren) => children,
}))

describe('MobileGroupNav', () => {
  it('lists Tools in the group actions menu', () => {
    render(<MobileGroupNav groupId="group-1" />)

    expect(screen.getByRole('link', { name: 'Tools' })).toHaveAttribute(
      'href',
      '/groups/$groupId/tools',
    )
  })

  it('includes feedback in the group actions menu', () => {
    render(<MobileGroupNav groupId="group-1" />)

    expect(screen.getByRole('link', { name: 'Feedback' })).toHaveAttribute(
      'href',
      '/feedback',
    )
  })

  it('preserves access credentials on every group navigation link', () => {
    render(<MobileGroupNav groupId="group-1" />)

    const groupLinks = screen
      .getAllByRole('link')
      .filter((link) => link.getAttribute('href')?.startsWith('/groups/'))

    expect(groupLinks.length).toBeGreaterThan(0)
    for (const link of groupLinks) {
      expect(link).toHaveAttribute(
        'data-search',
        '{"invite":"invite-token","viewKey":"view-key"}',
      )
    }
  })

  it('renders group context and preserves access search params', () => {
    render(<GroupMobileAppBar />)

    expect(screen.getByTestId('view-only-badge')).toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: 'Long group name' }),
    ).toHaveAttribute(
      'data-search',
      '{"invite":"invite-token","viewKey":"view-key"}',
    )
  })
})
