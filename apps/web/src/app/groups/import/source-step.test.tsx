import userEvent from '@testing-library/user-event'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { fireEvent, render, screen } from '@/test/test-utils'

import type { SourceMode } from './source-providers'
import { SourceStep } from './source-step'

// jsdom doesn't implement scrollIntoView; the SourceStep mount effect
// calls it on the active tab.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {}
  }
})

// ── Module mocks ────────────────────────────────────────────────────────

const routerMocks = vi.hoisted(() => ({
  source: 'spliit' as SourceMode,
  navigate: vi.fn(),
}))

// Mock @tanstack/react-router so we don't need to spin up a router.
vi.mock('@tanstack/react-router', () => ({
  getRouteApi: () => ({
    useSearch: () => ({ source: routerMocks.source }),
  }),
  Link: ({
    to,
    children,
    ...props
  }: {
    to: string
    children: React.ReactNode
    [key: string]: unknown
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => routerMocks.navigate,
}))

// SourceStep no longer owns its own useImportSource; the wizard passes
// the shared state down. The tests pass it explicitly so the prefill-
// error path is the only thing under test.
function renderSourceStep(
  overrides: Partial<React.ComponentProps<typeof SourceStep>> = {},
) {
  return render(
    <SourceStep
      onLoaded={vi.fn()}
      onError={vi.fn()}
      sourcePreview={undefined}
      isSourcePreviewLoading={false}
      sourcePreviewError={null}
      submitPreview={vi.fn()}
      resetPreview={vi.fn()}
      {...overrides}
    />,
  )
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('SourceStep — initialError (prefill) handling', () => {
  beforeEach(() => {
    routerMocks.source = 'spliit'
    routerMocks.navigate.mockReset()
  })

  it('keeps the provider tabs in Spliit, Cloud, then the other providers order', () => {
    renderSourceStep()
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Spliit',
      'Spliit Cloud',
      'Splitwise',
      'Cospend',
      'Tricount (coming soon)',
      'Settle Up (coming soon)',
    ])
  })

  it('aligns non-card controls and gives every provider card responsive standalone padding', () => {
    const providers = [
      'spliit',
      'spliit-cloud',
      'splitwise',
      'cospend',
      'tricount',
      'settleup',
    ] as const

    for (const provider of providers) {
      routerMocks.source = provider
      const view = renderSourceStep()

      expect(screen.getByRole('tablist').parentElement).toHaveClass(
        'px-[var(--page-inset,1rem)]',
        'sm:px-0',
      )

      const cards = view.container.querySelectorAll('[data-import-source-card]')
      expect(cards.length).toBeGreaterThan(0)
      for (const card of cards) {
        const content = Array.from(card.children).find((child) =>
          child.classList.contains('px-4'),
        )
        expect(content).toHaveClass('px-4', 'pt-4', 'sm:px-6', 'sm:pt-6')
        expect(content).not.toHaveClass('p-4')
      }

      view.unmount()
    }
  })

  it('explains that Cloud accepts account backups and single-group exports', () => {
    routerMocks.source = 'spliit-cloud'
    renderSourceStep()

    expect(
      screen.getAllByText(
        /Spliit Cloud account backup containing multiple groups.*single group export/i,
      ),
    ).toHaveLength(2)
  })

  it('offers a retained Cloud bundle without requiring another file selection', async () => {
    const onResume = vi.fn()
    renderSourceStep({ retainedCloudBundle: { onResume } })
    expect(screen.getByText(/Spliit Cloud bundle ready/i)).toBeInTheDocument()
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: /continue with this bundle/i }))
    expect(onResume).toHaveBeenCalledOnce()
  })

  it('identifies a ZIP selected in the legacy tab as a Cloud bundle', async () => {
    const view = renderSourceStep()
    const input = view.container.querySelector('input[type="file"]')
    if (!(input instanceof HTMLInputElement))
      throw new Error('file input missing')

    fireEvent.change(input, {
      target: {
        files: [
          new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'backup.zip', {
            type: 'application/zip',
          }),
        ],
      },
    })

    expect(
      await screen.findByText(/belongs in the Spliit Cloud importer/i),
    ).toBeInTheDocument()
  })

  it('requires a ZIP when a Cloud account manifest is not inside a bundle', async () => {
    routerMocks.source = 'spliit-cloud'
    const onError = vi.fn()
    const view = renderSourceStep({ onError })
    const input = view.container.querySelector('input[type="file"]')
    if (!(input instanceof HTMLInputElement))
      throw new Error('file input missing')

    fireEvent.change(input, {
      target: {
        files: [
          new File(
            [
              JSON.stringify({
                format: 'spliit.cloud/export',
                scope: { type: 'ACCOUNT' },
              }),
            ],
            'account.zip',
            { type: 'application/zip' },
          ),
        ],
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onError).toHaveBeenCalledWith(
      'Choose a Spliit Cloud .spliit.zip bundle.',
    )
  })

  it('renders the prefill error inline when no own serverUrlError is set', () => {
    renderSourceStep({
      initialError: 'Spliit Cloud did not find this group',
    })
    expect(
      screen.getByText('Spliit Cloud did not find this group'),
    ).toBeInTheDocument()
  })

  it('hides the prefill error after the user types in the URL input', async () => {
    const user = userEvent.setup()
    renderSourceStep({
      initialError: 'Spliit Cloud did not find this group',
    })

    const urlInput = screen.getByPlaceholderText(/spliit\.app.*groups/i)
    await user.type(urlInput, 'a')

    expect(
      screen.queryByText('Spliit Cloud did not find this group'),
    ).not.toBeInTheDocument()
  })

  it('does not render any error when no initialError is provided', () => {
    renderSourceStep()
    // No Spliit error visible.
    expect(
      screen.queryByText(/did not find this group/i),
    ).not.toBeInTheDocument()
  })

  it('notes that CSV cannot import recurrence', () => {
    renderSourceStep()
    expect(
      screen.getByText(/CSV exports do not include recurrence/i),
    ).toBeInTheDocument()
  })
})
