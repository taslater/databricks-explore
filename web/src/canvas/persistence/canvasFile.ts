// Canvas file format. The zod schema mirrors contracts/canvas.schema.json and the
// server's checks in canvases.py. The serializer turns store state into a file, and
// the loader turns a validated file back into store state. No React or fetch code here.
//
// Imports from the store are type-only so this module stays free of runtime
// side effects (it can be imported by plain scripts).
import { z } from 'zod'
import type { CanvasDoc, CanvasWindow } from '../../api/types'
import type { CanvasViewport } from '../../store/canvasStore'

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
const REQUIRED_FIELD = { query: 'sql', chart: 'chart', note: 'text', table: 'table' } as const

const windowSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['query', 'chart', 'note', 'table']),
    title: z
      .string()
      .min(1)
      .regex(/^[^{}]+$/, { error: 'must not contain { or }' }),
    position: pointSchema,
    size: sizeSchema,
    sql: z.string().optional(),
    chart: z.object({ vega_lite: z.record(z.string(), z.unknown()) }).optional(),
    text: z.string().optional(),
    table: z.string().min(1).optional(),
    collapsed: z.boolean().default(false),
    editor_split: z.number().gt(0).lt(100).optional(),
  })
  .superRefine((w, ctx) => {
    const field = REQUIRED_FIELD[w.type]
    if (w[field] === undefined) {
      ctx.addIssue({ code: 'custom', path: [field], message: `required when type is ${w.type}`, input: w })
    }
  })

export const canvasFileSchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).regex(CANVAS_NAME_PATTERN, {
      error: 'may use only letters, digits, _, ., and -',
    }),
    profile: z.string().min(1),
    warehouse_id: z.string().nullable().optional(),
    viewport: viewportSchema.optional(),
    windows: z.array(windowSchema),
    links: z
      .array(z.object({ from: z.string().min(1), to: z.string().min(1) }))
      .default([]),
  })
  .superRefine((doc, ctx) => {
    // JSON Schema cannot express these, so they are checked here (and on the server).
    const ids = new Set<string>()
    const titles = new Set<string>()
    doc.windows.forEach((w, i) => {
      if (ids.has(w.id)) {
        ctx.addIssue({ code: 'custom', path: ['windows', i, 'id'], message: `duplicate id "${w.id}"`, input: w })
      }
      ids.add(w.id)
      if (titles.has(w.title)) {
        ctx.addIssue({
          code: 'custom',
          path: ['windows', i, 'title'],
          message: `duplicate title "${w.title}"`,
          input: w,
        })
      }
      titles.add(w.title)
    })
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
  profile: string
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
  return out
}

/**
 * Store state to the file shape. Not validated: run parseCanvasFile on the result before
 * sending. `links` is derived here, never read back into the windows.
 */
export function toCanvasFile(
  state: { viewport: CanvasViewport; windows: CanvasWindow[] },
  meta: CanvasMeta,
): CanvasDoc {
  return {
    version: 1,
    name: meta.name,
    profile: meta.profile,
    warehouse_id: meta.warehouseId,
    viewport: { x: state.viewport.x, y: state.viewport.y, zoom: state.viewport.zoom },
    windows: state.windows.map(toFileWindow),
    links: deriveLinks(state.windows),
  }
}

/** Validated file to the store fields it restores. The caller applies them with loadState. */
export function fromCanvasFile(file: CanvasFile): {
  canvasName: string
  viewport: CanvasViewport
  windows: CanvasWindow[]
} {
  return {
    canvasName: file.name,
    viewport: file.viewport ?? { x: 0, y: 0, zoom: 1 },
    windows: file.windows.map((w) => ({ ...w })),
  }
}
