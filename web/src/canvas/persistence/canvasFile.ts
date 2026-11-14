// Canvas file format, versions 1 and 2. The zod schema mirrors contracts/canvas.schema.json and the
// server's checks in canvases.py. The serializer turns store state into a file (always version 2), and
// the loader turns a validated file of either version back into store state. No React or fetch code here.
//
// Imports from the store are type-only so this module stays free of runtime
// side effects (it can be imported by plain scripts).
import { z } from 'zod'
import type { CanvasDoc, CanvasWindow } from '../../api/types'
import type { CanvasViewport } from '../../store/canvasStore'
import { isSketchType, type SketchEdge, type SketchNode } from '../../sketch/types'

export const CANVAS_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/

/** Same reference syntax as sqltools._find_refs: text between double braces, trimmed. */
const REF_PATTERN = /\{\{([^{}]*)\}\}/g

const pointSchema = z.object({ x: z.number(), y: z.number() })

const sizeSchema = z.object({ w: z.number().gt(0), h: z.number().gt(0) })

const viewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  zoom: z.number().gt(0),
})

/** Which field each window type must carry (schema allOf/if/then). */
const REQUIRED_FIELD = {
  query: 'sql',
  chart: 'chart',
  note: 'text',
  table: 'table',
  shape: 'shape',
  placeholder: 'placeholder',
} as const

const sideSchema = z.enum(['t', 'r', 'b', 'l'])

const placeholderSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/),
  name: z.string(),
  columns: z
    .array(z.object({ name: z.string(), type: z.string().default(''), key: z.enum(['pk', 'fk']).optional() }))
    .default([]),
  linked: z.string().min(1).nullable().optional(),
})

const windowSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['query', 'chart', 'note', 'table', 'shape', 'text', 'sticky', 'frame', 'placeholder']),
    title: z
      .string()
      .min(1)
      .regex(/^[^{}]+$/, { error: 'must not contain { or }' })
      .optional(),
    position: pointSchema,
    size: sizeSchema,
    sql: z.string().optional(),
    chart: z.object({ vega_lite: z.record(z.string(), z.unknown()) }).optional(),
    text: z.string().optional(),
    table: z.string().min(1).optional(),
    collapsed: z.boolean().default(false),
    editor_split: z.number().gt(0).lt(100).optional(),
    label: z.string().optional(),
    shape: z.enum(['rect', 'rounded', 'ellipse', 'diamond', 'cylinder']).optional(),
    fill: z.string().optional(),
    stroke: z.string().optional(),
    font_size: z.number().gt(0).optional(),
    locked: z.boolean().optional(),
    z: z.number().optional(),
    placeholder: placeholderSchema.optional(),
  })
  .superRefine((w, ctx) => {
    if (!isSketchType(w.type) && w.title === undefined) {
      ctx.addIssue({ code: 'custom', path: ['title'], message: `required when type is ${w.type}`, input: w })
    }
    const field = REQUIRED_FIELD[w.type as keyof typeof REQUIRED_FIELD]
    if (field !== undefined && w[field] === undefined) {
      ctx.addIssue({ code: 'custom', path: [field], message: `required when type is ${w.type}`, input: w })
    }
  })

const edgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  source_handle: sideSchema.optional(),
  target_handle: sideSchema.optional(),
  line: z.enum(['straight', 'step', 'curve']).default('step'),
  arrow_start: z.boolean().default(false),
  arrow_end: z.boolean().default(true),
  dashed: z.boolean().default(false),
  label: z.string().optional(),
  label_offset: z.number().optional(),
  color: z.string().optional(),
  relationship: z
    .object({
      id: z.string().min(1).optional(),
      source_column: z.string().min(1).optional(),
      target_column: z.string().min(1).optional(),
    })
    .optional(),
})

export const canvasFileSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    name: z.string().min(1).regex(CANVAS_NAME_PATTERN, {
      error: 'may use only letters, digits, _, ., and -',
    }),
    profile: z.string().min(1).nullable().optional(),
    warehouse_id: z.string().nullable().optional(),
    viewport: viewportSchema.optional(),
    windows: z.array(windowSchema),
    links: z
      .array(z.object({ from: z.string().min(1), to: z.string().min(1) }))
      .default([]),
    edges: z.array(edgeSchema).optional(),
  })
  .superRefine((doc, ctx) => {
    // JSON Schema cannot express these, so they are checked here (and on the server).
    if (doc.version === 1) {
      if (typeof doc.profile !== 'string') {
        ctx.addIssue({ code: 'custom', path: ['profile'], message: 'required in version 1', input: doc })
      }
      if (doc.edges !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['edges'], message: 'needs version 2', input: doc })
      }
    }
    const ids = new Set<string>()
    const titles = new Set<string>()
    doc.windows.forEach((w, i) => {
      if (doc.version === 1 && isSketchType(w.type)) {
        ctx.addIssue({ code: 'custom', path: ['windows', i, 'type'], message: `"${w.type}" needs version 2`, input: w })
      }
      if (ids.has(w.id)) {
        ctx.addIssue({ code: 'custom', path: ['windows', i, 'id'], message: `duplicate id "${w.id}"`, input: w })
      }
      ids.add(w.id)
      // Sketch nodes are labeled, not titled, and no SQL refers to them.
      if (isSketchType(w.type)) return
      if (titles.has(w.title ?? '')) {
        ctx.addIssue({
          code: 'custom',
          path: ['windows', i, 'title'],
          message: `duplicate title "${w.title}"`,
          input: w,
        })
      }
      titles.add(w.title ?? '')
    })
    const edgeIds = new Set<string>()
    for (const [i, e] of (doc.edges ?? []).entries()) {
      if (edgeIds.has(e.id)) {
        ctx.addIssue({ code: 'custom', path: ['edges', i, 'id'], message: `duplicate id "${e.id}"`, input: e })
      }
      edgeIds.add(e.id)
      for (const key of ['source', 'target'] as const) {
        if (!ids.has(e[key])) {
          ctx.addIssue({ code: 'custom', path: ['edges', i, key], message: `no window with id "${e[key]}"`, input: e })
        }
      }
    }
    doc.links.forEach((l, i) => {
      for (const key of ['from', 'to'] as const) {
        if (!ids.has(l[key])) {
          ctx.addIssue({
            code: 'custom',
            path: ['links', i, key],
            message: `no window with id "${l[key]}"`,
            input: l,
          })
        }
      }
    })
  })

/** A canvas file that has passed validation. */
export type CanvasFile = z.infer<typeof canvasFileSchema>

/** Formats the first zod issue the way the server does: `windows[1].title: duplicate title "x"`. */
export function describeIssues(err: z.ZodError): string {
  const first = err.issues[0]
  let where = ''
  for (const p of first.path) {
    where += typeof p === 'number' ? `[${p}]` : where === '' ? String(p) : `.${String(p)}`
  }
  return where ? `${where}: ${first.message}` : first.message
}

/** Validates unknown input. Throws an Error whose message names the failing path. */
export function parseCanvasFile(input: unknown): CanvasFile {
  const r = canvasFileSchema.safeParse(input)
  if (!r.success) throw new Error(describeIssues(r.error))
  return r.data
}

/**
 * Derives drawing links from `{{title}}` references. Each link runs from the referenced
 * window to the referencing one. Dangling references and self-references are skipped.
 * Repeated references collapse to one link. This is a display derivation, not SQL parsing.
 */
export function deriveLinks(windows: CanvasWindow[]): { from: string; to: string }[] {
  const idByTitle = new Map<string, string>()
  for (const w of windows) {
    if (!idByTitle.has(w.title)) idByTitle.set(w.title, w.id)
  }
  const seen = new Set<string>()
  const out: { from: string; to: string }[] = []
  for (const w of windows) {
    if (w.type !== 'query' || !w.sql) continue
    for (const m of w.sql.matchAll(REF_PATTERN)) {
      const from = idByTitle.get(m[1].trim())
      if (from === undefined || from === w.id) continue
      const key = `${from}>${w.id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ from, to: w.id })
    }
  }
  return out
}

export interface CanvasMeta {
  name: string
  /** The connected profile, or null when there is none (a version 2 file may be saved without one). */
  profile: string | null
  warehouseId: string | null
}

function toFileWindow(w: CanvasWindow): CanvasWindow {
  const out: CanvasWindow = {
    id: w.id,
    type: w.type,
    title: w.title,
    position: { x: w.position.x, y: w.position.y },
    size: { w: w.size.w, h: w.size.h },
    collapsed: w.collapsed ?? false,
  }
  if (w.sql !== undefined) out.sql = w.sql
  if (w.chart !== undefined) out.chart = w.chart
  if (w.text !== undefined) out.text = w.text
  if (w.table !== undefined) out.table = w.table
  if (w.editor_split !== undefined) out.editor_split = w.editor_split
  if (w.locked) out.locked = true
  if (w.z !== undefined) out.z = w.z
  return out
}

/** A sketch node as the file holds it: only the fields it has, and no `locked` unless it is. */
function toFileSketchNode(n: SketchNode): SketchNode {
  const out: SketchNode = {
    id: n.id,
    type: n.type,
    position: { x: n.position.x, y: n.position.y },
    size: { w: n.size.w, h: n.size.h },
  }
  if (n.label !== undefined) out.label = n.label
  if (n.shape !== undefined) out.shape = n.shape
  if (n.fill !== undefined) out.fill = n.fill
  if (n.stroke !== undefined) out.stroke = n.stroke
  if (n.font_size !== undefined) out.font_size = n.font_size
  if (n.locked) out.locked = true
  if (n.z !== undefined) out.z = n.z
  if (n.placeholder !== undefined) {
    out.placeholder = {
      id: n.placeholder.id,
      name: n.placeholder.name,
      columns: n.placeholder.columns.map((c) => {
        const col: { name: string; type: string; key?: 'pk' | 'fk' } = { name: c.name, type: c.type }
        if (c.key) col.key = c.key
        return col
      }),
    }
    if (n.placeholder.linked) out.placeholder.linked = n.placeholder.linked
  }
  return out
}

function toFileEdge(e: SketchEdge): SketchEdge {
  const out: SketchEdge = {
    id: e.id,
    source: e.source,
    target: e.target,
    line: e.line,
    arrow_start: e.arrow_start,
    arrow_end: e.arrow_end,
    dashed: e.dashed,
  }
  if (e.source_handle) out.source_handle = e.source_handle
  if (e.target_handle) out.target_handle = e.target_handle
  if (e.label) out.label = e.label
  if (e.label_offset) out.label_offset = e.label_offset
  if (e.color) out.color = e.color
  if (e.relationship && Object.keys(e.relationship).length > 0) out.relationship = { ...e.relationship }
  return out
}

/**
 * Store state to the file shape (always version 2). Not validated: run parseCanvasFile on the result before
 * sending. `links` is derived here, never read back into the windows. The sketch nodes follow the windows in
 * `windows`, and the connectors go in `edges`.
 */
export function toCanvasFile(
  state: { viewport: CanvasViewport; windows: CanvasWindow[]; sketchNodes?: SketchNode[]; edges?: SketchEdge[] },
  meta: CanvasMeta,
): CanvasDoc {
  return {
    version: 2,
    name: meta.name,
    profile: meta.profile,
    warehouse_id: meta.warehouseId,
    viewport: { x: state.viewport.x, y: state.viewport.y, zoom: state.viewport.zoom },
    windows: [...state.windows.map(toFileWindow), ...(state.sketchNodes ?? []).map(toFileSketchNode)],
    links: deriveLinks(state.windows),
    edges: (state.edges ?? []).map(toFileEdge),
  }
}

/** Validated file to the store fields it restores: the windows, the sketch nodes and the connectors. */
export function fromCanvasFile(file: CanvasFile): {
  canvasName: string
  viewport: CanvasViewport
  windows: CanvasWindow[]
  sketchNodes: SketchNode[]
  edges: SketchEdge[]
} {
  const windows: CanvasWindow[] = []
  const sketchNodes: SketchNode[] = []
  for (const w of file.windows) {
    if (isSketchType(w.type)) {
      sketchNodes.push(toFileSketchNode({ ...(w as unknown as SketchNode) }))
    } else {
      windows.push({ ...(w as unknown as CanvasWindow) })
    }
  }
  return {
    canvasName: file.name,
    viewport: file.viewport ?? { x: 0, y: 0, zoom: 1 },
    windows,
    sketchNodes,
    edges: (file.edges ?? []).map((e) => toFileEdge(e as SketchEdge)),
  }
}
