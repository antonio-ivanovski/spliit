import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Shared mechanics for the importer's large row surfaces. Consumers retain
 * control of table/list semantics and row presentation.
 */
export function useVirtualizedRows(options: {
  count: number
  estimateSize: number
  remeasureKey?: unknown
  enabled?: boolean
  overscan?: number
  resetScrollOnChange?: boolean
  // Saved offset to restore once per mount or restoration event (e.g.
  // returning from full-form edit). A filter reset consumes it; later runs
  // never re-assert a consumed value.
  initialScrollOffset?: number
  // Stable per-row keys so cached measurements survive reordering (e.g. the
  // review list re-sorts by severity). Without this, sizes stick to positions.
  getItemKey?: (index: number) => string | number
  // When provided, the scroll offset resets only when this key changes (e.g.
  // a filter switch). Pure measurement updates via remeasureKey then preserve
  // the user's position instead of snapping to the top.
  scrollResetKey?: unknown
}) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  )
  const lastScrollResetKey = useRef<{ value: unknown } | null>(null)
  // Offset values already applied as a mount restore or an edit-return
  // restoration event. A consumed offset is never re-asserted: filter resets
  // win over stale saved positions, and pure remeasurement preserves the
  // live user position instead of snapping back to a stale snapshot.
  const appliedOffset = useRef<{ value: number } | null>(null)
  const latestResetKey = useRef<unknown>(undefined)
  latestResetKey.current = options.scrollResetKey
  const setScrollRef = useCallback(
    (element: HTMLDivElement | null) => setScrollElement(element),
    [],
  )
  const virtualizer = useVirtualizer({
    count: options.count,
    getScrollElement: () => scrollElement,
    estimateSize: () => options.estimateSize,
    getItemKey: options.getItemKey,
    initialRect: { width: 1024, height: 560 },
    initialOffset: options.initialScrollOffset ?? 0,
    overscan: options.overscan ?? 8,
  })

  useEffect(() => {
    if (options.enabled === false || !scrollElement) return
    // An explicit reset key takes precedence: only its change resets the
    // offset, while remeasureKey updates only re-measure in place.
    const usesResetKey = options.scrollResetKey !== undefined
    // The first mount only records the key so remounts can restore a saved
    // offset; only a genuine change resets to the top.
    const resetKeyChanged =
      usesResetKey &&
      lastScrollResetKey.current !== null &&
      !Object.is(lastScrollResetKey.current.value, options.scrollResetKey)
    if (usesResetKey)
      lastScrollResetKey.current = { value: options.scrollResetKey }
    const offset = options.initialScrollOffset ?? 0
    // The deferred frame below re-asserts an offset only when this run
    // applies a fresh restoration — never for resets or remeasures.
    let frameOffset: number | null = null
    if (resetKeyChanged) {
      scrollElement.scrollTop = 0
      // A reset consumes any pending restoration: the stale saved offset
      // must not come back in the frame below.
      appliedOffset.current = { value: offset }
    } else if (options.resetScrollOnChange !== false && !usesResetKey)
      scrollElement.scrollTop = 0
    else if (offset > 0 && !Object.is(appliedOffset.current?.value, offset)) {
      scrollElement.scrollTop = offset
      appliedOffset.current = { value: offset }
      frameOffset = offset
    }
    const snapshotKey = options.scrollResetKey
    const frame = window.requestAnimationFrame(() => {
      if (usesResetKey && !Object.is(snapshotKey, latestResetKey.current))
        return
      virtualizer.measure()
      // Re-assert only an offset this run applied: the virtualizer settles
      // asynchronously after a mount/restore. A newer reset consumes the
      // value first, so a stale frame can never undo it.
      if (
        frameOffset !== null &&
        Object.is(appliedOffset.current?.value, frameOffset)
      ) {
        virtualizer.scrollToOffset(frameOffset)
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [
    options.count,
    options.enabled,
    options.initialScrollOffset,
    options.remeasureKey,
    options.resetScrollOnChange,
    options.scrollResetKey,
    scrollElement,
    virtualizer,
  ])

  const measuredItems = virtualizer.getVirtualItems()
  const items = measuredItems.length
    ? measuredItems
    : Array.from({ length: Math.min(options.count, 20) }, (_, index) => ({
        index,
        start: index * options.estimateSize,
        size: options.estimateSize,
        key: index,
      }))

  const measureElement = useCallback(
    (element: HTMLElement | null) => {
      if (element) virtualizer.measureElement(element)
    },
    [virtualizer],
  )

  return {
    items,
    // Keep the ref active during the first render as well.  TanStack can
    // return no virtual items until the scroll element is observed; measuring
    // the small initial fallback window lets it immediately converge to the
    // real row sizes instead of leaving a half-empty or zero-height viewport.
    measureElement,
    setScrollRef,
    // Once rows have been measured, TanStack's total is authoritative. Keeping
    // the initial estimate as a permanent minimum leaves a large empty tail
    // whenever the real rows are shorter than the estimate.
    totalSize: measuredItems.length
      ? virtualizer.getTotalSize()
      : options.count * options.estimateSize,
  }
}
