import { beforeEach, describe, expect, it, vi } from 'vitest'

import { render, screen } from '@/test/test-utils'

const mocks = vi.hoisted(() => ({
  mockUseCurrentGroup: vi.fn(),
}))

vi.mock('@/app/groups/[groupId]/current-group-context', () => ({
  useCurrentGroup: mocks.mockUseCurrentGroup,
  useCurrentGroupOrNull: () => null,
  useIsReadOnlyGroupViewer: () => false,
}))

vi.mock('@/trpc/client', () => ({
  trpc: {
    account: {
      members: {
        useQuery: vi.fn(() => ({ data: { members: [] }, isLoading: false })),
      },
    },
    groups: {
      archive: {
        useMutation: vi.fn(() => ({ mutateAsync: vi.fn() })),
      },
      get: {
        useQuery: vi.fn(() => ({ data: null })),
      },
    },
    useUtils: () => ({
      account: { groups: { invalidate: vi.fn() } },
      overview: { get: { invalidate: vi.fn() } },
      groups: { get: { invalidate: vi.fn() } },
    }),
  },
}))

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
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
  useLocation: (opts?: {
    select?: (location: { pathname: string }) => unknown
  }) => {
    const location = { pathname: '/groups/group-1/expenses' }
    return opts?.select ? opts.select(location) : location
  },
}))

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}))

import { GroupTabs } from '@/app/groups/[groupId]/group-tabs'

describe('GroupTabs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mockUseCurrentGroup.mockReturnValue({
      group: { id: 'group-1', groupType: 'GROUP' },
      currentMember: { role: 'ADMIN' },
    })
  })

  it('renders Members tab when groupType is GROUP', () => {
    render(<GroupTabs groupId="group-1" />)
    expect(screen.getByRole('tab', { name: /Members/i })).toBeInTheDocument()
    expect(
      screen.queryByRole('tab', { name: /Information/i }),
    ).not.toBeInTheDocument()
  })

  it('hides Members tab when groupType is FRIEND', () => {
    mocks.mockUseCurrentGroup.mockReturnValue({
      group: { id: 'group-1', groupType: 'FRIEND' },
      currentMember: { role: 'ADMIN' },
    })
    render(<GroupTabs groupId="group-1" />)
    expect(
      screen.queryByRole('tab', { name: /Members/i }),
    ).not.toBeInTheDocument()
  })

  it('renders Tools tab immediately before Settings', () => {
    mocks.mockUseCurrentGroup.mockReturnValue({
      group: { id: 'group-1', groupType: 'GROUP' },
      currentMember: { role: 'ADMIN' },
      viewer: { source: 'MEMBER' },
    })
    render(<GroupTabs groupId="group-1" />)

    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent ?? '')
    const toolsIndex = tabs.findIndex((label) => label === 'Tools')
    const settingsIndex = tabs.findIndex((label) => /Settings/.test(label))
    expect(toolsIndex).toBeGreaterThan(-1)
    expect(settingsIndex).toBeGreaterThan(-1)
    expect(toolsIndex).toBe(settingsIndex - 1)
  })
})
