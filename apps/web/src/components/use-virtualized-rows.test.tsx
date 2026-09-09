import { beforeEach, describe, expect, it, vi } from 'vitest'

import { render, screen } from '@/test/test-utils'

import { useVirtualizedRows } from './use-virtualized-rows'

// Deterministic virtualizer stand-in: jsdom has no layout, so the real
// TanStack math clamps offsets unpredictably. These tests target the hook's
// own reset/restore/remeasure decisions — when it assigns scrollTop and when
// it calls scrollToOffset — with an exact, layout-free scroll element.
//
// Kept inline (not in a helper module): `vi.mock` must register before any
// import pulls in the real module, and only an in-file mock is hoisted
// above all imports regardless of import sorting.
const stubState = {
  opts: null as {
    count?: number
    getScrollElement?: () => HTMLDivElement | null
  } | null,
  scrollToOffsetCalls: [] as number[],
  measureCalls: 0,
}
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: typeof stubState.opts) => {
    stubState.opts = opts
    return stubVirtualizer
  },
}))
const stubVirtualizer = {
  getVirtualItems: () => {
    const count = stubState.opts?.count ?? 0
    return Array.from({ length: Math.min(count, 5) }, (_, index) => ({
      index,
      start: index * 56,
      size: 56,
      key: index,
    }))
  },
  getTotalSize: () => (stubState.opts?.count ?? 0) * 56,
  measure: () => {
    stubState.measureCalls += 1
  },
  scrollToOffset: (offset: number) => {
    stubState.scrollToOffsetCalls.push(offset)
    const element = stubState.opts?.getScrollElement?.()
    if (element) element.scrollTop = offset
  },
  measureElement: () => {},
}

function Harness({
  count = 100,
  resetKey = 'ALL',
  offset = 0,
  remeasure = 'a',
}: {
  count?: number
  resetKey?: string
  offset?: number
  remeasure?: string
}) {
  const virtualRows = useVirtualizedRows({
    count,
    estimateSize: 56,
    remeasureKey: remeasure,
    getItemKey: (index) => `row-${index}`,
    overscan: 4,
    // Mirrors ReviewExpensesList: explicit resets via scrollResetKey, with a
    // saved edit-return offset. Omitting this (undefined) would disable the
    // deferred-restore path under test.
    resetScrollOnChange: false,
    scrollResetKey: resetKey,
    initialScrollOffset: offset,
  })
  // Destructure: the compiler's ref analysis otherwise taints every
  // `virtualRows.*` access during render (false positive; the identical
  // production usage in ReviewExpensesList is clean).
  const { items, measureElement, setScrollRef } = virtualRows
  return (
    <div
      ref={setScrollRef}
      data-testid="scroller"
      style={{ height: 200, overflow: 'auto' }}
    >
      {items.map((item) => (
        <MeasuredRow
          key={item.key}
          index={item.index}
          measure={measureElement}
        />
      ))}
    </div>
  )
}

function MeasuredRow({
  index,
  measure,
}: {
  index: number
  measure: (element: HTMLElement | null) => void
}) {
  return (
    <div ref={measure} data-index={index} style={{ height: 56 }}>
      row {index}
    </div>
  )
}

const flushFrames = () => new Promise((resolve) => setTimeout(resolve, 50))

describe('useVirtualizedRows scroll restoration', () => {
  beforeEach(() => {
    stubState.scrollToOffsetCalls = []
    stubState.measureCalls = 0
  })

  it('restores a saved offset once on mount', async () => {
    render(<Harness offset={2000} />)
    const scroller = screen.getByTestId('scroller')
    await flushFrames()
    expect(scroller.scrollTop).toBe(2000)
  })

  it('resets to top on filter change and never restores the stale offset', async () => {
    // The saved offset ref goes stale (no scroll event fires for the
    // programmatic reset), so the hook must not resurrect it — neither
    // synchronously nor in the deferred measure frame.
    const view = render(<Harness offset={2000} resetKey="ALL" />)
    const scroller = screen.getByTestId('scroller')
    await flushFrames()
    expect(scroller.scrollTop).toBe(2000)
    stubState.scrollToOffsetCalls = []

    view.rerender(<Harness offset={2000} resetKey="ERRORS" />)
    expect(scroller.scrollTop).toBe(0)
    await flushFrames()
    expect(scroller.scrollTop).toBe(0)
    expect(stubState.scrollToOffsetCalls).toEqual([])
  })

  it('applies a new restoration offset after an edit return', async () => {
    const view = render(<Harness offset={2000} resetKey="ALL" />)
    const scroller = screen.getByTestId('scroller')
    await flushFrames()
    expect(scroller.scrollTop).toBe(2000)

    // Returning from editing another row is a new restoration event with a
    // new offset value: it applies even though an offset was consumed.
    view.rerender(<Harness offset={3000} resetKey="ALL" />)
    await flushFrames()
    expect(scroller.scrollTop).toBe(3000)
  })

  it('preserves the live user position across remeasurement', async () => {
    const view = render(<Harness offset={2000} resetKey="ALL" />)
    const scroller = screen.getByTestId('scroller')
    await flushFrames()
    expect(scroller.scrollTop).toBe(2000)

    // The user scrolls (live position diverges from the saved snapshot),
    // then row content remeasures: no jump back to the snapshot, no reset.
    scroller.scrollTop = 500
    view.rerender(<Harness offset={2000} resetKey="ALL" remeasure="b" />)
    await flushFrames()
    expect(scroller.scrollTop).toBe(500)
    expect(stubState.scrollToOffsetCalls).toEqual([2000])
  })

  it('restores again on remount with the same offset', async () => {
    const view = render(<Harness offset={2000} resetKey="ALL" />)
    const scroller = screen.getByTestId('scroller')
    await flushFrames()
    expect(scroller.scrollTop).toBe(2000)

    view.unmount()
    render(<Harness offset={2000} resetKey="ALL" />)
    const remounted = screen.getByTestId('scroller')
    await flushFrames()
    expect(remounted.scrollTop).toBe(2000)
  })

  it('ignores stale frames from rapid filter changes', async () => {
    const view = render(<Harness offset={2000} resetKey="ALL" />)
    const scroller = screen.getByTestId('scroller')
    await flushFrames()
    // The mount restoration is the only scrollToOffset call allowed: rapid
    // resets must measure without re-asserting anything.
    expect(stubState.scrollToOffsetCalls).toEqual([2000])

    view.rerender(<Harness offset={2000} resetKey="ERRORS" />)
    view.rerender(<Harness offset={2000} resetKey="READY" />)
    expect(scroller.scrollTop).toBe(0)
    await flushFrames()
    expect(scroller.scrollTop).toBe(0)
    expect(stubState.scrollToOffsetCalls).toEqual([2000])
  })

  it('handles empty to nonempty transitions without jumping', async () => {
    const view = render(<Harness count={0} offset={0} resetKey="ERRORS" />)
    view.rerender(<Harness count={50} offset={0} resetKey="ERRORS" />)
    const scroller = screen.getByTestId('scroller')
    await flushFrames()
    expect(scroller.scrollTop).toBe(0)
  })
})
