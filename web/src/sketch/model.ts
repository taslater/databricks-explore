// Pure logic for the sketch module: defaults, palette, ids, alignment, stacking order, containment,
// copy and paste. No React, store or fetch imports, so tests call it directly.
import { fitSize } from './labels'
import type {
  Geometry,
  HostNode,
  Point,
  ShapeKind,
  Side,
  Size,
  SketchEdge,
  SketchNode,
  SketchType,
  Tool,
} from './types'

export const GRID = 20

export interface Swatch {
  name: string
  value: string
}

/** Fills are light so dark text stays readable. `none` is transparent. */
export const FILLS: Swatch[] = [
  { name: 'None', value: 'none' },
  { name: 'White', value: '#ffffff' },
  { name: 'Gray', value: '#e5e7eb' },
  { name: 'Red', value: '#fee2e2' },
  { name: 'Orange', value: '#ffedd5' },
  { name: 'Yellow', value: '#fef9c3' },
  { name: 'Green', value: '#dcfce7' },
  { name: 'Blue', value: '#dbeafe' },
  { name: 'Purple', value: '#ede9fe' },
]

/** Strokes (and connector colors) are the strong versions of the same hues. */
export const STROKES: Swatch[] = [
  { name: 'Black', value: '#1f2328' },
  { name: 'Gray', value: '#6b7280' },
  { name: 'Red', value: '#dc2626' },
  { name: 'Orange', value: '#ea580c' },
  { name: 'Yellow', value: '#ca8a04' },
  { name: 'Green', value: '#16a34a' },
  { name: 'Blue', value: '#2563eb' },
  { name: 'Purple', value: '#7c3aed' },
]

export const FONT_SIZES: { label: string; px: number }[] = [
  { label: 'S', px: 12 },
  { label: 'M', px: 14 },
  { label: 'L', px: 18 },
  { label: 'XL', px: 24 },
]

export const DEFAULT_FONT_SIZE = 14
export const DEFAULT_STROKE = '#1f2328'
export const DEFAULT_EDGE_COLOR = '#1f2328'

export const SHAPE_NAMES: Record<ShapeKind, string> = {
  rect: 'Rectangle',
  rounded: 'Rounded rectangle',
  ellipse: 'Ellipse',
  diamond: 'Diamond',
  cylinder: 'Database',
}

const SHAPE_SIZES: Record<ShapeKind, Size> = {
  rect: { w: 140, h: 80 },
  rounded: { w: 140, h: 80 },
  ellipse: { w: 140, h: 80 },
  diamond: { w: 120, h: 100 },
  cylinder: { w: 100, h: 120 },
}

export const PLACEHOLDER_WIDTH = 280
export const PLACEHOLDER_MIN_HEIGHT = 120

/** Default size of a node of this kind. */
export function defaultSize(type: SketchType, shape?: ShapeKind): Size {
  switch (type) {
    case 'shape':
      return { ...SHAPE_SIZES[shape ?? 'rect'] }
    case 'text':
      return { w: 140, h: 40 }
    case 'sticky':
      return { w: 160, h: 160 }
    case 'frame':
      return { w: 400, h: 300 }
    case 'placeholder':
      return { w: PLACEHOLDER_WIDTH, h: PLACEHOLDER_MIN_HEIGHT }
  }
}

/**
 * The size a node gets when its label is `label` and nobody resized it: the default size, grown to fit the label
 * (wrapping past MAX_FIT_W), rounded up to the grid when `snap` is on.
 */
export function fittedSize(n: SketchNode, label: string, snap: boolean): Size {
  const fit = fitSize({ ...n, label, size: defaultSize(n.type, n.shape) })
  return snap ? { w: Math.ceil(fit.w / GRID) * GRID, h: Math.ceil(fit.h / GRID) * GRID } : fit
}

/** The node with a committed label. Its size follows the label unless the person resized it (it no longer matches what the old label gave). */
export function withLabel(n: SketchNode, label: string, snap: boolean): SketchNode {
  const untouched = n.type !== 'placeholder' && sameSize(n.size, fittedSize(n, n.label ?? '', snap))
  return untouched ? { ...n, label, size: fittedSize(n, label, snap) } : { ...n, label }
}

function sameSize(a: Size, b: Size): boolean {
  return a.w === b.w && a.h === b.h
}

/** True when typing or double-clicking can edit this node's label: not a placeholder table, not locked. */
export function isLabelable(n: { type: string; locked?: boolean }): boolean {
  return n.type !== 'placeholder' && n.locked !== true
}

/** The tool for a placing tool, as the node it creates. Null for select, hand and connect. */
export function toolToNode(tool: Tool): { type: SketchType; shape?: ShapeKind } | null {
  switch (tool) {
    case 'rect':
    case 'rounded':
    case 'ellipse':
    case 'diamond':
    case 'cylinder':
      return { type: 'shape', shape: tool }
    case 'text':
    case 'sticky':
    case 'frame':
    case 'placeholder':
      return { type: tool }
    default:
      return null
  }
}

/** A UUID for a new placeholder table. */
export function newUuid(): string {
  return crypto.randomUUID()
}

/** A new node with the defaults for its type. `id` is supplied by the caller (see nextId). */
export function newSketchNode(
  id: string,
  type: SketchType,
  position: Point,
  opts: { shape?: ShapeKind; size?: Size } = {},
): SketchNode {
  const size = opts.size ?? defaultSize(type, opts.shape)
  const base: SketchNode = { id, type, position: { x: position.x, y: position.y }, size: { ...size } }
  switch (type) {
    case 'shape':
      return { ...base, shape: opts.shape ?? 'rect', label: '', fill: '#ffffff', stroke: DEFAULT_STROKE, font_size: DEFAULT_FONT_SIZE }
    case 'text':
      return { ...base, label: '', fill: 'none', stroke: 'none', font_size: 16 }
    case 'sticky':
      return { ...base, label: '', fill: '#fef9c3', stroke: '#ca8a04', font_size: DEFAULT_FONT_SIZE }
    case 'frame':
      return { ...base, label: 'Group', fill: '#e5e7eb', stroke: '#6b7280', font_size: DEFAULT_FONT_SIZE }
    case 'placeholder':
      return {
        ...base,
        fill: '#ffffff',
        stroke: '#2563eb',
        font_size: DEFAULT_FONT_SIZE,
        placeholder: {
          id: newUuid(),
          name: 'new_table',
          columns: [
            { name: 'id', type: 'bigint', key: 'pk' },
            { name: '', type: '' },
          ],
        },
      }
  }
}

/** Next free id with this prefix: one above the largest number already used. */
export function nextId(prefix: string, ids: Iterable<string>): string {
  let max = 0
  const pattern = new RegExp(`^${prefix}(\\d+)$`)
  for (const id of ids) {
    const m = pattern.exec(id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${prefix}${max + 1}`
}

export function snapValue(v: number, grid: number = GRID): number {
  return Math.round(v / grid) * grid
}

export function snapPoint(p: Point, grid: number = GRID): Point {
  return { x: snapValue(p.x, grid), y: snapValue(p.y, grid) }
}

export function snapSize(s: Size, grid: number = GRID): Size {
  return { w: Math.max(grid, snapValue(s.w, grid)), h: Math.max(grid, snapValue(s.h, grid)) }
}

// ---- Geometry of the whole canvas -------------------------------------------------------------

/** One node as the alignment, ordering and containment code sees it, whoever owns it. */
export interface Item {
  id: string
  type: string
  position: Point
  size: Size
  z?: number
  locked?: boolean
}

export function toItems(nodes: SketchNode[], host: HostNode[]): Item[] {
  return [
    ...host.map((h) => ({ id: h.id, type: h.type, position: h.position, size: h.size, z: h.z, locked: h.locked })),
    ...nodes.map((n) => ({ id: n.id, type: n.type, position: n.position, size: n.size, z: n.z, locked: n.locked })),
  ]
}

export type AlignMode = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom'
export type DistributeAxis = 'horizontal' | 'vertical'

/**
 * New positions that line the unlocked items in `ids` up with the extreme edge or the middle of the
 * whole selection (locked items count for the bounds, but do not move). Returns only the items that move.
 */
export function align(items: Item[], ids: ReadonlySet<string>, mode: AlignMode): Record<string, Point> {
  const sel = items.filter((i) => ids.has(i.id))
  if (sel.length < 2) return {}
  const left = Math.min(...sel.map((i) => i.position.x))
  const right = Math.max(...sel.map((i) => i.position.x + i.size.w))
  const top = Math.min(...sel.map((i) => i.position.y))
  const bottom = Math.max(...sel.map((i) => i.position.y + i.size.h))
  const out: Record<string, Point> = {}
  for (const i of sel) {
    if (i.locked) continue
    let { x, y } = i.position
    if (mode === 'left') x = left
    else if (mode === 'right') x = right - i.size.w
    else if (mode === 'center') x = (left + right) / 2 - i.size.w / 2
    else if (mode === 'top') y = top
    else if (mode === 'bottom') y = bottom - i.size.h
    else y = (top + bottom) / 2 - i.size.h / 2
    if (x !== i.position.x || y !== i.position.y) out[i.id] = { x, y }
  }
  return out
}

/**
 * Spaces the unlocked items in `ids` so the gaps between them are equal, keeping the outermost two in place.
 * Needs three or more items. Returns only the items that move.
 */
export function distribute(items: Item[], ids: ReadonlySet<string>, axis: DistributeAxis): Record<string, Point> {
  const sel = items.filter((i) => ids.has(i.id))
  if (sel.length < 3) return {}
  const h = axis === 'horizontal'
  const start = (i: Item) => (h ? i.position.x : i.position.y)
  const len = (i: Item) => (h ? i.size.w : i.size.h)
  const sorted = [...sel].sort((a, b) => start(a) - start(b))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  const span = start(last) + len(last) - start(first)
  const total = sorted.reduce((sum, i) => sum + len(i), 0)
  const gap = (span - total) / (sorted.length - 1)
  const out: Record<string, Point> = {}
  let cursor = start(first)
  for (const i of sorted) {
    if (!i.locked && cursor !== start(i)) {
      out[i.id] = h ? { x: cursor, y: i.position.y } : { x: i.position.x, y: cursor }
    }
    cursor += len(i) + gap
  }
  return out
}

// ---- Stacking order ---------------------------------------------------------------------------

export type OrderOp = 'front' | 'back' | 'forward' | 'backward'

/** The z a node has when it carries none: frames sit behind everything else. */
export function effectiveZ(i: { type: string; z?: number }): number {
  return i.z ?? (i.type === 'frame' ? -1 : 0)
}

/** Items from back to front. Equal z keeps the order given. */
export function stackOrder<T extends { type: string; z?: number }>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => effectiveZ(a.item) - effectiveZ(b.item) || a.index - b.index)
    .map((e) => e.item)
}

/**
 * Moves the items in `ids` one step (forward, backward) or all the way (front, back) in the stack.
 * Returns the new z for every item whose z has to change, as ranks 0..n-1. Empty when nothing moves.
 */
export function reorder(items: Item[], ids: ReadonlySet<string>, op: OrderOp): Record<string, number> {
  const before = stackOrder(items)
  const order = [...before]
  const selected = (i: Item) => ids.has(i.id)
  if (op === 'front') {
    order.splice(0, order.length, ...before.filter((i) => !selected(i)), ...before.filter(selected))
  } else if (op === 'back') {
    order.splice(0, order.length, ...before.filter(selected), ...before.filter((i) => !selected(i)))
  } else if (op === 'forward') {
    for (let k = order.length - 2; k >= 0; k--) {
      if (selected(order[k]) && !selected(order[k + 1])) [order[k], order[k + 1]] = [order[k + 1], order[k]]
    }
  } else {
    for (let k = 1; k < order.length; k++) {
      if (selected(order[k]) && !selected(order[k - 1])) [order[k], order[k - 1]] = [order[k - 1], order[k]]
    }
  }
  if (order.every((i, k) => i === before[k])) return {}
  const out: Record<string, number> = {}
  order.forEach((i, k) => {
    if (i.z !== k) out[i.id] = k
  })
  return out
}

// ---- Containment ------------------------------------------------------------------------------

/** Ids of the unlocked items that lie entirely inside the frame. Moving the frame moves these. */
export function containedIds(frame: Item, items: Item[]): string[] {
  const x2 = frame.position.x + frame.size.w
  const y2 = frame.position.y + frame.size.h
  return items
    .filter(
      (i) =>
        i.id !== frame.id &&
        !i.locked &&
        i.position.x >= frame.position.x &&
        i.position.y >= frame.position.y &&
        i.position.x + i.size.w <= x2 &&
        i.position.y + i.size.h <= y2,
    )
    .map((i) => i.id)
}

// ---- Copy and paste ---------------------------------------------------------------------------

export interface Clip {
  nodes: SketchNode[]
  edges: SketchEdge[]
}

/** The sketch nodes in `ids`, and the connectors with both ends among them. Deep copies. */
export function copyClip(nodes: SketchNode[], edges: SketchEdge[], ids: ReadonlySet<string>): Clip {
  const picked = nodes.filter((n) => ids.has(n.id))
  const keep = new Set(picked.map((n) => n.id))
  return {
    nodes: JSON.parse(JSON.stringify(picked)) as SketchNode[],
    edges: JSON.parse(JSON.stringify(edges.filter((e) => keep.has(e.source) && keep.has(e.target)))) as SketchEdge[],
  }
}

/**
 * New nodes and connectors from a clip, moved by `offset`, with fresh ids. A pasted placeholder gets a new
 * UUID (it is a different table), and a pasted connector forgets any relationship it was saved as.
 * `taken` are the ids already on the canvas, host windows included.
 */
export function pasteClip(
  clip: Clip,
  offset: Point,
  takenNodeIds: Iterable<string>,
  takenEdgeIds: Iterable<string>,
): { nodes: SketchNode[]; edges: SketchEdge[]; idMap: Record<string, string> } {
  const used = new Set(takenNodeIds)
  const idMap: Record<string, string> = {}
  const nodes: SketchNode[] = clip.nodes.map((n) => {
    const id = nextId('s', used)
    used.add(id)
    idMap[n.id] = id
    const copy: SketchNode = JSON.parse(JSON.stringify(n)) as SketchNode
    copy.id = id
    copy.position = { x: n.position.x + offset.x, y: n.position.y + offset.y }
    if (copy.placeholder) copy.placeholder = { ...copy.placeholder, id: newUuid() }
    return copy
  })
  const usedEdges = new Set(takenEdgeIds)
  const edges: SketchEdge[] = clip.edges.map((e) => {
    const id = nextId('c', usedEdges)
    usedEdges.add(id)
    const copy: SketchEdge = JSON.parse(JSON.stringify(e)) as SketchEdge
    copy.id = id
    copy.source = idMap[e.source]
    copy.target = idMap[e.target]
    delete copy.relationship
    return copy
  })
  return { nodes, edges, idMap }
}

// ---- Connectors -------------------------------------------------------------------------------

export function defaultEdge(
  id: string,
  source: string,
  target: string,
  sourceHandle: Side | undefined,
  targetHandle: Side | undefined,
  style: Pick<SketchEdge, 'line' | 'arrow_start' | 'arrow_end' | 'dashed' | 'color'> = {
    line: 'step',
    arrow_start: false,
    arrow_end: true,
    dashed: false,
  },
): SketchEdge {
  const edge: SketchEdge = {
    id,
    source,
    target,
    line: style.line,
    arrow_start: style.arrow_start,
    arrow_end: style.arrow_end,
    dashed: style.dashed,
  }
  if (sourceHandle) edge.source_handle = sourceHandle
  if (targetHandle) edge.target_handle = targetHandle
  if (style.color) edge.color = style.color
  return edge
}

export function isSide(v: string | null | undefined): v is Side {
  return v === 't' || v === 'r' || v === 'b' || v === 'l'
}

/** Swaps the two ends of a connector, handles and arrowheads included. The column pair swaps too. */
export function reverseEdge(e: SketchEdge): SketchEdge {
  const out: SketchEdge = { ...e, source: e.target, target: e.source, arrow_start: e.arrow_end, arrow_end: e.arrow_start }
  delete out.source_handle
  delete out.target_handle
  if (e.source_handle) out.target_handle = e.source_handle
  if (e.target_handle) out.source_handle = e.target_handle
  if (e.relationship) {
    const r = { ...e.relationship }
    delete r.source_column
    delete r.target_column
    if (e.relationship.target_column) r.source_column = e.relationship.target_column
    if (e.relationship.source_column) r.target_column = e.relationship.source_column
    out.relationship = r
  }
  return out
}

export function geometryOf(n: { position: Point; size: Size; z?: number }): Geometry {
  const g: Geometry = { position: { ...n.position }, size: { ...n.size } }
  if (n.z !== undefined) g.z = n.z
  return g
}
