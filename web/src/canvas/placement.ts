// Where a new window goes. The caller says where it would like the window; this keeps that spot when it is free
// and otherwise finds the nearest free one, preferring the part of the canvas the person is looking at.
import type { CanvasPoint } from '../api/types'
import { useSketchStore } from '../sketch/sketchStore'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Clearance kept around a floating control, in screen px. */
const PANEL_MARGIN = 8
/** Empty space kept around every existing node. */
export const PLACEMENT_GAP = 24
/** Spacing of the grid of spots tried inside the visible area. */
const GRID_STEP = 40
/**
 * Screen-space strips covered by the floating canvas controls: the toolbar along the top (it can wrap onto a
 * second line), and the sketch palette down the left edge.
 */
export const SCREEN_KEEP_OUT: readonly Rect[] = [
  { x: 0, y: 0, w: 600, h: 110 },
  { x: 0, y: 0, w: 72, h: 100000 },
]

function overlaps(a: Rect, b: Rect, margin = 0): boolean {
  return a.x < b.x + b.w + margin && b.x < a.x + a.w + margin && a.y < b.y + b.h + margin && b.y < a.y + a.h + margin
}

function inside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w &&
    inner.y + inner.h <= outer.y + outer.h
  )
}

export interface PlacementInput {
  /** Where the caller would like the top-left corner. */
  desired: CanvasPoint
  size: { w: number; h: number }
  /** Rectangles of everything already on the canvas, in canvas coordinates. */
  obstacles: readonly Rect[]
  /** The part of the canvas in view, in canvas coordinates. Omit when unknown. */
  visible?: Rect | null
  /** Rectangles to stay out of, in canvas coordinates (the floating controls). */
  keepOut?: readonly Rect[]
}

/**
 * Top-left corner for a new node. The desired spot wins when nothing is in the way. Otherwise: the nearest free
 * spot fully inside the visible area, then one that at least starts there, then the nearest free spot anywhere
 * (beside an existing node). The last step always succeeds.
 */
export function findFreePosition(input: PlacementInput): CanvasPoint {
  const { desired, size, obstacles } = input
  const keepOut = input.keepOut ?? []
  const visible = input.visible ?? null
  const at = (x: number, y: number): Rect => ({ x, y, w: size.w, h: size.h })
  const free = (r: Rect) => !obstacles.some((o) => overlaps(r, o, PLACEMENT_GAP)) && !keepOut.some((k) => overlaps(r, k))

  if (free(at(desired.x, desired.y))) return { x: desired.x, y: desired.y }

  const dist = (p: CanvasPoint) => Math.hypot(p.x - desired.x, p.y - desired.y)
  const nearest = (pts: CanvasPoint[]) =>
    pts.reduce<CanvasPoint | null>((best, p) => (best === null || dist(p) < dist(best) ? p : best), null)

  // Spots next to each node, which is where a person would put the next one.
  const beside: CanvasPoint[] = []
  for (const o of obstacles) {
    beside.push(
      { x: o.x + o.w + PLACEMENT_GAP, y: o.y },
      { x: o.x, y: o.y + o.h + PLACEMENT_GAP },
      { x: o.x - size.w - PLACEMENT_GAP, y: o.y },
      { x: o.x, y: o.y - size.h - PLACEMENT_GAP },
    )
  }

  if (visible) {
    const grid: CanvasPoint[] = []
    for (let y = visible.y; y < visible.y + visible.h; y += GRID_STEP) {
      for (let x = visible.x; x < visible.x + visible.w; x += GRID_STEP) grid.push({ x, y })
    }
    const candidates = [...grid, ...beside].filter((p) => free(at(p.x, p.y)))
    const whole = nearest(candidates.filter((p) => inside(at(p.x, p.y), visible)))
    if (whole) return whole
    // Too big to fit whole: a spot that starts in view still shows the title bar and the top of the window.
    const starts = nearest(
      candidates.filter((p) => p.x >= visible.x && p.y >= visible.y && p.x < visible.x + visible.w && p.y < visible.y + visible.h),
    )
    if (starts) return starts
  }

  const anywhere = nearest(beside.filter((p) => free(at(p.x, p.y))))
  if (anywhere) return anywhere
  // Everything beside a node was taken, or there are no nodes and the desired spot sits under the controls:
  // go right of the rightmost node, or right of the controls.
  const right = obstacles.reduce((m, o) => Math.max(m, o.x + o.w), -Infinity)
  if (Number.isFinite(right)) return { x: right + PLACEMENT_GAP * 2, y: desired.y }
  const kx = keepOut.reduce((m, k) => Math.max(m, k.x + k.w), desired.x)
  return { x: kx + PLACEMENT_GAP, y: desired.y }
}

interface Box {
  position: CanvasPoint
  size: { w: number; h: number }
}

/** Area of the canvas in view and the floating controls, from the live viewport and the DOM. */
function liveView(viewport: { x: number; y: number; zoom: number }): { visible: Rect; keepOut: Rect[] } {
  const el = canvasFlowElement()
  const box = el?.getBoundingClientRect()
  const sw = box && box.width > 0 ? box.width : typeof window !== 'undefined' ? window.innerWidth : 1280
  const sh = box && box.height > 0 ? box.height : typeof window !== 'undefined' ? window.innerHeight : 800
  const z = viewport.zoom > 0 ? viewport.zoom : 1
  // Screen point (sx, sy) is canvas point ((sx - vx) / z, (sy - vy) / z).
  const toCanvas = (r: Rect): Rect => ({ x: (r.x - viewport.x) / z, y: (r.y - viewport.y) / z, w: r.w / z, h: r.h / z })
  return {
    visible: toCanvas({ x: 0, y: 0, w: sw, h: sh }),
    keepOut: screenKeepOut(el, box).map(toCanvas),
  }
}

/**
 * Screen rectangles of the floating controls, relative to the canvas: every React Flow panel (the window buttons,
 * the canvas toolbar, the sketch palette, the bottom edit bar, the zoom controls, the minimap), measured from the DOM.
 * Falls back to fixed strips when nothing can be measured.
 */
function screenKeepOut(el: Element | null | undefined, box: DOMRect | undefined): readonly Rect[] {
  if (!el || !box) return SCREEN_KEEP_OUT
  const out: Rect[] = []
  for (const p of Array.from(el.querySelectorAll('.react-flow__panel'))) {
    const r = p.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) {
      out.push({ x: r.left - box.left - PANEL_MARGIN, y: r.top - box.top - PANEL_MARGIN, w: r.width + 2 * PANEL_MARGIN, h: r.height + 2 * PANEL_MARGIN })
    }
  }
  return out.length > 0 ? out : SCREEN_KEEP_OUT
}

/** Rectangles of the windows given and of the sketch nodes now on the canvas. */
export function obstacleRects(windows: readonly Box[]): Rect[] {
  const out: Rect[] = windows.map((w) => ({ x: w.position.x, y: w.position.y, w: w.size.w, h: w.size.h }))
  for (const n of useSketchStore.getState().nodes) out.push({ x: n.position.x, y: n.position.y, w: n.size.w, h: n.size.h })
  return out
}

/** Free spot for a new window of `size`, wanted at `desired`, given what is on the canvas and in view. */
export function placeNew(
  desired: CanvasPoint,
  size: { w: number; h: number },
  windows: readonly Box[],
  viewport: { x: number; y: number; zoom: number },
): CanvasPoint {
  const { visible, keepOut } = liveView(viewport)
  return findFreePosition({ desired, size, obstacles: obstacleRects(windows), visible, keepOut })
}

/** The Canvas view's React Flow element, or null when the Canvas is not on screen (another tab is showing). */
function canvasFlowElement(): Element | null {
  return typeof document !== 'undefined' ? document.querySelector('.canvas-root .react-flow') : null
}

export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** Screen margins a revealed node keeps from the edges: room for the palette, the toolbars and the bottom bar. */
export const REVEAL_MARGINS = { left: 88, top: 120, right: 24, bottom: 80 }

/**
 * The viewport that brings `rect` (canvas coordinates) into view at the same zoom, or null when it is already fully
 * visible. The node is centered in the space between the margins; one too big for that space is shown from its
 * top-left corner, so its title bar is on screen.
 */
export function revealViewport(
  rect: Rect,
  viewport: Viewport,
  screen: { w: number; h: number },
  margins: typeof REVEAL_MARGINS = REVEAL_MARGINS,
): Viewport | null {
  const z = viewport.zoom > 0 ? viewport.zoom : 1
  const sx = rect.x * z + viewport.x
  const sy = rect.y * z + viewport.y
  const fits =
    sx >= margins.left &&
    sy >= margins.top &&
    sx + rect.w * z <= screen.w - margins.right &&
    sy + rect.h * z <= screen.h - margins.bottom
  if (fits) return null
  const availW = screen.w - margins.left - margins.right
  const availH = screen.h - margins.top - margins.bottom
  const left = margins.left + Math.max(0, (availW - rect.w * z) / 2)
  const top = margins.top + Math.max(0, (availH - rect.h * z) / 2)
  return { x: left - rect.x * z, y: top - rect.y * z, zoom: z }
}

/** revealViewport with the Canvas's size measured from the DOM (the window size when the Canvas is hidden). */
export function revealOnCanvas(rect: Rect, viewport: Viewport): Viewport | null {
  const box = canvasFlowElement()?.getBoundingClientRect()
  const w = box && box.width > 0 ? box.width : typeof window !== 'undefined' ? window.innerWidth : 1280
  const h = box && box.height > 0 ? box.height : typeof window !== 'undefined' ? window.innerHeight : 800
  return revealViewport(rect, viewport, { w, h })
}
