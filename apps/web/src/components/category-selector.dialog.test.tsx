import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { render, screen } from '@/test/test-utils'
import { DEFAULT_CATEGORIES, DEFAULT_CATEGORY_ID } from '@spliit/domain'

import { CategorySelector } from './category-selector'

vi.mock(import('@/lib/hooks'), async (importActual) => {
  const actual = await importActual()
  return { ...actual, useMediaQuery: () => true }
})

describe('CategorySelector inside modal dialog (desktop)', () => {
  it('keeps the popover open after clicking a parent while nested in a Dialog', async () => {
    const user = userEvent.setup({
      pointerEventsCheck: PointerEventsCheckLevel.Never,
    })
    const onValueToggle = vi.fn()

    render(
      <ResponsiveDialog open>
        <ResponsiveDialogContent>
          <ResponsiveDialogTitle>Pick a category</ResponsiveDialogTitle>
          <CategorySelector
            categories={DEFAULT_CATEGORIES}
            defaultValue={DEFAULT_CATEGORY_ID}
            isLoading={false}
            mode="multi"
            onValueChange={() => {}}
            onValueToggle={onValueToggle}
          />
        </ResponsiveDialogContent>
      </ResponsiveDialog>,
    )

    await user.click(screen.getByRole('combobox'))
    expect(screen.getByPlaceholderText('Search category...')).toHaveFocus()

    const parent = await screen.findByRole('option', {
      name: /^Home$/,
    })

    await user.click(parent)

    expect(onValueToggle).toHaveBeenCalledWith('home')
    expect(
      await screen.findByRole('option', { name: /^Home$/ }),
    ).toBeInTheDocument()
  })
})
