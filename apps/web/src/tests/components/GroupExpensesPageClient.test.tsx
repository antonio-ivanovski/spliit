import { describe, expect, it, vi } from 'vitest'

import GroupExpensesPageClient from '@/app/groups/[groupId]/expenses/page.client'
import { render, screen } from '@/test/test-utils'

vi.mock('@/app/groups/[groupId]/expenses/expense-list', () => ({
  ExpenseList: () => <div>Expense list</div>,
}))

describe('expenses header', () => {
  it('renders without a bulk import action (import lives in Tools)', () => {
    render(<GroupExpensesPageClient />)

    expect(screen.getByText('Expense list')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /import/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('link', { name: /import/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Add expense' }),
    ).not.toBeInTheDocument()
  })
})
