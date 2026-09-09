import type * as TanStackReactRouter from '@tanstack/react-router'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import {
  DetectionFeedback,
  MappedPreview,
  MappedExpensesDialog,
  MappingCard,
  MappingEditor,
  MoneyMappingCard,
  MoneyMappingEditor,
  RawPreview,
  ReviewExpensesList,
  SourceCategoryPreviewDialog,
  SourceFileDialog,
  applyCategoryBindingAssignment,
  duplicateCheckSignature,
  fnv1aHash,
  hashPreviewLens,
  inferMapping,
  rebuildDraftsForSettingsChange,
  reviewStatusFor,
  sortReviewRows,
} from '@/app/groups/[groupId]/expenses/csv-import-page'
import {
  CategorySourceRow,
  ImportCategoryMapping,
} from '@/app/groups/[groupId]/expenses/import-category-mapping'
import { WizardProgress } from '@/components/wizard'
import { act, render, screen, within } from '@/test/test-utils'
import {
  DELIMITED_MAPPING_KIND,
  DELIMITED_MAPPING_VERSION,
  delimitedColumnSignature,
  parseDelimitedText,
  previewDelimitedRows,
} from '@spliit/domain/import'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const original = await importOriginal<typeof TanStackReactRouter>()
  return {
    ...original,
    getRouteApi: () => ({
      useParams: () => ({ groupId: 'group-1' }),
      useSearch: () => ({}),
    }),
  }
})

const parsed = parseDelimitedText(`Date,Note,Amount
3/2/2022 10:11,Brownie,50
3/2/2022 10:12,Lunch,60
3/2/2022 10:13,Metro,30
3/2/2022 10:14,Coffee,20
3/2/2022 10:15,Market,100
3/2/2022 10:16,Taxi,80
3/2/2022 10:17,Dinner,90
3/2/2022 10:18,Groceries,120
3/2/2022 10:19,Bus,40
3/2/2022 10:20,Tea,15
3/2/2022 10:21,Books,75`)

if (!parsed.ok) throw new Error(parsed.error)
const table = parsed.table
const previewRows = previewDelimitedRows(table, {
  kind: DELIMITED_MAPPING_KIND,
  version: DELIMITED_MAPPING_VERSION,
  name: 'Test mapping',
  parsing: {
    delimiter: ',',
    headerRow: 0,
    encoding: 'UTF-8',
    columnSignature: delimitedColumnSignature(table),
  },
  mappings: {
    dateTime: {
      mode: 'VISUAL',
      sourceValues: [{ primary: 'date#1', fallbacks: [] }],
      transforms: [{ kind: 'PARSE_DATE', format: 'AUTO_MDY' }],
    },
    title: {
      mode: 'VISUAL',
      sourceValues: [{ primary: 'note#1', fallbacks: [] }],
      transforms: [{ kind: 'TRIM' }],
    },
    money: {
      mode: 'VISUAL',
      amount: {
        mode: 'VISUAL',
        sourceValues: [{ primary: 'amount#1', fallbacks: [] }],
        transforms: [{ kind: 'PARSE_NUMBER', format: 'AUTO' }],
      },
    },
  },
  categoryBindings: {},
  defaults: { currencyCode: 'USD', categoryId: 'general' },
})

const moneyParsed = parseDelimitedText(`Date,Note,Amount,Currency,Income/Expense
3/2/2022 10:11,Brownie,50,INR,Expense
3/2/2022 10:12,Salary,5000,INR,Income`)

if (!moneyParsed.ok) throw new Error(moneyParsed.error)
const moneyTable = moneyParsed.table
const amountMapping = {
  mode: 'VISUAL' as const,
  sourceValues: [{ primary: 'amount#1', fallbacks: [] }],
  transforms: [
    { kind: 'TRIM' as const },
    { kind: 'PARSE_NUMBER' as const, format: 'AUTO' as const },
    {
      kind: 'SIGN_FROM_COLUMN' as const,
      columnKey: 'income_expense#1',
      negativeValues: ['income'],
    },
  ],
}
const currencyMapping = {
  mode: 'VISUAL' as const,
  sourceValues: [{ primary: 'currency#1', fallbacks: [] }],
  transforms: [
    { kind: 'TRIM' as const },
    { kind: 'EXTRACT_CURRENCY' as const },
  ],
}

function gridModelFor(classes: string) {
  const floor = classes.match(/md:min-w-\[([\d.]+)rem\]/)
  const template = classes.match(/md:grid-cols-\[([^\]]+)\]/)
  if (!floor || !template) {
    throw new Error(`Missing shared grid model in: ${classes}`)
  }
  const minimums = template[1]!.split('_').map((track) => {
    const minimum = track.startsWith('minmax(')
      ? track.slice('minmax('.length).split(',')[0]!
      : track
    const parsed = minimum.match(/^([\d.]+)rem$/)
    if (!parsed) throw new Error(`Unexpected grid track: ${track}`)
    return Number(parsed[1])
  })
  return { floor: Number(floor[1]), template: template[0], minimums }
}

function expectUnifiedMappedTable(
  table: HTMLElement,
  headers: string[],
  cellsPerRow: number,
) {
  expect(
    within(table)
      .getAllByRole('columnheader')
      .map((header) => header.textContent),
  ).toEqual(headers)
  const [headerRow, ...bodyRows] = within(table).getAllByRole('row')
  expect(bodyRows.length).toBeGreaterThan(0)
  const headerModel = gridModelFor(headerRow!.className)
  for (const bodyRow of bodyRows) {
    expect(within(bodyRow).getAllByRole('cell')).toHaveLength(cellsPerRow)
    expect(gridModelFor(bodyRow.className)).toEqual(headerModel)
  }
  const trackTotal = headerModel.minimums.reduce((sum, min) => sum + min, 0)
  expect(headerModel.floor).toBeGreaterThanOrEqual(trackTotal)
}

describe('expense file import UI', () => {
  it('shows duplicate status alongside its matching expense explanation', () => {
    const row = {
      mapped: {
        ...previewRows[0]!,
        rowId: 'duplicate-row',
        error: null,
        warning: null,
        issues: [],
      } as never,
      expense: { title: 'Brownie', amount: 5000, category: 'general' } as never,
      selected: false,
      approvedDuplicateKeys: [],
    }
    render(
      <ReviewExpensesList
        rows={[row]}
        duplicateByRow={
          new Map([
            [
              'duplicate-row',
              [
                {
                  key: 'match',
                  kind: 'EXISTING_EXPENSE' as const,
                  expenseId: 'existing',
                  sourceRowId: null,
                  title: 'Brownie',
                  expenseDate: '2022-03-02',
                  amount: 5000,
                  currency: 'USD',
                },
              ],
            ],
          ])
        }
        onSelectedChange={() => {}}
        onEdit={() => {}}
        scrollPosition={{ current: 0 }}
      />,
    )
    expect(screen.getByText('Duplicate')).toBeInTheDocument()
    expect(screen.queryByText('Ready')).not.toBeInTheDocument()
    expect(screen.getByText(/Possible existing expense/)).toBeInTheDocument()
    // Duplicate rows start unselected so the import stays gated until the user
    // explicitly overrides them.
    const checkbox = screen.getByRole('checkbox', {
      name: /Select row .*Brownie/,
    })
    expect(checkbox).not.toBeChecked()
    expect(checkbox).not.toBeDisabled()
    // Duplicate explanations are decision-critical for the select/override
    // choice, so duplicate rows join error rows in the describedby wiring.
    // Issue and duplicate details each carry their own ids for screen readers.
    expect(checkbox.getAttribute('aria-describedby')).toMatch(
      /review-status-duplicate-row/,
    )
    expect(checkbox.getAttribute('aria-describedby')).toMatch(
      /review-duplicate-duplicate-row-0/,
    )
    // The status badge carries a stable id for the error-row describedby wiring.
    expect(screen.getByText('Duplicate')).toHaveAttribute(
      'id',
      'review-status-duplicate-row',
    )
  })
  it('keeps the three-step progress indicator static and marks completed steps', () => {
    render(
      <WizardProgress
        steps={[
          { id: 'file', label: 'Choose file' },
          { id: 'mapping', label: 'Map fields' },
          { id: 'review', label: 'Review' },
        ]}
        currentStep="mapping"
        ariaLabel="Import progress"
      />,
    )

    expect(screen.getByLabelText('Import progress')).toBeInTheDocument()
    const steps = screen.getAllByRole('listitem')
    expect(steps[0]).toHaveClass('border-primary/30')
    expect(steps[1]).toHaveAttribute('aria-current', 'step')
    expect(screen.getByText('Review')).toBeInTheDocument()
  })

  it('shows ten raw rows and offers the full source viewer', async () => {
    function PreviewHarness() {
      const [visible] = useState(10)
      return (
        <RawPreview table={table} visibleRows={visible} onShowAll={() => {}} />
      )
    }

    render(<PreviewHarness />)
    expect(screen.getByRole('table').parentElement).toHaveClass(
      'max-w-full',
      'overflow-x-auto',
    )
    expect(screen.getByText('Dinner')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Show all' })).not.toBeNull()
  })

  it('shows live source-to-result examples for a visual mapping', () => {
    render(
      <MappingCard
        field="title"
        table={table}
        previewRows={previewRows}
        mapping={{
          mode: 'VISUAL',
          sourceValues: [{ primary: 'note#1', fallbacks: [] }],
          transforms: [{ kind: 'TRIM' }],
        }}
        required
        onEdit={() => {}}
      />,
    )

    expect(screen.getAllByText('Note').length).toBeGreaterThan(0)
    expect(screen.getByText('Brownie')).toBeInTheDocument()
    expect(screen.getByText('Lunch')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Edit mapping' }),
    ).toBeInTheDocument()
    expect(screen.queryByText('Part 1')).not.toBeInTheDocument()
    expect(screen.queryByText('(used)')).not.toBeInTheDocument()
    expect(screen.getByText('Mapping')).toBeInTheDocument()
  })

  it('opens a non-empty virtualized source viewer', () => {
    render(<SourceFileDialog table={table} open onOpenChange={() => {}} />)

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(
      screen.getByRole('table', { name: 'Parsed source rows' }),
    ).toBeInTheDocument()
    expect(screen.getByText('Dinner')).toBeInTheDocument()
  })

  it('starts in Simple mode and exposes ordered Advanced sources', async () => {
    const { user } = render(
      <MappingEditor
        field="title"
        table={table}
        initialMapping={{
          mode: 'VISUAL',
          sourceValues: [{ primary: 'note#1', fallbacks: [] }],
          transforms: [{ kind: 'TRIM' }],
        }}
        defaultMapping={{
          mode: 'VISUAL',
          sourceValues: [{ primary: 'note#1', fallbacks: [] }],
          transforms: [{ kind: 'TRIM' }],
        }}
        previewRows={previewRows}
        onClose={() => {}}
        onSave={() => {}}
      />,
    )

    expect(screen.getByRole('tab', { name: 'Simple' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await user.click(screen.getByRole('tab', { name: 'Advanced' }))
    expect(screen.getByText('Source values')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Add source value' }),
    ).toBeInTheDocument()
  })

  it('blocks saving a mapping that cannot be compiled', () => {
    render(
      <MappingEditor
        field="dateTime"
        table={table}
        initialMapping={{
          mode: 'VISUAL',
          sourceValues: [{ primary: 'date#1', fallbacks: [] }],
          transforms: [{ kind: 'PARSE_DATE', format: '' }],
        }}
        defaultMapping={{
          mode: 'VISUAL',
          sourceValues: [{ primary: 'date#1', fallbacks: [] }],
          transforms: [{ kind: 'PARSE_DATE', format: 'AUTO_MDY' }],
        }}
        onClose={() => {}}
        onSave={() => {}}
      />,
    )

    expect(screen.getByText('Mapping needs attention')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save mapping' })).toBeDisabled()
  })

  it('keeps Simple mappings concise and shows column labels instead of internal keys', () => {
    render(
      <MappingEditor
        field="dateTime"
        table={table}
        initialMapping={{
          mode: 'VISUAL',
          sourceValues: [{ primary: 'date#1', fallbacks: [] }],
          transforms: [{ kind: 'PARSE_DATE', format: 'AUTO_MDY' }],
        }}
        defaultMapping={{
          mode: 'VISUAL',
          sourceValues: [{ primary: 'date#1', fallbacks: [] }],
          transforms: [{ kind: 'PARSE_DATE', format: 'AUTO_MDY' }],
        }}
        previewRows={previewRows}
        onClose={() => {}}
        onSave={() => {}}
      />,
    )

    expect(
      screen.getByRole('combobox', { name: 'Source source column' }),
    ).toHaveTextContent('Date')
    expect(screen.queryByText('date#1')).not.toBeInTheDocument()
    expect(screen.queryByText('Normalize whitespace')).not.toBeInTheDocument()
  })

  it('summarizes Money sources without a card-level removal action', () => {
    const { rerender } = render(
      <MoneyMappingCard
        table={moneyTable}
        mapping={{
          mode: 'VISUAL',
          amount: amountMapping,
          currency: currencyMapping,
        }}
        defaultCurrencyCode="INR"
        onEdit={() => {}}
      />,
    )

    expect(
      screen.getByText(
        'Amount: Amount · Number format: Automatic · Sign: Income/Expense',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('Currency: Currency')).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Remove currency mapping' }),
    ).not.toBeInTheDocument()

    rerender(
      <MoneyMappingCard
        table={moneyTable}
        mapping={{
          mode: 'VISUAL',
          amount: amountMapping,
          currency: {
            ...currencyMapping,
            sourceValues: [{ primary: 'amount#1', fallbacks: [] }],
          },
        }}
        defaultCurrencyCode="INR"
        onEdit={() => {}}
      />,
    )
    expect(
      screen.getByText('Currency: Extracted from Amount'),
    ).toBeInTheDocument()

    rerender(
      <MoneyMappingCard
        table={moneyTable}
        mapping={{ mode: 'VISUAL', amount: amountMapping }}
        defaultCurrencyCode="INR"
        onEdit={() => {}}
      />,
    )
    expect(screen.getByText('Currency: INR')).toBeInTheDocument()
  })

  it('infers separate and combined currency sources from the file', () => {
    const separate = inferMapping(moneyTable, 'INR').mappings.money
    expect(separate).toMatchObject({
      mode: 'VISUAL',
      currency: {
        sourceValues: [{ primary: 'currency#1', fallbacks: [] }],
      },
    })

    const combined = parseDelimitedText(`Date,Note,Amount
3/2/2022 10:11,Brownie,50 INR
3/2/2022 10:12,Lunch,12.50 EUR`)
    expect(combined.ok).toBe(true)
    if (!combined.ok) return
    expect(inferMapping(combined.table, 'INR').mappings.money).toMatchObject({
      mode: 'VISUAL',
      amount: {
        sourceValues: [{ primary: 'amount#1', fallbacks: [] }],
      },
      currency: {
        sourceValues: [{ primary: 'amount#1', fallbacks: [] }],
        transforms: [{ kind: 'TRIM' }, { kind: 'EXTRACT_CURRENCY' }],
      },
    })
  })

  it('keeps a combined currency source linked to the amount column', async () => {
    let savedMapping: Parameters<typeof MoneyMappingEditor>[0]['initialMapping']
    const combinedMapping = {
      mode: 'VISUAL' as const,
      amount: {
        ...amountMapping,
        transforms: amountMapping.transforms.filter(
          ({ kind }) => kind !== 'SIGN_FROM_COLUMN',
        ),
      },
      currency: {
        ...currencyMapping,
        sourceValues: [{ primary: 'amount#1', fallbacks: [] }],
      },
    }
    const { user } = render(
      <MoneyMappingEditor
        table={moneyTable}
        initialMapping={combinedMapping}
        defaultMapping={combinedMapping}
        defaultCurrencyCode="INR"
        onClose={() => {}}
        onSave={(mapping) => {
          savedMapping = mapping
        }}
      />,
    )

    expect(
      screen.getByRole('radio', { name: /Extract from the amount column/ }),
    ).toHaveAttribute('data-checked')
    expect(
      screen.queryByText('Extract a currency code from the source'),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('combobox', { name: 'Amount column' }))
    await user.click(screen.getByRole('option', { name: 'Note' }))
    await user.click(screen.getByRole('button', { name: 'Save mapping' }))

    expect(savedMapping!).toMatchObject({
      mode: 'VISUAL',
      amount: { sourceValues: [{ primary: 'note#1', fallbacks: [] }] },
      currency: {
        sourceValues: [{ primary: 'note#1', fallbacks: [] }],
        transforms: [{ kind: 'TRIM' }, { kind: 'EXTRACT_CURRENCY' }],
      },
    })
  })

  it('shows semantic sign and separate-currency controls only when selected', async () => {
    let savedMapping: Parameters<typeof MoneyMappingEditor>[0]['initialMapping']
    const simpleMapping = {
      mode: 'VISUAL' as const,
      amount: {
        ...amountMapping,
        transforms: amountMapping.transforms.filter(
          ({ kind }) => kind !== 'SIGN_FROM_COLUMN',
        ),
      },
    }
    const { user } = render(
      <MoneyMappingEditor
        table={moneyTable}
        initialMapping={simpleMapping}
        defaultMapping={simpleMapping}
        defaultCurrencyCode="INR"
        onClose={() => {}}
        onSave={(mapping) => {
          savedMapping = mapping
        }}
      />,
    )

    expect(
      screen.queryByRole('combobox', { name: 'Income/expense column' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('combobox', { name: 'Currency column' }),
    ).not.toBeInTheDocument()

    await user.click(
      screen.getByRole('radio', {
        name: /Income\/expense column determines the sign/,
      }),
    )
    expect(
      screen.getByRole('combobox', { name: 'Income/expense column' }),
    ).toBeInTheDocument()

    await user.click(
      screen.getByRole('radio', { name: /Read from another column/ }),
    )
    expect(
      screen.getByRole('combobox', { name: 'Currency column' }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save mapping' }))

    expect(savedMapping!).toMatchObject({
      mode: 'VISUAL',
      amount: {
        transforms: expect.arrayContaining([
          expect.objectContaining({
            kind: 'SIGN_FROM_COLUMN',
            columnKey: 'income_expense#1',
          }),
        ]),
      },
      currency: {
        sourceValues: [{ primary: 'currency#1', fallbacks: [] }],
        transforms: [{ kind: 'TRIM' }, { kind: 'EXTRACT_CURRENCY' }],
      },
    })
  })

  it('uses the expense currency picker for a fixed batch currency', async () => {
    let savedCurrency = ''
    const fixedMapping = {
      mode: 'VISUAL' as const,
      amount: {
        ...amountMapping,
        transforms: amountMapping.transforms.filter(
          ({ kind }) => kind !== 'SIGN_FROM_COLUMN',
        ),
      },
    }
    const { user } = render(
      <MoneyMappingEditor
        table={moneyTable}
        initialMapping={fixedMapping}
        defaultMapping={fixedMapping}
        defaultCurrencyCode="INR"
        groupCurrencyCode="INR"
        onClose={() => {}}
        onSave={(_, currencyCode) => {
          savedCurrency = currencyCode
        }}
      />,
    )

    expect(
      screen.getByRole('radio', { name: /Use one currency/ }),
    ).toHaveAttribute('data-checked')
    const currencyPicker = screen.getByRole('combobox', { name: 'Currency' })
    expect(currencyPicker).toHaveTextContent('INR')

    await user.click(currencyPicker)
    await user.click(await screen.findByRole('option', { name: /EUR/ }))
    await user.click(screen.getByRole('button', { name: 'Save mapping' }))

    expect(savedCurrency).toBe('EUR')
  })

  it('shows mapped issue rows and keeps income amounts positive', async () => {
    const rows = [
      {
        rowId: 'preview-2',
        rowNumber: 2,
        title: 'Salary',
        expenseDate: '2022-03-02',
        expenseTimeMinutes: 10 * 60,
        amount: -5000,
        currency: 'INR',
        category: 'income' as const,
        categorySource: null,
        notes: null,
        externalId: null,
        sourceAccount: null,
        issues: [],
        warning: null,
        error: null,
      },
      {
        rowId: 'preview-3',
        rowNumber: 3,
        title: '',
        expenseDate: '2022-03-02',
        expenseTimeMinutes: 10 * 60,
        amount: 3000,
        currency: 'INR',
        category: 'general' as const,
        categorySource: null,
        notes: null,
        externalId: null,
        sourceAccount: null,
        issues: [
          {
            rowNumber: 3,
            field: 'title' as const,
            severity: 'error' as const,
            code: 'MISSING_TITLE' as const,
            message: 'Title needs at least two characters',
            params: {},
          },
        ],
        warning: null,
        error: 'Title needs at least two characters',
      },
    ]

    function PreviewHarness() {
      return <MappedPreview rows={rows} onViewAll={() => {}} />
    }

    render(<PreviewHarness />)
    expect(screen.getByText('50.00 INR')).toBeInTheDocument()
    expect(screen.queryByText('-50.00 INR')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /View all mapped expenses/ }),
    ).toBeInTheDocument()

    const { user } = render(
      <MappedExpensesDialog
        rows={rows}
        open
        status="ready"
        filter="ISSUES"
        issueField={null}
        onOpenChange={() => {}}
        onFilterChange={() => {}}
      />,
    )
    await user.click(screen.getByRole('button', { name: /Issues/ }))
    expect(screen.getAllByText('Missing title').length).toBeGreaterThan(0)
  })

  it('keeps review edit beside selection and restores the list position', () => {
    const scrollPosition = { current: 0 }
    const rows = Array.from({ length: 30 }, (_, index) => ({
      mapped: {
        ...previewRows[0],
        rowId: `preview-${index + 2}`,
        rowNumber: index + 2,
      } as never,
      expense: {
        title: `Expense ${index + 1}`,
        amount: 5000,
        category: 'general',
      } as never,
      selected: true,
      approvedDuplicateKeys: [],
    }))
    const props = {
      rows,
      duplicateByRow: new Map(),
      onSelectedChange: () => {},
      onEdit: () => {},
      scrollPosition,
    }
    const firstRender = render(<ReviewExpensesList {...props} />)
    const checkboxCell = screen
      .getByRole('checkbox', { name: /Select row 2: Expense 1/ })
      .closest('td')
    expect(
      screen.getByRole('checkbox', { name: /Select row 2: Expense 1/ }),
    ).toHaveClass('cursor-pointer')
    expect(checkboxCell).toContainElement(
      screen.getByRole('button', { name: 'Edit row 2' }),
    )

    const viewport = screen.getByRole('table', {
      name: 'Expenses to review',
    }).parentElement!
    act(() => {
      viewport.scrollTop = 240
      viewport.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    expect(scrollPosition.current).toBe(240)

    firstRender.unmount()
    render(<ReviewExpensesList {...props} />)
    expect(
      screen.getByRole('table', { name: 'Expenses to review' }).parentElement,
    ).toHaveProperty('scrollTop', 240)
  })

  it('keeps invalid review rows editable so they can be repaired', () => {
    const row = {
      mapped: {
        ...previewRows[0],
        rowId: 'invalid-row',
        rowNumber: 12,
        error: 'Title needs at least two characters',
        warning: null,
        issues: [],
      } as never,
      expense: {
        title: '',
        amount: 5000,
        category: 'general',
      } as never,
      selected: false,
      approvedDuplicateKeys: [],
    }

    render(
      <ReviewExpensesList
        rows={[row]}
        duplicateByRow={new Map()}
        onSelectedChange={() => {}}
        onEdit={() => {}}
        scrollPosition={{ current: 0 }}
      />,
    )

    expect(
      screen.getByRole('button', { name: 'Edit row 12' }),
    ).toBeInTheDocument()
    expect(
      screen.getByRole('checkbox', { name: /Select row 12: Missing title/ }),
    ).toHaveAttribute('aria-disabled', 'true')
    // Error rows explain the disabled state through the status badge.
    const errorCheckbox = screen.getByRole('checkbox', {
      name: /Select row 12: Missing title/,
    })
    expect(errorCheckbox).toHaveAttribute(
      'aria-describedby',
      'review-status-invalid-row',
    )
    expect(screen.getByText('Error')).toHaveAttribute(
      'id',
      'review-status-invalid-row',
    )
  })

  it('limits the mapped card to ten rows and puts all rows in the dialog', () => {
    const manyRows = Array.from({ length: 15 }, (_, index) => ({
      ...previewRows[0]!,
      rowId: `preview-${index + 2}`,
      rowNumber: index + 2,
      title: `Expense ${index + 1}`,
    }))
    render(<MappedPreview rows={manyRows} onViewAll={() => {}} />)
    expect(screen.getAllByRole('row').length).toBe(11)

    render(
      <MappedExpensesDialog
        rows={manyRows}
        open
        status="ready"
        filter="ALL"
        issueField={null}
        onOpenChange={() => {}}
        onFilterChange={() => {}}
      />,
    )
    expect(screen.getByText('Expense 15')).toBeInTheDocument()
  })

  it('confirms closely competing detections without overwriting manual edits', async () => {
    const onConfirm = vi.fn()
    const { user, unmount } = render(
      <DetectionFeedback
        entries={[
          {
            field: 'title',
            code: 'DETECTION_TIED_COLUMN',
            message:
              'Check the detected Note column; another column is equally plausible.',
            params: { label: 'Note' },
            requiresConfirmation: true,
            candidates: ['Note', 'Merchant'],
          },
        ]}
        onConfirm={onConfirm}
      />,
    )
    await user.click(
      screen.getByRole('button', { name: 'Use detected column' }),
    )
    expect(onConfirm).toHaveBeenCalledTimes(1)
    unmount()

    // Ambiguous number formats and missing columns offer no one-click
    // confirmation; the user must edit the mapping instead.
    render(
      <DetectionFeedback
        entries={[
          {
            field: 'money',
            code: 'DETECTION_AMBIGUOUS_NUMBER_FORMAT',
            message:
              'Confirm the number format: separators in this column are ambiguous or inconsistent.',
            params: {},
            requiresConfirmation: true,
            candidates: [],
          },
        ]}
        onConfirm={() => {
          throw new Error('Must edit the Money mapping instead')
        }}
      />,
    )
    expect(
      screen.queryByRole('button', { name: 'Use detected column' }),
    ).not.toBeInTheDocument()
  })

  it('summarizes separate Debit and Credit columns with their number format', () => {
    const debitCreditParsed = parseDelimitedText(`Date,Note,Debit,Credit
3/2/2022 10:11,Brownie,50,
3/2/2022 10:12,Salary,,5000`)
    expect(debitCreditParsed.ok).toBe(true)
    if (!debitCreditParsed.ok) return
    const debitCreditTable = debitCreditParsed.table
    render(
      <MoneyMappingCard
        table={debitCreditTable}
        mapping={{
          mode: 'VISUAL',
          amount: {
            mode: 'VISUAL',
            sourceValues: [{ primary: 'debit#1', fallbacks: [] }],
            transforms: [
              {
                kind: 'DEBIT_CREDIT',
                debitColumn: 'debit#1',
                creditColumn: 'credit#1',
                format: 'AUTO',
              },
            ],
          },
        }}
        defaultCurrencyCode="USD"
        onEdit={() => {}}
      />,
    )
    expect(
      screen.getByText(/Debit: Debit \/ Credit: Credit/),
    ).toBeInTheDocument()
    expect(screen.getByText(/Number format: Automatic/)).toBeInTheDocument()
  })

  it('hides the category dropdown when title detection is selected', async () => {
    function CategoryRow() {
      const [titleMode, setTitleMode] = useState(false)
      return (
        <CategorySourceRow
          summary={{ key: 'dining', source: 'Dining', count: 3 }}
          categoryId="general"
          titleMode={titleMode}
          pending={false}
          onChange={(assignment) => setTitleMode(assignment.mode === 'title')}
        />
      )
    }
    const { user } = render(<CategoryRow />)
    expect(screen.getByRole('combobox')).toBeEnabled()
    const radio = screen.getByRole('radio', { name: 'Detect from titles' })
    await user.click(radio)
    expect(radio).toBeChecked()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    await user.click(
      screen.getByRole('radio', { name: 'Use selected category' }),
    )
    expect(screen.getByRole('combobox')).toBeEnabled()
  })

  it('does not dispatch unchanged category modes', async () => {
    const onChange = vi.fn()
    const { user } = render(
      <CategorySourceRow
        summary={{ key: 'dining', source: 'Dining', count: 3 }}
        categoryId="general"
        titleMode={false}
        pending={false}
        onChange={onChange}
      />,
    )
    await user.click(
      screen.getByRole('radio', { name: 'Use selected category' }),
    )
    expect(onChange).not.toHaveBeenCalled()
    await user.click(screen.getByRole('radio', { name: 'Detect from titles' }))
    expect(onChange).toHaveBeenCalledExactlyOnceWith({ mode: 'title' })
  })

  it('notifies the preview handler with the source key', async () => {
    const onPreview = vi.fn()
    const { user } = render(
      <CategorySourceRow
        summary={{ key: 'dining', source: 'Dining', count: 3 }}
        categoryId="general"
        titleMode={false}
        pending={false}
        onChange={() => {}}
        onPreview={onPreview}
      />,
    )
    await user.click(
      screen.getByRole('button', { name: 'View expenses for Dining' }),
    )
    expect(onPreview).toHaveBeenCalledExactlyOnceWith('dining')
  })

  it('previews the filtered source expenses as read-only', async () => {
    const rows = previewRows.slice(0, 3).map((row, index) => ({
      ...row,
      rowId: `preview-row-${index}`,
      categorySource: index < 2 ? 'Dining' : 'Travel',
    }))
    const { user } = render(
      <SourceCategoryPreviewDialog
        sourceName="Dining"
        titleMode={false}
        categoryName="Restaurants"
        rows={rows.filter((row) => row.categorySource === 'Dining')}
        status="ready"
        open
        onOpenChange={() => {}}
      />,
    )
    expect(
      screen.getByRole('heading', { name: 'Expenses for Dining' }),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Use selected category: Restaurants/),
    ).toBeInTheDocument()
    const table = screen.getByRole('table', { name: 'Expenses for Dining' })
    expect(within(table).getAllByRole('row')).toHaveLength(3)
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('radio')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close' }))
  })

  it('describes title detection and empty sources in the preview', () => {
    const { rerender } = render(
      <SourceCategoryPreviewDialog
        sourceName="Dining"
        titleMode
        categoryName={null}
        rows={[]}
        status="ready"
        open
        onOpenChange={() => {}}
      />,
    )
    expect(screen.getByText(/Detect from titles/)).toBeInTheDocument()
    expect(
      screen.getByText('No expenses match this source in the current preview.'),
    ).toBeInTheDocument()
    rerender(
      <SourceCategoryPreviewDialog
        sourceName="Dining"
        titleMode
        categoryName={null}
        rows={previewRows.slice(0, 1).map((row) => ({
          ...row,
          rowId: 'preview-title-1',
          categorySource: 'Dining',
        }))}
        status="ready"
        open
        onOpenChange={() => {}}
      />,
    )
    expect(
      screen.getByRole('table', { name: 'Expenses for Dining' }),
    ).toBeInTheDocument()
  })

  it('explains the category priority and offers a fallback category', async () => {
    const onFallbackChange = vi.fn()
    const { user } = render(
      <ImportCategoryMapping
        mapping={
          { categoryBindings: {}, defaults: { categoryId: 'general' } } as never
        }
        context={{}}
        rows={[]}
        published={null}
        updating={false}
        onAssignment={() => {}}
        onFallbackChange={onFallbackChange}
        onSuggestUnmatched={() => {}}
        historyUnavailable={false}
      />,
    )
    expect(
      screen.getByText(/Categories apply in this order/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/egative amounts always use Income/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Manually edited rows keep their category/),
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        'No source categories were found. Titles and the fallback category will be used.',
      ),
    ).toBeInTheDocument()
    const fallback = screen.getByRole('combobox')
    expect(fallback).toBeInTheDocument()
    await user.click(fallback)
    const groceries = await screen.findByRole('option', { name: 'Groceries' })
    await user.click(groceries)
    expect(onFallbackChange).toHaveBeenCalledWith('groceries')
  })

  it('uses the same columns as the mapped preview when reviewing', () => {
    const rows = [
      {
        mapped: {
          ...previewRows[0],
          rowId: 'review-row-1',
          rowNumber: 2,
          categoryProvenance: 'fallback',
          issues: [],
          warning: null,
          error: null,
        } as never,
        expense: {
          title: 'Brownie',
          amount: 5000,
          category: 'general',
        } as never,
        selected: true,
        approvedDuplicateKeys: [],
      },
    ]
    render(
      <ReviewExpensesList
        rows={rows}
        duplicateByRow={new Map()}
        onSelectedChange={() => {}}
        onEdit={() => {}}
        scrollPosition={{ current: 0 }}
      />,
    )

    const table = screen.getByRole('table', { name: 'Expenses to review' })
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual([
      'Select and edit row',
      'Source row',
      'Date',
      'Title',
      'Amount',
      'Category',
      'Status',
    ])
    expect(
      within(table).queryByRole('columnheader', { name: 'Expense' }),
    ).not.toBeInTheDocument()
    expect(within(table).getByText('Ready')).toBeInTheDocument()
    const category = within(table).getByText('General')
    expect(category.closest('td')).toHaveTextContent('Category')
    // Provenance is exposed as screen-reader text, not a hover-only tooltip.
    expect(category.closest('td')).toHaveTextContent('(Fallback category)')
  })

  it('aligns review actions with the single-line row content', () => {
    render(
      <ReviewExpensesList
        rows={[
          {
            mapped: {
              ...previewRows[0],
              rowId: 'review-align-row',
              rowNumber: 2,
              issues: [],
              warning: null,
              error: null,
            } as never,
            expense: {
              title: 'Brownie',
              amount: 5000,
              category: 'general',
            } as never,
            selected: true,
            approvedDuplicateKeys: [],
          },
        ]}
        duplicateByRow={new Map()}
        onSelectedChange={() => {}}
        onEdit={() => {}}
        scrollPosition={{ current: 0 }}
      />,
    )

    const table = screen.getByRole('table', { name: 'Expenses to review' })
    const row = within(table).getByRole('row', { name: /Brownie/ })
    expect(row).toHaveClass('items-start')
    const editButton = within(table).getByRole('button', { name: 'Edit row 2' })
    // The edit button keeps its touch target but must not inflate the row:
    // its negative vertical margins cancel the extra height beyond a text line.
    expect(editButton).toHaveClass('-my-1.5')
    const actionCell = editButton.closest('td')!
    // Same top padding rhythm as the source-row cell so controls sit on the
    // same line as the single-line content instead of centering below it.
    expect(actionCell).toHaveClass('items-start', 'pt-3', 'md:py-3')
    expect(
      within(table).getByRole('checkbox', { name: /Select row 2: Brownie/ }),
    ).toHaveClass('mt-0.5')
    expect(
      within(table).getByRole('checkbox', {
        name: 'Select row 2: Brownie, 50.00 USD',
      }),
    ).toBeInTheDocument()
  })

  it('sorts review rows by severity: errors, duplicates, warnings, ready', () => {
    const row = (
      rowId: string,
      rowNumber: number,
      mapped: { error?: string | null; warning?: string | null } = {},
      duplicateCount = 0,
    ) =>
      ({
        mapped: { rowId, rowNumber, error: null, warning: null, ...mapped },
        __duplicates: duplicateCount,
      }) as never
    const rows = [
      row('ready-2', 2),
      row('warning-5', 5, { warning: 'Ambiguous date' }),
      row('error-3', 3, { error: 'Missing title' }),
      row('duplicate-1', 1, {}, 2),
      row('warning-4', 4, { warning: 'Fallback category' }),
      row('ready-6', 6),
    ]
    const duplicateCounts = new Map([['duplicate-1', 2]])
    const statusFor = (candidate: {
      mapped: { error?: string | null; warning?: string | null; rowId: string }
    }) =>
      reviewStatusFor(
        candidate.mapped,
        duplicateCounts.get(candidate.mapped.rowId) ?? 0,
      )

    const sorted = sortReviewRows(rows, statusFor)
    const rowIds = (entries: { mapped: { rowId: string } }[]) =>
      entries.map((entry) => entry.mapped.rowId)

    expect(rowIds(sorted)).toEqual([
      'error-3',
      'duplicate-1',
      'warning-4',
      'warning-5',
      'ready-2',
      'ready-6',
    ])
    // The input array is not mutated and ties keep file order.
    expect(rowIds(rows)[0]).toBe('ready-2')
  })

  it('ranks review status with errors over duplicates over warnings', () => {
    expect(reviewStatusFor({ error: null, warning: null }, 0)).toBe('READY')
    expect(reviewStatusFor({ error: null, warning: 'Ambiguous' }, 0)).toBe(
      'WARNINGS',
    )
    expect(reviewStatusFor({ error: null, warning: null }, 2)).toBe(
      'DUPLICATES',
    )
    expect(reviewStatusFor({ error: 'Missing title', warning: null }, 0)).toBe(
      'ERRORS',
    )
    // Conflicting signals follow the same precedence, not first-seen order.
    expect(reviewStatusFor({ error: 'Missing title', warning: null }, 3)).toBe(
      'ERRORS',
    )
    expect(reviewStatusFor({ error: null, warning: 'Ambiguous' }, 1)).toBe(
      'DUPLICATES',
    )
  })

  it('sorts review rows end to end with the real status function', () => {
    type Fixture = {
      mapped: {
        rowId: string
        rowNumber: number
        error: string | null
        warning: string | null
      }
    }
    const drafts: Fixture[] = [
      { mapped: { rowId: 'ready', rowNumber: 4, error: null, warning: null } },
      {
        mapped: {
          rowId: 'warning',
          rowNumber: 3,
          error: null,
          warning: 'Ambiguous date',
        },
      },
      {
        mapped: {
          rowId: 'error-duplicate',
          rowNumber: 1,
          error: 'Missing title',
          warning: null,
        },
      },
      {
        mapped: {
          rowId: 'duplicate-warning',
          rowNumber: 2,
          error: null,
          warning: 'Fallback',
        },
      },
    ]
    const duplicates = new Map([
      ['error-duplicate', 2],
      ['duplicate-warning', 1],
    ])
    const sorted = sortReviewRows(drafts as never, (draft) =>
      reviewStatusFor(
        (draft as Fixture).mapped,
        duplicates.get((draft as Fixture).mapped.rowId) ?? 0,
      ),
    )

    expect(sorted.map((draft) => (draft as Fixture).mapped.rowId)).toEqual([
      'error-duplicate',
      'duplicate-warning',
      'warning',
      'ready',
    ])
  })

  it('hashes duplicate checks by identity without full expenses', () => {
    const row = (overrides: Record<string, unknown> = {}) => ({
      rowId: '1-abc',
      rowNumber: 1,
      source: { baseFingerprint: 'base', originFingerprint: 'origin' },
      externalId: null,
      sourceAccount: null,
      expense: {
        title: 'Cafe',
        expenseDate: new Date('2022-03-14'),
        amount: 1000,
        expenseTimeZone: 'UTC',
        conversion: { currency: 'USD' },
        paidByList: [{ participant: 'alice', shares: 1 }],
        selected: true,
      },
      ...overrides,
    })
    const base = duplicateCheckSignature([
      row({
        expense: {
          title: 'Cafe',
          expenseDate: new Date('2022-03-14'),
          amount: 1000,
          expenseTimeZone: 'UTC',
          conversion: { currency: 'USD' },
          paidByList: [{ participant: 'alice', shares: 1 }],
          selected: true,
        },
      }),
    ])
    // Splits and selection state do not affect duplicate matching.
    expect(
      duplicateCheckSignature([
        row({
          expense: {
            title: 'Cafe',
            expenseDate: new Date('2022-03-14'),
            amount: 1000,
            expenseTimeZone: 'UTC',
            conversion: { currency: 'USD' },
            paidByList: [{ participant: 'bob', shares: 5 }],
          },
        }),
      ]),
    ).toBe(base)
    for (const changed of [
      row({ rowId: '2-abc' }),
      row({
        source: { baseFingerprint: 'other', originFingerprint: 'origin' },
      }),
      row({ externalId: 'bank-1' }),
      row({
        expense: {
          title: 'Bistro',
          expenseDate: new Date('2022-03-14'),
          amount: 1000,
          expenseTimeZone: 'UTC',
          conversion: { currency: 'USD' },
        },
      }),
      row({
        expense: {
          title: 'Cafe',
          expenseDate: new Date('2022-03-15'),
          amount: 1000,
          expenseTimeZone: 'UTC',
          conversion: { currency: 'USD' },
        },
      }),
      row({
        expense: {
          title: 'Cafe',
          expenseDate: new Date('2022-03-14'),
          amount: 2000,
          expenseTimeZone: 'UTC',
          conversion: { currency: 'USD' },
        },
      }),
      row({
        expense: {
          title: 'Cafe',
          expenseDate: new Date('2022-03-14'),
          amount: 1000,
          expenseTimeZone: 'Europe/Berlin',
          conversion: { currency: 'USD' },
        },
      }),
      row({
        expense: {
          title: 'Cafe',
          expenseDate: new Date('2022-03-14'),
          amount: 1000,
          expenseTimeZone: 'UTC',
          conversion: { currency: 'EUR' },
        },
      }),
    ]) {
      expect(duplicateCheckSignature([changed])).not.toBe(base)
    }
    // The ledger currency feeds the server-side sourceCurrency fallback, so a
    // mid-import group currency change must invalidate the ready state.
    expect(
      duplicateCheckSignature(
        [
          row({
            expense: {
              title: 'Cafe',
              expenseDate: new Date('2022-03-14'),
              amount: 1000,
              expenseTimeZone: 'UTC',
              conversion: { currency: 'USD' },
            },
          }),
        ],
        'EUR',
      ),
    ).not.toBe(base)
  })

  it('preserves explicit category bindings across title/source toggles', () => {
    const mapping = {
      categoryBindings: { groceries: 'groceries' },
    } as never
    // Toggling to title detection must not delete the picked binding:
    // toggling back restores Groceries instead of falling back.
    expect(
      applyCategoryBindingAssignment(mapping, 'groceries', { mode: 'title' }),
    ).toBe(mapping)
    expect(
      applyCategoryBindingAssignment(mapping, 'groceries', { mode: 'source' }),
    ).toBe(mapping)
    // A concrete pick replaces the binding…
    const updated = applyCategoryBindingAssignment(mapping, 'groceries', {
      mode: 'source',
      categoryId: 'dining-out',
    })
    expect(updated).not.toBe(mapping)
    expect(updated?.categoryBindings).toEqual({ groceries: 'dining-out' })
    // …and re-picking the same category is a no-op for render stability.
    expect(
      applyCategoryBindingAssignment(updated, 'groceries', {
        mode: 'source',
        categoryId: 'dining-out',
      }),
    ).toBe(updated)
    expect(
      applyCategoryBindingAssignment(null, 'groceries', { mode: 'title' }),
    ).toBeNull()
  })

  it('keeps the mapped preview on one shared grid covering its tracks', () => {
    const { unmount } = render(
      <MappedPreview rows={previewRows} onViewAll={() => {}} />,
    )
    expectUnifiedMappedTable(
      screen.getByRole('table', { name: 'Mapped expense preview rows' }),
      ['Source row', 'Date', 'Title', 'Amount', 'Category', 'Status'],
      6,
    )
    unmount()
  })

  it('keeps the view-all dialog on one shared grid covering its tracks', () => {
    const { unmount } = render(
      <MappedExpensesDialog
        rows={previewRows}
        open
        status="ready"
        filter="ALL"
        issueField={null}
        onOpenChange={() => {}}
        onFilterChange={() => {}}
      />,
    )
    expectUnifiedMappedTable(
      screen.getByRole('table', { name: 'All mapped expense rows' }),
      ['Source row', 'Date', 'Title', 'Amount', 'Category', 'Status'],
      6,
    )
    unmount()
  })

  it('keeps the review list on one shared grid covering its tracks', () => {
    const { unmount } = render(
      <ReviewExpensesList
        rows={[
          {
            mapped: {
              ...previewRows[0],
              rowId: 'review-grid-row',
              rowNumber: 2,
              issues: [],
              warning: null,
              error: null,
            } as never,
            expense: {
              title: 'Brownie',
              amount: 5000,
              category: 'general',
            } as never,
            selected: true,
            approvedDuplicateKeys: [],
          },
        ]}
        duplicateByRow={new Map()}
        onSelectedChange={() => {}}
        onEdit={() => {}}
        scrollPosition={{ current: 0 }}
      />,
    )
    expectUnifiedMappedTable(
      screen.getByRole('table', { name: 'Expenses to review' }),
      [
        'Select and edit row',
        'Source row',
        'Date',
        'Title',
        'Amount',
        'Category',
        'Status',
      ],
      7,
    )
    unmount()
  })

  it('styles source table headers consistently', () => {
    const raw = render(
      <RawPreview table={table} visibleRows={10} onShowAll={() => {}} />,
    )
    const rawHeaders = within(screen.getByRole('table')).getAllByRole(
      'columnheader',
    )
    expect(rawHeaders.map((header) => header.textContent)).toEqual([
      'Row',
      'Date',
      'Note',
      'Amount',
    ])
    for (const header of rawHeaders) {
      expect(header).toHaveClass('text-muted-foreground')
    }
    raw.unmount()

    render(<SourceFileDialog table={table} open onOpenChange={() => {}} />)
    const sourceHeaders = within(
      screen.getByRole('table', { name: 'Parsed source rows' }),
    ).getAllByRole('columnheader')
    expect(sourceHeaders.map((header) => header.textContent)).toEqual([
      'Row',
      'Date',
      'Note',
      'Amount',
    ])
    for (const header of sourceHeaders) {
      expect(header).toHaveClass('text-muted-foreground')
    }
  })

  it('rebuilds drafts on currency/timezone change while keeping selections and edits', () => {
    const defaults = {
      paidBy: { mode: 'SINGLE' as const, participantId: 'alice' },
      paidFor: {
        mode: 'EVENLY' as const,
        shares: [
          { participant: 'alice', shares: 1 },
          { participant: 'bob', shares: 1 },
        ],
      },
    }
    const mappedBase = {
      ...previewRows[0]!,
      rowId: 'rebuild-2',
      rowNumber: 2,
      title: 'Cafe',
      expenseDate: '2022-03-14',
      expenseTimeMinutes: 600,
      amount: 1000,
      currency: 'USD',
      category: 'general' as const,
      issues: [],
      warning: null,
      error: null,
    }
    const current = [
      {
        mapped: mappedBase,
        expense: {
          title: 'Cafe',
          amount: 1000,
          category: 'general',
          expenseDate: new Date('2022-03-14T00:00:00.000Z'),
          expenseTimeZone: 'UTC',
        } as never,
        selected: true,
        approvedDuplicateKeys: ['dup-1'],
      },
      {
        mapped: { ...mappedBase, rowId: 'rebuild-3', rowNumber: 3 },
        expense: {
          title: 'Edited',
          amount: 2000,
          category: 'groceries',
          expenseDate: new Date('2022-03-14T00:00:00.000Z'),
          expenseTimeZone: 'UTC',
        } as never,
        selected: false,
        approvedDuplicateKeys: [],
      },
    ]
    const edited = new Map<number, (typeof current)[number]>()
    edited.set(3, current[1]!)

    const rebuilt = rebuildDraftsForSettingsChange(
      current as never,
      edited as never,
      {
        defaults,
        timeZone: 'Europe/Berlin',
        ledgerCurrencyCode: 'EUR',
        fallbackTitle: 'Invalid import row',
      },
    )

    // Non-edited row is re-derived with the new timezone and a conversion
    // because its USD currency differs from the EUR ledger.
    expect(rebuilt[0]!.expense.expenseTimeZone).toBe('Europe/Berlin')
    expect(rebuilt[0]!.expense.conversion).toMatchObject({ currency: 'USD' })
    // Selection and approvals survive the recompute.
    expect(rebuilt[0]!.selected).toBe(true)
    expect(rebuilt[0]!.approvedDuplicateKeys).toEqual(['dup-1'])
    // Edited rows stay pinned to their full-form overrides.
    expect(rebuilt[1]).toBe(current[1])
  })

  it('hashes remeasure lenses to a compact stable key', () => {
    expect(fnv1aHash('')).toBe(0x811c9dc5)
    expect(fnv1aHash('a')).not.toBe(fnv1aHash('b'))
    const pieces = ['row-1:2', 'row-2:3']
    expect(hashPreviewLens(pieces, 'filter')).toBe(
      hashPreviewLens(pieces, 'filter'),
    )
    expect(hashPreviewLens(pieces, 'filter')).not.toBe(
      hashPreviewLens([...pieces, 'row-3:1'], 'filter'),
    )
    expect(hashPreviewLens(pieces, 'ALL')).not.toBe(
      hashPreviewLens(pieces, 'ISSUES'),
    )
    expect(hashPreviewLens(pieces).length).toBeLessThan(pieces.join('|').length)
  })

  it('exposes review and mapped filters as pressed toggles', () => {
    const row = {
      mapped: {
        ...previewRows[0]!,
        rowId: 'filter-row',
        rowNumber: 2,
      } as never,
      expense: { title: 'Cafe', amount: 5000, category: 'general' } as never,
      selected: true,
      approvedDuplicateKeys: [],
    }
    render(
      <ReviewExpensesList
        rows={[row]}
        duplicateByRow={new Map()}
        onSelectedChange={() => {}}
        onEdit={() => {}}
        scrollPosition={{ current: 0 }}
        scrollResetKey="ALL"
      />,
    )
    // Review list itself does not render filters; mapped dialog does.
    const { unmount } = render(
      <MappedExpensesDialog
        rows={previewRows.slice(0, 2)}
        open
        status="ready"
        filter="ALL"
        issueField={null}
        onOpenChange={() => {}}
        onFilterChange={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: /All rows/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: /Issues/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    unmount()
  })

  it('links issue and duplicate details to the row checkbox', () => {
    const row = {
      mapped: {
        ...previewRows[0]!,
        rowId: 'describe-row',
        rowNumber: 2,
        issues: [
          {
            rowNumber: 2,
            field: 'title' as const,
            severity: 'warning' as const,
            code: 'CATEGORY_NO_CONFIDENT_MATCH' as const,
            message: 'No confident category match for “Cafe”; using General.',
            params: { titlePart: ' for “Cafe”', category: 'General' },
          },
        ],
        warning: 'No confident category match for “Cafe”; using General.',
        error: null,
      } as never,
      expense: { title: 'Cafe', amount: 5000, category: 'general' } as never,
      selected: true,
      approvedDuplicateKeys: [],
    }
    render(
      <ReviewExpensesList
        rows={[row]}
        duplicateByRow={
          new Map([
            [
              'describe-row',
              [
                {
                  key: 'dup-1',
                  kind: 'EXISTING_EXPENSE' as const,
                  expenseId: 'e1',
                  sourceRowId: null,
                  title: 'Cafe',
                  expenseDate: '2022-03-14',
                  amount: 5000,
                  currency: 'USD',
                },
              ],
            ],
          ])
        }
        onSelectedChange={() => {}}
        onEdit={() => {}}
        scrollPosition={{ current: 0 }}
      />,
    )
    const checkbox = screen.getByRole('checkbox', { name: /Select row 2/ })
    const describedBy = checkbox.getAttribute('aria-describedby') ?? ''
    expect(describedBy).toMatch(/review-status-describe-row/)
    expect(describedBy).toMatch(/review-issue-describe-row-0/)
    expect(describedBy).toMatch(/review-duplicate-describe-row-0/)
    expect(
      document.getElementById('review-issue-describe-row-0'),
    ).toHaveTextContent(
      'No confident category match for “Cafe”; using General.',
    )
    expect(
      document.getElementById('review-duplicate-describe-row-0'),
    ).toHaveTextContent(/Possible existing expense/)
  })
})
