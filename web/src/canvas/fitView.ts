// Fitting the view to the canvas content while keeping it clear of the floating toolbars. Pure functions over
// plain rectangles, so the arithmetic is tested without a browser.

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** A rectangle in screen pixels, as `getBoundingClientRect` gives it. */
export interface ScreenRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

export type Side = 'top' | 'right' | 'bottom' | 'left'

export const FIT_MIN_ZOOM = 0.1
export const FIT_MAX_ZOOM = 1
const PANEL_GAP = 12
/** Space kept clear between the content and the edge of the free area. */
const CONTENT_PADDING = 24

/** The smallest box holding every box, or null when there are none. */
export function contentBounds(boxes: readonly Box[]): Box | null {
  if (boxes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const b of boxes) {
    minX = Math.min(minX, b.x)
    minY = Math.min(minY, b.y)
    maxX = Math.max(maxX, b.x + b.w)
    maxY = Math.max(maxY, b.y + b.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * How far each edge of the canvas area is covered by a floating panel. A panel counts toward the side it hangs
 * from, over the full length of that edge, which errs toward keeping content clear. Panels with no size are skipped.
 */
export function insetsFor(wrap: ScreenRect, panels: readonly { side: Side; rect: ScreenRect }[]): Insets {
  const insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 }
  for (const { side, rect } of panels) {
    if (rect.right - rect.left <= 0 || rect.bottom - rect.top <= 0) continue
    const cover =
      side === 'top'
        ? rect.bottom - wrap.top
        : side === 'bottom'
          ? wrap.bottom - rect.top
          : side === 'left'
            ? rect.right - wrap.left
            : wrap.right - rect.left
    insets[side] = Math.max(insets[side], Math.max(0, cover) + PANEL_GAP)
  }
  return insets
}

/**
 * The viewport that shows `bounds` centered in the area the insets leave free, as large as fits up to 100%.
 * `size` is the canvas area in pixels. When the insets would leave almost nothing, they are ignored.
 */
export function fitViewport(
  bounds: Box,
  size: { width: number; height: number },
  insets: Insets,
  limits: { minZoom?: number; maxZoom?: number } = {},
): { x: number; y: number; zoom: number } {
  const minZoom = limits.minZoom ?? FIT_MIN_ZOOM
  const maxZoom = limits.maxZoom ?? FIT_MAX_ZOOM
  let free = insets
  if (size.width - insets.left - insets.right < 120 || size.height - insets.top - insets.bottom < 120) {
    free = { top: 0, right: 0, bottom: 0, left: 0 }
  }
  const availW = Math.max(1, size.width - free.left - free.right - 2 * CONTENT_PADDING)
  const availH = Math.max(1, size.height - free.top - free.bottom - 2 * CONTENT_PADDING)
  const fit = Math.min(availW / Math.max(bounds.w, 1), availH / Math.max(bounds.h, 1))
  const zoom = Math.min(maxZoom, Math.max(minZoom, fit))
  const cx = bounds.x + bounds.w / 2
  const cy = bounds.y + bounds.h / 2
  const areaCx = free.left + (size.width - free.left - free.right) / 2
  const areaCy = free.top + (size.height - free.top - free.bottom) / 2
  return { x: areaCx - cx * zoom, y: areaCy - cy * zoom, zoom }
}
