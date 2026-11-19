// Export of the Graph as a picture: the legend of what is on screen, the date its facts were read, and the frame (title,
// caption, legend, date) drawn around the rendered canvas. Everything stays local; nothing is uploaded.
import { toCanvas } from 'html-to-image'
import type { Cardinality, GraphEdge } from '../api/types'
import type { FactsByTable } from '../api/nodeFacts'
import { typeLegend, type NodeColors } from './colorBy'
import { collapseGraph, type Grouping } from './collapse'
import { deriveFlow, edgeShown } from './derive'
import { legendOf } from './EdgeFamilies'
import { edgeStyle, familyOf, FAMILY_LABEL } from './edgeStyles'
import { hasEnds } from './EdgeEnds'
import { traceColumnEdges, traceNodes, type ActiveTrace } from './traceDraw'
import type { EdgeFilters, FlowEdge, FlowNode } from './types'

/** One line of the picture's legend: a line sample, a color square, or text alone. */
export type LegendItem =
  | { kind: 'line'; text: string; stroke: string; width: number; dash?: string }
  | { kind: 'swatch'; text: string; fill: string }
  | { kind: 'text'; text: string }

export interface LegendInput {
  edges: GraphEdge[]
  filters: EdgeFilters
  ends: Record<string, Cardinality | null> | undefined
  nodes: FlowNode[]
  colorBy: string
  colors: NodeColors | null
}

/** The same words as the page's legend and the MCP picture's. */
export const ENDS_TEXT = 'ends: || exactly one, o| zero or one, o< zero or more'

/** (graph_export.legend is the Python twin; web/src/parity.test.ts and tests/test_parity.py run both on the same cases.) The legend of what the picture draws and nothing else: the edge families shown, dashed, the ends, the key markers, what the fill means. */
export function pictureLegend(input: LegendInput): LegendItem[] {
  const shownEdges = input.edges.filter((e) => edgeShown(e, input.filters))
  const { families, inferred, superseded } = legendOf(shownEdges)
  const shownEnds = Object.fromEntries(shownEdges.filter((e) => familyOf(e.kind) === 'reference').map((e) => [e.id, input.ends?.[e.id] ?? null]))
  const out: LegendItem[] = families.map((f) => {
    const s = edgeStyle(f, false)
    return { kind: 'line', text: FAMILY_LABEL[f], stroke: s.stroke, width: s.strokeWidth ?? 1.6, dash: s.strokeDasharray }
  })
  const line = (text: string, s: ReturnType<typeof edgeStyle>): LegendItem => ({ kind: 'line', text, stroke: s.stroke, width: s.strokeWidth ?? 1.6, dash: s.strokeDasharray })
  if (inferred) out.push(line('dashed: inferred or proposed', edgeStyle('reference', true)))
  if (superseded) out.push(line('no longer holds', edgeStyle('flow', false, true)))
  if (hasEnds(shownEnds)) out.push({ kind: 'text', text: ENDS_TEXT })
  const columns = input.nodes.filter((n) => !n.hidden && n.data.showColumns).flatMap((n) => n.data.columns ?? [])
  if (columns.some((c) => c.pk)) out.push({ kind: 'text', text: 'key icon: primary key' })
  if (columns.some((c) => c.fk)) out.push({ kind: 'text', text: 'arrow icon: foreign key' })
  const shown = input.nodes.filter((n) => !n.hidden && !n.data.summary) // a collapsed group's node has a look of its own
  if (shown.length > 0) {
    const entries = input.colorBy === 'type' ? typeLegend(shown.map((n) => n.data.kind)) : (input.colors?.legend.entries ?? [])
    for (const e of entries) out.push({ kind: 'swatch', text: input.colorBy === 'type' ? e.value : `${input.colorBy}: ${e.value}`, fill: e.fill })
  }
  return out
}

export interface SceneInput {
  nodes: FlowNode[]
  edges: FlowEdge[]
  columnEdges: FlowEdge[]
  focusSchema: string | null
  filters: EdgeFilters
  grouping: Grouping
  groupTags: Record<string, string>
  trace: ActiveTrace | null
}

/**
 * What the canvas draws, as the export reads it: the visible nodes (a collapsed group is one node, with its `summary`) and the table-level
 * edges (a chain of pass-through views is one edge; a column trace adds its tables but its hops sit between rows, so they are not edges here).
 */
export function exportScene(input: SceneInput): { nodes: FlowNode[]; edges: GraphEdge[] } {
  const traced = traceNodes(input.nodes, input.trace)
  const view = collapseGraph({ nodes: traced, edges: input.edges, filters: input.filters, grouping: input.grouping, groupTags: input.groupTags })
  const flow = deriveFlow({
    nodes: view.nodes,
    edges: view.edges,
    columnEdges: traceColumnEdges(input.columnEdges, input.nodes, input.trace),
    focusSchema: input.focusSchema,
    filters: input.filters,
    hoverId: null,
    forceHidden: view.hidden,
  })
  return { nodes: flow.nodes.filter((n) => !n.hidden), edges: flow.edges.filter((e) => !e.hidden && !e.data!.info.source_column).map((e) => e.data!.info) }
}

/** The date, YYYY-MM-DD, of the oldest read among the evidence shown: the edges' provenance and the cached size reads. Null when none is dated. */
export function factsReadDate(edges: GraphEdge[], facts: FactsByTable | undefined): string | null {
  const times = [...edges.map((e) => e.provenance?.fetched_at), ...Object.values(facts ?? {}).map((f) => f.stats?.fetched_at)].filter(
    (t): t is string => typeof t === 'string' && t.length >= 10,
  )
  return times.length > 0 ? times.reduce((a, b) => (a < b ? a : b)).slice(0, 10) : null
}

/** What the picture says about its date: when the facts were read, else when it was drawn. */
export const dateLine = (read: string | null, today: string): string => (read ? `Facts read ${read}` : `Exported ${today}`)

const PAD = 24
const LINE = 22
const COLUMNS = 3
const MIN_WIDTH = 480

/** The legend in rows of up to three items; a long line of text gets a row to itself, so it is not squeezed. */
export function legendRows(items: LegendItem[]): LegendItem[][] {
  const rows: LegendItem[][] = []
  let row: LegendItem[] = []
  for (const item of items) {
    if (item.text.length > 36) {
      if (row.length > 0) rows.push(row)
      rows.push([item])
      row = []
    } else {
      row.push(item)
      if (row.length === COLUMNS) {
        rows.push(row)
        row = []
      }
    }
  }
  if (row.length > 0) rows.push(row)
  return rows
}

/** Sizes of the frame around an image of width x height: the header, the legend rows and the footer. */
export function frameMetrics(width: number, height: number, legendRowCount: number, hasCaption: boolean) {
  const header = hasCaption ? 72 : 52
  const rows = Math.max(1, legendRowCount)
  const footer = 16 + rows * LINE + LINE
  return { header, rows, footer, width, height: header + height + footer, columnWidth: Math.max(1, Math.floor((width - 2 * PAD) / COLUMNS)) }
}

export interface Frame {
  title: string
  caption: string
  legend: LegendItem[]
  date: string
}

/** Draws the image under a title and caption and above the legend and date, on a white canvas of the same width. */
export function composePicture(image: CanvasImageSource, imageWidth: number, height: number, frame: Frame, scale: number): HTMLCanvasElement {
  const width = Math.max(imageWidth, MIN_WIDTH) // room for the title and the legend even when the graph is small
  const legend = legendRows(frame.legend)
  const m = frameMetrics(width, height, legend.length, frame.caption.trim() !== '')
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(m.width * scale)
  canvas.height = Math.round(m.height * scale)
  const c = canvas.getContext('2d')
  if (!c) throw new Error('This browser cannot draw the picture.')
  c.scale(scale, scale)
  c.fillStyle = '#ffffff'
  c.fillRect(0, 0, m.width, m.height)
  c.textBaseline = 'top'
  c.fillStyle = '#1f2328'
  c.font = '600 20px system-ui, sans-serif'
  c.fillText(frame.title, PAD, 14, width - 2 * PAD)
  if (frame.caption.trim()) {
    c.fillStyle = '#6b7280'
    c.font = '13px system-ui, sans-serif'
    c.fillText(frame.caption, PAD, 44, width - 2 * PAD)
  }
  c.drawImage(image, (width - imageWidth) / 2, m.header, imageWidth, height)
  const top = m.header + height + 8
  c.strokeStyle = '#d0d7de'
  c.beginPath()
  c.moveTo(PAD, top)
  c.lineTo(width - PAD, top)
  c.stroke()
  c.font = '12px system-ui, sans-serif'
  legend.forEach((row, r) => row.forEach((item, i) => {
    const x = PAD + i * m.columnWidth
    const y = top + 8 + r * LINE
    let textX = x
    if (item.kind === 'line') {
      c.strokeStyle = item.stroke
      c.lineWidth = item.width
      c.setLineDash(item.dash ? item.dash.split(/[ ,]+/).map(Number) : [])
      c.beginPath()
      c.moveTo(x, y + 7)
      c.lineTo(x + 28, y + 7)
      c.stroke()
      c.setLineDash([])
      textX = x + 36
    } else if (item.kind === 'swatch') {
      c.fillStyle = item.fill
      c.strokeStyle = '#9aa4b2'
      c.lineWidth = 1
      c.fillRect(x, y + 1, 14, 12)
      c.strokeRect(x, y + 1, 14, 12)
      textX = x + 22
    }
    c.fillStyle = '#1f2328'
    c.fillText(item.text, textX, y, (row.length === 1 && item.text.length > 36 ? width - 2 * PAD : m.columnWidth) - (textX - x) - 8)
  }))
  c.fillStyle = '#6b7280'
  c.fillText(frame.date, PAD, top + 8 + m.rows * LINE)
  return canvas
}

export type PictureScope = 'graph' | 'view'

const PADDING = 32
const MAX_SIDE = 8000

/** The flow-space box around every node on screen, read from the page (concept nodes too), with the viewport's pan and zoom. */
export function sceneBounds(root: HTMLElement): { x: number; y: number; width: number; height: number; tx: number; ty: number; zoom: number; viewW: number; viewH: number } | null {
  const viewport = root.querySelector<HTMLElement>('.react-flow__viewport')
  const container = viewport?.parentElement
  if (!viewport || !container) return null
  const m = new DOMMatrix(getComputedStyle(viewport).transform)
  const zoom = m.a || 1
  const box = container.getBoundingClientRect()
  const rects = [...viewport.querySelectorAll<HTMLElement>('.react-flow__node')].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0)
  if (rects.length === 0) return null
  const x1 = Math.min(...rects.map((r) => r.left)), y1 = Math.min(...rects.map((r) => r.top))
  const x2 = Math.max(...rects.map((r) => r.right)), y2 = Math.max(...rects.map((r) => r.bottom))
  return { x: (x1 - box.left - m.e) / zoom, y: (y1 - box.top - m.f) / zoom, width: (x2 - x1) / zoom, height: (y2 - y1) / zoom, tx: m.e, ty: m.f, zoom, viewW: box.width, viewH: box.height }
}

/** Renders the canvas under the frame as one picture (a canvas ready to download or copy). Throws an Error with a message for the person when there is nothing to draw. */
export async function renderPicture(root: HTMLElement, scope: PictureScope, frame: Frame): Promise<HTMLCanvasElement> {
  const viewport = root.querySelector<HTMLElement>('.react-flow__viewport')
  const bounds = sceneBounds(root)
  if (!viewport || !bounds) throw new Error('The graph is empty or not showing.')
  const whole = scope === 'graph'
  const w = whole ? Math.ceil(bounds.width + PADDING * 2) : Math.round(bounds.viewW)
  const h = whole ? Math.ceil(bounds.height + PADDING * 2) : Math.round(bounds.viewH)
  const shrink = Math.min(1, MAX_SIDE / Math.max(w, h))
  const transform = whole ? `scale(${shrink}) translate(${PADDING - bounds.x}px, ${PADDING - bounds.y}px)` : `translate(${bounds.tx}px, ${bounds.ty}px) scale(${bounds.zoom})`
  const drawn = await toCanvas(viewport, {
    backgroundColor: '#ffffff',
    width: Math.round(w * (whole ? shrink : 1)),
    height: Math.round(h * (whole ? shrink : 1)),
    pixelRatio: 2,
    style: { width: `${w}px`, height: `${h}px`, transform, transformOrigin: '0 0' },
  })
  const outW = Math.round(w * (whole ? shrink : 1))
  const outH = Math.round(h * (whole ? shrink : 1))
  return composePicture(drawn, outW, outH, frame, 2)
}

/** A file-name stem from a title: letters, digits, dot, dash and underscore. */
export const fileStem = (title: string): string => title.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'graph'

export const canvasBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The picture could not be made.'))), 'image/png'))
