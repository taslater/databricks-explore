// Label geometry for the sketch: how big a node must be for its label, and where a connector's label sits.
// Pure, and the same rules as layout.py (fit_size, _label_plan), so the canvas, the doctor, tidy and the PNG render
// agree. Keep the constants and the order of operations in step with that file. No React or store imports.
import type { Point, Side, Size, SketchEdge, SketchNode } from './types'

/** A sketch label wider than this wraps (and the node grows taller) instead of widening further. */
export const MAX_FIT_W = 320
const LABEL_CHAR_W = 6.7
const LABEL_LINE_H = 15.6
const LABEL_PAD_X = 14
const LABEL_PAD_Y = 6
const STEP_OFFSET = 20
const SHARE_TOL = 1

type FitNode = Pick<SketchNode, 'type' | 'shape' | 'label' | 'font_size' | 'size' | 'placeholder'>

const SHAPE_FACTOR: Record<string, number> = { ellipse: 0.7, diamond: 0.5, cylinder: 0.9 }

const chars = (s: string) => Array.from(s).length

/** What a node needs to hold its label by a character-width estimate (layout.py `_label_fit`), or null when it fits. */
export function labelNeeds(n: FitNode): Size | null {
  const { w, h } = n.size
  if (n.type === 'placeholder') {
    const name = n.placeholder?.name ?? ''
    const need = chars(name) * 8.2 + 40
    return name && need > w ? { w: Math.ceil(need), h } : null
  }
  const text = n.label ?? ''
  if (!text) return null
  const fs = n.font_size || 14
  const cw = 0.56 * fs
  const lh = 1.3 * fs
  if (n.type === 'frame') {
    const need = chars(text) * cw + 16
    return need > w ? { w: Math.ceil(need), h } : null
  }
  const f = n.type === 'shape' ? (SHAPE_FACTOR[n.shape ?? ''] ?? 1) : 1
  const usableW = w * f - 16
  const usableH = h * f - 8
  let lines = 0
  let longest = 0
  for (const para of text.split('\n')) {
    let cur = 0
    for (const word of para.split(' ')) {
      const ww = chars(word) * cw
      longest = Math.max(longest, ww)
      if (cur > 0 && cur + cw + ww > usableW) {
        lines += 1
        cur = ww
      } else {
        cur += (cur > 0 ? cw : 0) + ww
      }
    }
    lines += 1
  }
  const needH = lines * lh
  if (longest > usableW || needH > usableH) {
    return { w: Math.ceil(Math.max(longest + 16, w * f) / f), h: Math.ceil((needH + 8) / f) }
  }
  return null
}

/**
 * The node's size grown just enough for its label to fit; never smaller than it is now. Shape, text and sticky
 * labels widen to their one-line width up to `maxW`, then wrap and grow taller (a single longer word still widens
 * the node). Frame titles and placeholder names are one line, so they widen as far as they need.
 */
export function fitSize(n: FitNode, maxW: number = MAX_FIT_W): Size {
  let { w, h } = n.size
  if ((n.type === 'shape' || n.type === 'text' || n.type === 'sticky') && n.label) {
    const fs = n.font_size || 14
    const f = n.type === 'shape' ? (SHAPE_FACTOR[n.shape ?? ''] ?? 1) : 1
    const oneLine = (Math.max(...n.label.split('\n').map(chars)) * 0.56 * fs + 16) / f
    w = Math.max(w, Math.min(oneLine, maxW))
  }
  for (let i = 0; i < 4; i++) {
    const need = labelNeeds({ ...n, size: { w, h } })
    if (!need) break
    w = Math.max(w, need.w)
    h = Math.max(h, need.h)
  }
  return { w: Math.ceil(w), h: Math.ceil(h) }
}

// ---- Connector labels --------------------------------------------------------------------------
//
// A connector's label is centered at the midpoint of the longest segment of its route that no other connector runs
// along, moved along that segment by the edge's `label_offset` px (toward the segment's end when positive). When
// every segment is shared the longest one is used. Tidy sets `label_offset` to keep labels apart.

type Pt = [number, number]
type Seg = [Pt, Pt]

interface Rect {
  position: Point
  size: Size
}

const facing = (a: Rect, b: Rect): Side => {
  const dx = b.position.x + b.size.w / 2 - (a.position.x + a.size.w / 2)
  const dy = b.position.y + b.size.h / 2 - (a.position.y + a.size.h / 2)
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'r' : 'l'
  return dy >= 0 ? 'b' : 't'
}

const sidePoint = (n: Rect, side: Side): Pt => {
  const { x, y } = n.position
  const { w, h } = n.size
  return side === 't' ? [x + w / 2, y] : side === 'r' ? [x + w, y + h / 2] : side === 'b' ? [x + w / 2, y + h] : [x, y + h / 2]
}

const DIR: Record<Side, Pt> = { t: [0, -1], r: [1, 0], b: [0, 1], l: [-1, 0] }

/** The polyline a connector is drawn along (layout.py `_route`; step routing is an approximation of the canvas's own). */
export function routeOf(e: Pick<SketchEdge, 'source_handle' | 'target_handle' | 'line'>, a: Rect, b: Rect): Pt[] {
  const sh = e.source_handle ?? facing(a, b)
  const th = e.target_handle ?? facing(b, a)
  const p = sidePoint(a, sh)
  const q = sidePoint(b, th)
  if (e.line !== 'step') return [p, q]
  const hs = sh === 'l' || sh === 'r'
  const ht = th === 'l' || th === 'r'
  if (hs && ht && ((sh === 'r' && th === 'l' && q[0] >= p[0]) || (sh === 'l' && th === 'r' && q[0] <= p[0]))) {
    const mx = (p[0] + q[0]) / 2
    return [p, [mx, p[1]], [mx, q[1]], q]
  }
  if (!hs && !ht && ((sh === 'b' && th === 't' && q[1] >= p[1]) || (sh === 't' && th === 'b' && q[1] <= p[1]))) {
    const my = (p[1] + q[1]) / 2
    return [p, [p[0], my], [q[0], my], q]
  }
  const p1: Pt = [p[0] + DIR[sh][0] * STEP_OFFSET, p[1] + DIR[sh][1] * STEP_OFFSET]
  const q1: Pt = [q[0] + DIR[th][0] * STEP_OFFSET, q[1] + DIR[th][1] * STEP_OFFSET]
  let mid: Pt[]
  if (hs && !ht) mid = [[q1[0], p1[1]]]
  else if (!hs && ht) mid = [[p1[0], q1[1]]]
  else if (hs) {
    const xo = sh === 'r' && th === 'r' ? Math.max(p1[0], q1[0]) : sh === 'l' && th === 'l' ? Math.min(p1[0], q1[0]) : null
    const ym = (p1[1] + q1[1]) / 2
    mid = xo !== null ? [[xo, p1[1]], [xo, q1[1]]] : [[p1[0], ym], [q1[0], ym]]
  } else {
    const yo = sh === 'b' && th === 'b' ? Math.max(p1[1], q1[1]) : sh === 't' && th === 't' ? Math.min(p1[1], q1[1]) : null
    const xm = (p1[0] + q1[0]) / 2
    mid = yo !== null ? [[p1[0], yo], [q1[0], yo]] : [[xm, p1[1]], [xm, q1[1]]]
  }
  return [p, p1, ...mid, q1, q]
}

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** The straight runs of a route: repeated points dropped, consecutive segments on one line merged. */
export function segmentsOf(pts: Pt[]): Seg[] {
  const segs: Seg[] = []
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i]
    const q = pts[i + 1]
    if (dist(p, q) <= 1e-6) continue
    const last = segs[segs.length - 1]
    if (last) {
      const [a, b] = last
      const cross = (b[0] - a[0]) * (q[1] - b[1]) - (b[1] - a[1]) * (q[0] - b[0])
      const dot = (b[0] - a[0]) * (q[0] - b[0]) + (b[1] - a[1]) * (q[1] - b[1])
      if (Math.abs(cross) < 1e-6 * Math.max(1, dist(a, b) * dist(b, q)) && dot > 0) {
        segs[segs.length - 1] = [a, q]
        continue
      }
    }
    segs.push([p, q])
  }
  return segs
}

function runsAlong([p, q]: Seg, [r, s]: Seg): boolean {
  const d: Pt = [q[0] - p[0], q[1] - p[1]]
  const ln = Math.hypot(d[0], d[1])
  if (ln < 1e-9) return false
  const u: Pt = [d[0] / ln, d[1] / ln]
  if ([r, s].some((pt) => Math.abs((pt[0] - p[0]) * u[1] - (pt[1] - p[1]) * u[0]) > SHARE_TOL)) return false
  const a = (r[0] - p[0]) * u[0] + (r[1] - p[1]) * u[1]
  const b = (s[0] - p[0]) * u[0] + (s[1] - p[1]) * u[1]
  return Math.min(ln, Math.max(a, b)) - Math.max(0, Math.min(a, b)) > SHARE_TOL
}

/** The estimated size of a connector label: 12 px text, one box per label. */
export function labelSize(text: string): Size {
  const lines = text.split('\n')
  return { w: Math.max(...lines.map(chars)) * LABEL_CHAR_W + LABEL_PAD_X, h: lines.length * LABEL_LINE_H + LABEL_PAD_Y }
}

/**
 * Where each labeled connector's label is centered, by connector id. Connectors whose ends are not both in `nodes`,
 * that loop back to their own node, or that have no label are left out.
 */
export function labelCenters(nodes: (Rect & { id: string })[], edges: SketchEdge[]): Record<string, Point> {
  const by = new Map(nodes.map((n) => [n.id, n]))
  const routed = edges
    .filter((e) => e.source !== e.target && by.has(e.source) && by.has(e.target))
    .map((e) => {
      const route = routeOf(e, by.get(e.source) as Rect, by.get(e.target) as Rect)
      return { e, route, segs: segmentsOf(route) }
    })
  const out: Record<string, Point> = {}
  for (const { e, route, segs } of routed) {
    if (!e.label) continue
    const base: Seg[] = segs.length > 0 ? segs : [[route[0], [route[0][0] + 1, route[0][1]]]]
    const others = routed.filter((r) => r.e !== e).flatMap((r) => r.segs)
    const free = base.filter((sg) => !others.some((o) => runsAlong(sg, o)))
    const pool = free.length > 0 ? free : base
    let best = pool[0]
    for (const sg of pool) if (dist(sg[0], sg[1]) > dist(best[0], best[1])) best = sg
    const [a, b] = best
    const ln = dist(a, b)
    const dir: Pt = ln > 1e-9 ? [(b[0] - a[0]) / ln, (b[1] - a[1]) / ln] : [1, 0]
    const half = ln / 2
    const o = Math.max(-half, Math.min(half, e.label_offset ?? 0))
    out[e.id] = { x: (a[0] + b[0]) / 2 + dir[0] * o, y: (a[1] + b[1]) / 2 + dir[1] * o }
  }
  return out
}
