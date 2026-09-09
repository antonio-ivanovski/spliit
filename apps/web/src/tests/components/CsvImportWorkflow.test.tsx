import type * as TanStackReactRouter from '@tanstack/react-router'
import { useState, useSyncExternalStore, useCallback } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ExpenseFileImportPage } from '@/app/groups/[groupId]/expenses/csv-import-page'
import {
  mapExpenseFile,
  previewExpenseFile,
} from '@/app/groups/[groupId]/expenses/csv-import-worker-client'
import type * as ImportWorkerClient from '@/app/groups/[groupId]/expenses/csv-import-worker-client'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@/test/test-utils'
import type { Expense } from '@spliit/domain'
import {
  previewDelimitedRows,
  type DelimitedPreviewRow,
} from '@spliit/domain/import'

const state = vi.hoisted(() => ({
  search: {} as { editRow?: string },
  listeners: new Set<() => void>(),
  paramListeners: new Set<() => void>(),
  params: { groupId: 'group-1' },
  history: vi.fn(),
  import: vi.fn(),
  duplicateReset: vi.fn(),
  duplicateCalls: vi.fn(),
}))
function navigate(options: {
  search:
    | typeof state.search
    | ((previous: typeof state.search) => typeof state.search)
}) {
  state.search =
    typeof options.search === 'function'
      ? options.search(state.search)
      : options.search
  state.listeners.forEach((listener) => listener())
}
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof TanStackReactRouter>()),
  getRouteApi: () => ({
    useParams: () =>
      useSyncExternalStore(
        (listener) => {
          state.paramListeners.add(listener)
          return () => state.paramListeners.delete(listener)
        },
        () => state.params,
      ),
    useSearch: () =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener)
          return () => state.listeners.delete(listener)
        },
        () => state.search,
      ),
  }),
  useNavigate: () => navigate,
  useBlocker: () => ({ status: 'idle' }),
  Link: ({ children }: { children: React.ReactNode }) => (
    <span>{children}</span>
  ),
}))
vi.mock('@/components/account-preferences-sync', () => ({
  useSyncedAccountPreferences: () => ({ timeZone: 'UTC' }),
}))
vi.mock(
  '@/app/groups/[groupId]/expenses/csv-import-worker-client',
  async (importOriginal) => {
    const original = await importOriginal<typeof ImportWorkerClient>()
    return {
      ...original,
      previewExpenseFile: vi.fn(original.previewExpenseFile),
      mapExpenseFile: vi.fn(original.mapExpenseFile),
    }
  },
)
vi.mock('@/trpc/client', () => ({
  trpc: {
    useUtils: () => ({
      groups: {
        expenses: {
          categoryMemory: { fetch: state.history },
          list: { invalidate: vi.fn() },
        },
        balances: { list: { invalidate: vi.fn() } },
        activities: { list: { invalidate: vi.fn() } },
        get: { invalidate: vi.fn() },
      },
    }),
    groups: {
      get: {
        useQuery: () => ({
          data: {
            group: {
              id: 'group-1',
              name: 'Group',
              currencyCode: 'USD',
              currency: '$',
              archived: false,
              participants: [
                { id: 'alice', name: 'Alice' },
                { id: 'bob', name: 'Bob' },
              ],
            },
            viewer: { canMutate: true },
            currentLedgerParticipantId: 'alice',
          },
          isPending: false,
        }),
      },
      expenses: {
        importFile: { useMutation: () => ({ mutateAsync: state.import }) },
        previewImportDuplicates: {
          useMutation: () => {
            const [result, setResult] = useState<{
              variables?: { rows: { rowId: string }[] }
              data?: { rows: { rowId: string; matches: never[] }[] }
            }>({})
            const mutate = useCallback(
              (
                variables: {
                  rows: { rowId: string; expense: { title: string } }[]
                },
                options: {
                  onSuccess: (data: {
                    rows: { rowId: string; matches: never[] }[]
                  }) => void
                },
              ) => {
                state.duplicateCalls(variables)
                const data = {
                  rows: variables.rows.map((row) => ({
                    rowId: row.rowId,
                    matches: [] as never[],
                  })),
                }
                setResult({ variables, data })
                options.onSuccess(data)
              },
              [],
            )
            const reset = useCallback(() => {
              state.duplicateReset()
              setResult({})
            }, [])
            return { ...result, mutate, reset, isPending: false }
          },
        },
      },
    },
  },
}))
// Exercise the wizard's full-form save contract, without unrelated upload,
// receipt and recurrence controls. Mapping editors and worker evaluation are real.
vi.mock('@/app/groups/[groupId]/expenses/expense-form', () => ({
  ExpenseForm: ({
    draftExpense,
    onSubmit,
    onSaved,
  }: {
    draftExpense: Expense
    onSubmit: (expense: Expense) => Promise<string>
    onSaved: () => Promise<void>
  }) => {
    const [title, setTitle] = useState(draftExpense.title)
    return (
      <div>
        <label>
          Edited title
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <button
          onClick={async () => {
            await onSubmit({ ...draftExpense, title, category: 'groceries' })
            await onSaved()
          }}
        >
          Save edited expense
        </button>
      </div>
    )
  },
}))

beforeEach(() => {
  state.search = {}
  state.params = { groupId: 'group-1' }
  state.history.mockReset().mockResolvedValue({ expenses: [] })
  state.duplicateReset.mockReset()
  state.duplicateCalls.mockReset()
  state.import
    .mockReset()
    .mockImplementation(async ({ rows }: { rows: unknown[] }) => ({
      importedCount: rows.length,
    }))
  vi.mocked(previewExpenseFile).mockImplementation(
    async (table, mapping, options) =>
      previewDelimitedRows(table, mapping, options),
  )
  vi.mocked(mapExpenseFile).mockClear()
  vi.spyOn(window.history, 'back').mockImplementation(() =>
    navigate({ search: {} }),
  )
})

const csv =
  'Date,Description,Amount,Corrected amount\n2022-03-14,Zorb market,10,20\n2022-03-15,Zorb market,10,20\n2022-03-16,Zorb markat,10,20'
async function upload(user: ReturnType<typeof render>['user'], content = csv) {
  const file = new File([content], 'expenses.csv', { type: 'text/csv' })
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => new TextEncoder().encode(content).buffer,
  })
  await user.upload(screen.getByLabelText('Expense file'), file)
  await user.click(
    await screen.findByRole('button', { name: 'Continue to mapping' }),
  )
  await screen.findByText('Required field mappings')
}
function page() {
  return render(<ExpenseFileImportPage runtimeFeatureFlags={{} as never} />)
}

describe('expense import workflow', () => {
  it('accepts a file dropped on the step-1 dropzone', async () => {
    page()
    const content = 'Date,Description,Amount\n2022-03-14,Dropped merchant,10'
    const file = new File([content], 'dropped.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new TextEncoder().encode(content).buffer,
    })
    fireEvent.drop(
      screen.getByText('Drop your export here or click to choose a file'),
      { dataTransfer: { files: [file] } },
    )
    await screen.findByText('Dropped merchant')
  })

  it('keeps category controls and examples stable through delayed and out-of-order previews', async () => {
    const { user } = page()
    await upload(
      user,
      'Date,Description,Amount,Category\n' +
        Array.from(
          { length: 30 },
          (_, i) => `2022-03-14,Merchant ${i},10,Source ${i}`,
        ).join('\n'),
    )
    const search = screen.getByRole('textbox', {
      name: 'Find a source category',
    })
    await user.type(search, 'Source')
    await user.click(screen.getByRole('button', { name: 'Next categories' }))
    const preview = screen.getByRole('table', {
      name: 'Mapped expense preview rows',
    })
    const examples = screen.getAllByText(/Source row 2 → Expense 1/)
    const group = screen.getByRole('radiogroup', {
      name: 'Category mode for Source 25',
    })
    const titleRadio = within(group).getByRole('radio', {
      name: 'Detect from titles',
    })
    const pending: {
      rows: DelimitedPreviewRow[]
      resolve: (rows: DelimitedPreviewRow[]) => void
    }[] = []
    vi.mocked(previewExpenseFile).mockImplementation(
      (table, mapping, options) =>
        new Promise((resolve) => {
          pending.push({
            rows: previewDelimitedRows(table, mapping, options),
            resolve,
          })
        }),
    )

    await user.click(titleRadio)
    await waitFor(() => expect(pending).toHaveLength(1))
    expect(titleRadio).toBeChecked()
    expect(titleRadio).toHaveFocus()
    expect(
      screen.getByRole('table', { name: 'Mapped expense preview rows' }),
    ).toBe(preview)
    for (const example of examples) expect(example).toBeInTheDocument()
    expect(
      screen.queryByText('Updating mapping examples…'),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByText('Updating mapped values…'),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Review expenses' }),
    ).toBeDisabled()
    await screen.findByLabelText('Updating category suggestion')
    expect(
      screen.getAllByLabelText('Updating category suggestion'),
    ).toHaveLength(1)
    expect(
      within(group).getByLabelText('Updating category suggestion'),
    ).toBeInTheDocument()

    await user.click(
      within(
        screen.getByRole('radiogroup', { name: 'Category mode for Source 26' }),
      ).getByRole('radio', { name: 'Detect from titles' }),
    )
    await waitFor(() => expect(pending).toHaveLength(2))
    await act(async () => pending[1]!.resolve(pending[1]!.rows))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Review expenses' }),
      ).toBeEnabled(),
    )
    await act(async () =>
      pending[0]!.resolve(
        pending[0]!.rows.map((row) => ({
          ...row,
          title: 'Stale worker result',
        })),
      ),
    )
    expect(screen.queryByText('Stale worker result')).not.toBeInTheDocument()
    expect(
      screen.getByRole('textbox', { name: 'Find a source category' }),
    ).toBe(search)
    expect(search).toHaveValue('Source')
    expect(screen.getByText(/Page 2 of 2/)).toBeInTheDocument()
    expect(
      screen.getByRole('radiogroup', { name: 'Category mode for Source 25' }),
    ).toBe(group)
    expect(titleRadio).toBeChecked()
    expect(
      screen.queryByLabelText('Updating category suggestion'),
    ).not.toBeInTheDocument()
  })

  it('keeps number ambiguity blocked when saving an unrelated Money setting', async () => {
    const { user } = page()
    await upload(user, 'Date,Description,Amount\n2022-03-14,Cafe,"1,234"')
    expect(
      screen.getByRole('button', { name: 'Review expenses' }),
    ).toBeDisabled()
    await user.click(
      screen.getAllByRole('button', { name: 'Edit mapping' })[2]!,
    )
    await user.click(screen.getByRole('button', { name: 'Save mapping' }))
    expect(
      screen.getByRole('button', { name: 'Review expenses' }),
    ).toBeDisabled()
    await user.click(
      screen.getAllByRole('button', { name: 'Edit mapping' })[2]!,
    )
    await user.click(screen.getByRole('combobox', { name: 'Number format' }))
    await user.click(screen.getByRole('option', { name: /Comma decimal/ }))
    await user.click(screen.getByRole('button', { name: 'Save mapping' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Review expenses' }),
      ).toBeEnabled(),
    )
  })

  it('lets the user find source categories beyond the former 200-value limit', async () => {
    const { user } = page()
    await upload(
      user,
      'Date,Description,Amount,Category\n' +
        Array.from(
          { length: 205 },
          (_, index) => `2022-03-14,Merchant ${index},10,Source ${index}`,
        ).join('\n'),
    )
    await user.type(
      screen.getByRole('textbox', { name: 'Find a source category' }),
      'Source 204',
    )
    expect(
      screen.getByRole('radiogroup', { name: 'Category mode for Source 204' }),
    ).toBeInTheDocument()
    await user.click(
      within(
        screen.getByRole('radiogroup', {
          name: 'Category mode for Source 204',
        }),
      ).getByRole('radio', { name: /Detect from titles/ }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Review expenses' }),
      ).toBeEnabled(),
    )
    expect(
      within(
        screen.getByRole('radiogroup', {
          name: 'Category mode for Source 204',
        }),
      ).getByRole('radio', { name: /Detect from titles/ }),
    ).toBeChecked()
  })

  it('previews the filtered expenses for a source in both category modes', async () => {
    const { user } = page()
    await upload(
      user,
      'Date,Description,Amount,Category\n2022-03-14,Cafe,10,Dining\n2022-03-15,Bistro,20,Dining\n2022-03-16,Metro,30,Travel',
    )
    const group = screen.getByRole('radiogroup', {
      name: 'Category mode for Dining',
    })
    const viewButtons = screen.getAllByRole('button', {
      name: /View expenses for/,
    })
    expect(viewButtons).toHaveLength(2)
    await user.click(viewButtons[0]!)
    const dialog = await screen.findByRole('dialog', {
      name: 'Expenses for Dining',
    })
    expect(
      within(dialog).getByText(/Use selected category/),
    ).toBeInTheDocument()
    const table = within(dialog).getByRole('table', {
      name: 'Expenses for Dining',
    })
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Close' }))
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Expenses for Dining' }),
      ).not.toBeInTheDocument(),
    )

    await user.click(
      within(group).getByRole('radio', { name: 'Detect from titles' }),
    )
    await waitFor(() =>
      expect(
        within(
          screen.getByRole('radiogroup', { name: 'Category mode for Dining' }),
        ).getByRole('radio', { name: 'Detect from titles' }),
      ).toBeChecked(),
    )
    await user.click(
      screen.getAllByRole('button', { name: /View expenses for/ })[0]!,
    )
    const titleDialog = await screen.findByRole('dialog', {
      name: 'Expenses for Dining',
    })
    expect(
      within(titleDialog).getByText(/Detect from titles/),
    ).toBeInTheDocument()
    expect(
      within(
        within(titleDialog).getByRole('table', { name: 'Expenses for Dining' }),
      ).getAllByRole('row'),
    ).toHaveLength(3)
  })

  it('keeps the fallback category inside category mapping', async () => {
    const { user } = page()
    await upload(user)
    expect(screen.queryByText('Expense details')).not.toBeInTheDocument()
    expect(screen.queryByText('Default category')).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: 'Payer and split defaults' }),
    ).toBeInTheDocument()
    const mapping =
      screen.getByText('Category mapping').closest('div')?.parentElement ??
      document.body
    expect(
      within(mapping as HTMLElement).getByText(
        /Categories apply in this order/,
      ),
    ).toBeInTheDocument()
    expect(
      within(mapping as HTMLElement).getByText('Fallback category'),
    ).toBeInTheDocument()
    expect(
      within(mapping as HTMLElement).getByText(
        /no selected category and title detection finds no confident match/,
      ),
    ).toBeInTheDocument()
  })

  it('keeps the latest file when history resolves after a replacement upload', async () => {
    let resolveHistory!: (value: { expenses: never[] }) => void
    state.history.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveHistory = resolve
        }),
    )
    const { user } = page()
    for (const title of ['First file merchant', 'Second file merchant']) {
      const content = `Date,Description,Amount\n2022-03-14,${title},10`
      const file = new File([content], `${title}.csv`, { type: 'text/csv' })
      Object.defineProperty(file, 'arrayBuffer', {
        value: async () => new TextEncoder().encode(content).buffer,
      })
      await user.upload(screen.getByLabelText('Expense file'), file)
      await screen.findByText(title)
    }
    await act(async () => resolveHistory({ expenses: [] }))
    await user.click(
      screen.getByRole('button', { name: 'Continue to mapping' }),
    )
    await screen.findByText('Required field mappings')
    expect(screen.queryByText('First file merchant')).not.toBeInTheDocument()
    expect(screen.getAllByText('Second file merchant').length).toBeGreaterThan(
      0,
    )
    expect(state.history).toHaveBeenCalledTimes(1)
  })

  it('keeps category-only changes while remapping money, and only applies selected title matches', async () => {
    const { user } = page()
    await upload(user)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Review expenses' }),
      ).toBeEnabled(),
    )
    await user.click(screen.getByRole('button', { name: 'Review expenses' }))
    await user.click(await screen.findByRole('button', { name: 'Edit row 2' }))
    await user.click(
      screen.getByRole('button', { name: 'Save edited expense' }),
    )
    await user.click(
      await screen.findByRole('button', { name: 'Choose matching expenses' }),
    )
    const dialog = screen.getByRole('dialog')
    const candidates = within(dialog).getAllByRole('checkbox')
    expect(candidates[0]).toBeChecked()
    expect(candidates[1]).not.toBeChecked()
    await user.click(
      within(dialog).getByRole('button', { name: 'Apply to 1 expense' }),
    )
    await user.click(screen.getByRole('button', { name: 'Back to mapping' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Review expenses' }),
      ).toBeEnabled(),
    )
    await user.click(
      screen.getAllByRole('button', { name: 'Edit mapping' })[2]!,
    )
    await user.click(screen.getByRole('combobox', { name: 'Amount column' }))
    await user.click(screen.getByRole('option', { name: 'Corrected amount' }))
    await user.click(screen.getByRole('button', { name: 'Save mapping' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Review expenses' }),
      ).toBeEnabled(),
    )
    await user.click(screen.getByRole('button', { name: 'Review expenses' }))
    await user.click(
      await screen.findByRole('button', { name: 'Import 3 expenses' }),
    )
    await waitFor(() => expect(state.import).toHaveBeenCalled())
    const rows = state.import.mock.calls[0]![0].rows as { expense: Expense }[]
    expect(rows.map((row) => row.expense.amount)).toEqual([1000, 2000, 2000])
    expect(rows.map((row) => row.expense.category)).toEqual([
      'groceries',
      'groceries',
      'general',
    ])
    expect(state.history).toHaveBeenCalledTimes(1)
  })

  it('continues with local suggestions when history is unavailable', async () => {
    state.history.mockRejectedValueOnce(new Error('Offline'))
    const { user } = page()
    await upload(user, 'Date,Description,Amount\n2022-03-14,Uber,10')
    expect(
      await screen.findByText(/Previous expenses are unavailable/),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Review expenses' }))
    await user.click(
      await screen.findByRole('button', { name: 'Import 1 expense' }),
    )
    await waitFor(() => expect(state.import).toHaveBeenCalled())
    expect(state.import.mock.calls[0]![0].rows[0].expense.category).toBe('taxi')
  })

  it('never publishes a stale worker result after suggestion settings change', async () => {
    const { user } = page()
    await upload(user)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Review expenses' }),
      ).toBeEnabled(),
    )
    let resolveOld!: (rows: DelimitedPreviewRow[]) => void
    vi.mocked(previewExpenseFile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        }),
    )
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Suggest categories for unmatched expenses',
      }),
    )
    await waitFor(() => expect(resolveOld).toBeDefined())
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Suggest categories for unmatched expenses',
      }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Review expenses' }),
      ).toBeEnabled(),
    )
    await act(async () => resolveOld([]))
    expect(
      screen.getByRole('button', { name: 'View all mapped expenses (3)' }),
    ).toBeInTheDocument()
  })

  it('blocks review on ambiguous dates until the format is confirmed', async () => {
    const { user } = page()
    await upload(
      user,
      'Date,Description,Amount\n3/2/2022,Cafe,10\n4/5/2022,Bistro,20',
    )
    expect(
      screen.getByRole('button', { name: 'Review expenses' }),
    ).toBeDisabled()
    expect(
      screen.getByText(
        /Review expenses unlocks once the date format is confirmed/,
      ),
    ).toBeInTheDocument()
    await user.click(
      screen.getByRole('button', { name: /Confirm (day\/month|month\/day)/ }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Review expenses' }),
      ).toBeEnabled(),
    )
    expect(
      screen.queryByText(/Review expenses unlocks once/),
    ).not.toBeInTheDocument()
  })

  it('keeps import disabled until at least one expense is selected', async () => {
    const { user } = page()
    await upload(user)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Review expenses' }),
      ).toBeEnabled(),
    )
    await user.click(screen.getByRole('button', { name: 'Review expenses' }))
    await screen.findByRole('table', { name: 'Expenses to review' })
    for (const pattern of [/Select row 2:/, /Select row 3:/, /Select row 4:/]) {
      await user.click(screen.getByRole('checkbox', { name: pattern }))
    }
    const importButton = screen.getByRole('button', {
      name: 'Import 0 expenses',
    })
    expect(importButton).toBeDisabled()
    expect(
      screen.getByText(/Import unlocks once at least one expense is selected/),
    ).toBeInTheDocument()
    expect(state.import).not.toHaveBeenCalled()
  })

  it('selects an error row once an edit fixes it', async () => {
    const { user } = page()
    await upload(
      user,
      'Date,Description,Amount\n2022-03-14,Cafe,10\n2022-03-15,,20',
    )
    await user.click(screen.getByRole('button', { name: 'Review expenses' }))
    await screen.findByRole('table', { name: 'Expenses to review' })
    expect(
      screen.getByRole('checkbox', { name: /Select row 3:/ }),
    ).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByRole('checkbox', { name: /Select row 3:/ }),
    ).toHaveAttribute(
      'aria-describedby',
      expect.stringMatching(/review-status-/),
    )
    expect(
      screen.getByRole('button', { name: 'Import 1 expense' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Edit row 3' }))
    await user.type(
      screen.getByRole('textbox', { name: 'Edited title' }),
      'Fixed title',
    )
    await user.click(
      screen.getByRole('button', { name: 'Save edited expense' }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Import 2 expenses' }),
      ).toBeInTheDocument(),
    )
    // Focus returns to the triggering Edit control after the full-page edit.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit row 3' })).toHaveFocus(),
    )
    // The full-form save persists payer/currency/split defaults alongside the
    // fixed title.
    await user.click(screen.getByRole('button', { name: 'Import 2 expenses' }))
    await waitFor(() => expect(state.import).toHaveBeenCalled())
    const imported = state.import.mock.calls[0]![0].rows as {
      expense: Expense
    }[]
    expect(imported).toHaveLength(2)
    expect(imported[1]!.expense.title).toMatch(/Fixed title/)
    expect(imported[1]!.expense.category).toBe('groceries')
    for (const row of imported) {
      expect(row.expense.expenseTimeZone).toBe('UTC')
      expect(row.expense.splitMode).toBe('EVENLY')
      expect(row.expense.paidFor).toEqual([
        { participant: 'alice', shares: 1 },
        { participant: 'bob', shares: 1 },
      ])
    }
    expect(imported[0]!.expense.paidByList).toEqual([
      { participant: 'alice', shares: 1000 },
    ])
    expect(imported[1]!.expense.paidByList).toEqual([
      { participant: 'alice', shares: 2000 },
    ])
  })

  it('starts the next file with default category decisions after a completed import', async () => {
    const { user } = page()
    const first =
      'Date,Description,Amount,Category\n2022-03-14,Cafe,10,Dining\n2022-03-15,Bistro,20,Dining'
    await upload(user, first)
    const group = screen.getByRole('radiogroup', {
      name: 'Category mode for Dining',
    })
    await user.click(
      within(group).getByRole('radio', { name: 'Detect from titles' }),
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Review expenses' }),
      ).toBeEnabled(),
    )
    await user.click(screen.getByRole('button', { name: 'Review expenses' }))
    await user.click(
      await screen.findByRole('button', { name: 'Import 2 expenses' }),
    )
    await screen.findByText(/2 expenses imported/)
    await user.click(
      screen.getByRole('button', { name: 'Import another file' }),
    )
    await upload(user, first)
    const secondGroup = screen.getByRole('radiogroup', {
      name: 'Category mode for Dining',
    })
    // The previous file's title-detection choice must not leak across files.
    expect(
      within(secondGroup).getByRole('radio', {
        name: 'Use selected category',
      }),
    ).toBeChecked()
  })

  it('honors the DMY locale when mapping ambiguous dates for review', async () => {
    const OriginalDateTimeFormat = Intl.DateTimeFormat
    const dmySpy = vi
      .spyOn(Intl, 'DateTimeFormat')
      .mockImplementation(function (
        this: unknown,
        ...args: Parameters<typeof OriginalDateTimeFormat>
      ) {
        if (args.length === 0) {
          return new OriginalDateTimeFormat('de-DE')
        }
        return new OriginalDateTimeFormat(...args)
      } as typeof OriginalDateTimeFormat)
    try {
      const { user } = page()
      await upload(user, 'Date,Description,Amount\n03/04/2024,Cafe,10')
      await user.click(
        screen.getByRole('button', { name: /Confirm day\/month/ }),
      )
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Review expenses' }),
        ).toBeEnabled(),
      )
      await user.click(screen.getByRole('button', { name: 'Review expenses' }))
      await screen.findByRole('table', { name: 'Expenses to review' })
      // MAP honored DMY: 03/04/2024 is 3 Apr, not 4 Mar.
      expect(
        screen.getByRole('table', { name: 'Expenses to review' }),
      ).toHaveTextContent('2024-04-03')
      expect(
        screen.getByRole('table', { name: 'Expenses to review' }),
      ).not.toHaveTextContent('2024-03-04')
      expect(vi.mocked(mapExpenseFile)).toHaveBeenCalled()
      const mapCall = vi
        .mocked(mapExpenseFile)
        .mock.calls.find((call) => call[3]?.preferredDateOrder === 'DMY')
      expect(mapCall?.[3]).toMatchObject({ preferredDateOrder: 'DMY' })
    } finally {
      dmySpy.mockRestore()
    }
  })

  it('refetches category history when the group changes', async () => {
    const { user } = page()
    await upload(user, 'Date,Description,Amount\n2022-03-14,Cafe,10')
    await waitFor(() => expect(state.history).toHaveBeenCalledTimes(1))
    expect(state.history.mock.calls[0]![0]).toMatchObject({
      groupId: 'group-1',
    })
    await act(async () => {
      state.params = { groupId: 'group-2' }
      state.paramListeners.forEach((listener) => listener())
    })
    await user.click(screen.getByRole('button', { name: 'Back to file' }))
    const second = 'Date,Description,Amount\n2022-03-15,Bistro,20'
    const file = new File([second], 'second.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new TextEncoder().encode(second).buffer,
    })
    await user.upload(screen.getByLabelText('Expense file'), file)
    await screen.findByText('Bistro')
    await waitFor(() => expect(state.history).toHaveBeenCalledTimes(2))
    expect(state.history.mock.calls[1]![0]).toMatchObject({
      groupId: 'group-2',
    })
  })

  it('clears the duplicate ready state when drafts are remapped', async () => {
    const { user } = page()
    await upload(user)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Review expenses' }),
      ).toBeEnabled(),
    )
    await user.click(screen.getByRole('button', { name: 'Review expenses' }))
    await screen.findByRole('table', { name: 'Expenses to review' })
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Import 3 expenses/ }),
      ).toBeEnabled(),
    )
    const resetsAfterReview = state.duplicateReset.mock.calls.length
    const callsAfterReview = state.duplicateCalls.mock.calls.length
    expect(callsAfterReview).toBeGreaterThan(0)
    await user.click(await screen.findByRole('button', { name: 'Edit row 2' }))
    await user.clear(screen.getByLabelText('Edited title'))
    await user.type(screen.getByLabelText('Edited title'), 'Retitled dinner')
    await user.click(
      screen.getByRole('button', { name: 'Save edited expense' }),
    )
    // The edit forces a duplicate recheck instead of reusing stale matches.
    await waitFor(() =>
      expect(state.duplicateReset.mock.calls.length).toBeGreaterThan(
        resetsAfterReview,
      ),
    )
    // And the recheck carries the edited values — stale matches are cleared,
    // not just reset: the last duplicate request must contain the new title.
    await waitFor(() =>
      expect(state.duplicateCalls.mock.calls.length).toBeGreaterThan(
        callsAfterReview,
      ),
    )
    const lastCall = state.duplicateCalls.mock.calls.at(-1)?.[0] as {
      rows: { rowId: string; expense: { title: string } }[]
    }
    expect(
      lastCall.rows.some((row) => row.expense.title === 'Retitled dinner'),
    ).toBe(true)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Import 3 expenses/ }),
      ).toBeEnabled(),
    )
  })

  it('does not navigate with old rows when a new file lands during review mapping', async () => {
    const { user } = page()
    await upload(user)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Review expenses' }),
      ).toBeEnabled(),
    )
    // Hold the review mapping so a file change can land mid-review.
    let resolveReview!: (rows: never[]) => void
    vi.mocked(mapExpenseFile).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveReview = resolve as (rows: never[]) => void
        }),
    )
    await user.click(screen.getByRole('button', { name: 'Review expenses' }))
    // Review is in flight; go back and replace the file before it resolves.
    await user.click(screen.getByRole('button', { name: 'Back to file' }))
    const second = 'Date,Description,Amount\n2022-03-20,New merchant,99'
    const file = new File([second], 'second.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new TextEncoder().encode(second).buffer,
    })
    await user.upload(screen.getByLabelText('Expense file'), file)
    await screen.findByText('New merchant')
    // Resolve the stale review with an old valid row: it must not navigate.
    const staleRow = {
      rowId: 'old-2',
      rowNumber: 2,
      source: { baseFingerprint: 'old-base', originFingerprint: 'old-origin' },
      title: 'Old merchant',
      expenseDate: '2022-03-14',
      expenseTimeMinutes: 600,
      amount: 1000,
      currency: 'USD',
      category: 'general',
      categorySource: null,
      notes: null,
      externalId: null,
      sourceAccount: null,
      issues: [],
      warning: null,
      error: null,
    } as never
    await act(async () => resolveReview([staleRow] as never[]))
    // Still on the file step for the new file, never on review with old rows.
    expect(
      screen.queryByRole('table', { name: 'Expenses to review' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Old merchant')).not.toBeInTheDocument()
    expect(screen.getByText('New merchant')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Continue to mapping' }),
    ).toBeInTheDocument()
  })

  it('retries the mapping preview after a worker failure', async () => {
    const { user } = page()
    await upload(user)
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Review expenses' }),
      ).toBeEnabled(),
    )
    // Fail the next preview (triggered by a category setting change).
    vi.mocked(previewExpenseFile).mockImplementationOnce(async () => {
      throw new Error('Preview worker failed')
    })
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Suggest categories for unmatched expenses',
      }),
    )
    const retryBtn = await screen.findByRole(
      'button',
      { name: 'Retry preview' },
      { timeout: 3000 },
    )
    expect(retryBtn).toBeInTheDocument()
    // Restore the real preview and retry.
    vi.mocked(previewExpenseFile).mockImplementation(
      async (table, mapping, options) =>
        previewDelimitedRows(table, mapping, options),
    )
    await user.click(screen.getByRole('button', { name: 'Retry preview' }))
    await screen.findByText('Required field mappings')
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Review expenses' }),
      ).toBeEnabled(),
    )
  })

  it('rejects files with more than 10,000 rows without starting mapping', async () => {
    const { user } = page()
    const content =
      'Date,Description,Amount\n' +
      Array.from(
        { length: 10_001 },
        (_, index) => `2022-03-14,Cafe ${index},10`,
      ).join('\n')
    const file = new File([content], 'many-rows.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new TextEncoder().encode(content).buffer,
    })
    await user.upload(screen.getByLabelText('Expense file'), file)
    // Same friendly file-error Alert used for oversize bytes: names the
    // 10,000-row limit and the actual 10,001-row count.
    const error = await screen.findByText(
      /cannot contain more than 10,000 rows.*10,001 rows/,
    )
    expect(error).toBeInTheDocument()
    expect(screen.getByText('Import needs attention')).toBeInTheDocument()
    // Mapping never starts: no mapping step and no parsed file preview.
    expect(
      screen.queryByText('Required field mappings'),
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/data rows/)).not.toBeInTheDocument()
  })
})
