import * as React from 'react'
import { describe, expect, it, vi } from 'vitest'

import GroupToolsPage from '@/app/groups/[groupId]/tools/tools-page'
import { render, screen } from '@/test/test-utils'

const state = vi.hoisted(() => ({
  groupContext: null as {
    groupId: string
    group: { id: string; archived: boolean }
    viewer: { canMutate: boolean } | null
    currentInvitation: null
  } | null,
}))

vi.mock('@/app/groups/[groupId]/current-group-context', () => ({
  useCurrentGroupOrNull: () => state.groupContext,
}))

vi.mock('@tanstack/react-router', () => ({
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

describe('GroupToolsPage', () => {
  it('links the import card to the tools importer for editors', () => {
    state.groupContext = {
      groupId: 'group-1',
      group: { id: 'group-1', archived: false },
      viewer: { canMutate: true },
      currentInvitation: null,
    }

    render(<GroupToolsPage />)

    expect(
      screen.getByRole('button', { name: 'Start import' }),
    ).toHaveAttribute('href', '/groups/$groupId/tools/import')

    state.groupContext = null
  })

  it('disables the import action for read-only viewers', () => {
    state.groupContext = {
      groupId: 'group-1',
      group: { id: 'group-1', archived: false },
      viewer: { canMutate: false },
      currentInvitation: null,
    }

    render(<GroupToolsPage />)

    expect(screen.getByRole('button', { name: 'Start import' })).toBeDisabled()
    expect(
      screen.getByText('Only active group members can import expenses.'),
    ).toBeInTheDocument()

    state.groupContext = null
  })

  it('explains the disabled import action for archived groups', () => {
    state.groupContext = {
      groupId: 'group-1',
      group: { id: 'group-1', archived: true },
      viewer: { canMutate: true },
      currentInvitation: null,
    }

    render(<GroupToolsPage />)

    expect(screen.getByRole('button', { name: 'Start import' })).toBeDisabled()
    expect(screen.getByText('This group is archived.')).toBeInTheDocument()

    state.groupContext = null
  })
})
