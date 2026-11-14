// Table-shaped things on the canvas: the name a node has in the relationship store, the difference
// between a placeholder and the real table it is linked to, and the payload for saving a connector as a
// `sketch` edge. Pure. No React, store or fetch imports.
import type { Endpoint, RelationshipsExport } from '../api/types'
import type { PlaceholderColumn, PlaceholderSpec, SketchEdge } from './types'

/** What the relationship store calls a placeholder that is not linked. */
export function placeholderTableName(spec: PlaceholderSpec): string {
  return `ph:${spec.id}`
}

/** Anything with a table behind it: a table card (`table`), or a placeholder, named by its link if it has one. */
export interface TableLike {
  type: string
  table?: string
  placeholder?: PlaceholderSpec
}

/** The table name this node has in the relationship store, or null when it is not a table. */
export function storeTableName(node: TableLike): string | null {
  if (node.type === 'table' && node.table) return node.table
  if (node.type === 'placeholder' && node.placeholder) {
    return node.placeholder.linked || placeholderTableName(node.placeholder)
  }
  return null
}

/** The column names a node offers for a column-level edge, from the sketch (placeholder) or the real table. */
export function sketchColumnNames(node: TableLike): string[] {
  if (node.type !== 'placeholder' || !node.placeholder) return []
  return node.placeholder.columns.map((c) => c.name.trim()).filter((n) => n !== '')
}

export type ColumnStatus = 'same' | 'new' | 'type' | 'existing'

export interface ColumnRow {
  name: string
  /** The type typed in the sketch, or null for a column only the real table has. */
  sketchType: string | null
  /** The real table's type, or null when the real table has no such column. */
  realType: string | null
  key?: PlaceholderColumn['key']
  /**
   * same: both have it with the same type. new: only the sketch has it. type: both have it and the types
   * differ. existing: only the real table has it.
   */
  status: ColumnStatus
}

export interface RealColumn {
  name: string
  type: string
}

function normType(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, '')
}

/**
 * Lines the sketch's columns up with the real table's. Sketch columns come first, in their order, then the
 * real columns the sketch does not have. Names match without regard to case, like Unity Catalog's.
 * A sketch column with no type typed never counts as a type difference.
 */
export function diffColumns(sketch: PlaceholderColumn[], real: RealColumn[]): ColumnRow[] {
  const realByName = new Map(real.map((c) => [c.name.toLowerCase(), c]))
  const seen = new Set<string>()
  const rows: ColumnRow[] = []
  for (const c of sketch) {
    const name = c.name.trim()
    if (name === '') continue
    const match = realByName.get(name.toLowerCase())
    seen.add(name.toLowerCase())
    let status: ColumnStatus
    if (!match) status = 'new'
    else if (c.type.trim() !== '' && normType(c.type) !== normType(match.type)) status = 'type'
    else status = 'same'
    rows.push({ name, sketchType: c.type, realType: match ? match.type : null, key: c.key, status })
  }
  for (const r of real) {
    if (!seen.has(r.name.toLowerCase())) rows.push({ name: r.name, sketchType: null, realType: r.type, status: 'existing' })
  }
  return rows
}

export interface DiffSummary {
  new: number
  type: number
  existing: number
  same: number
}

export function summarize(rows: ColumnRow[]): DiffSummary {
  const out: DiffSummary = { new: 0, type: 0, existing: 0, same: 0 }
  for (const r of rows) out[r.status]++
  return out
}

/**
 * Direction of a connector for the relationship store. An arrowhead at the end only (or at both ends, or at
 * neither) is a directed edge from the source, undirected when it has no head or two. An arrowhead at the start
 * only points the other way, so the ends swap.
 */
export function storeDirection(e: Pick<SketchEdge, 'arrow_start' | 'arrow_end'>): { swap: boolean; directed: boolean } {
  if (e.arrow_end && !e.arrow_start) return { swap: false, directed: true }
  if (e.arrow_start && !e.arrow_end) return { swap: true, directed: true }
  return { swap: false, directed: false }
}

export interface SketchEdgeInput {
  edge: SketchEdge
  sourceTable: string
  targetTable: string
  /** Name of the canvas, kept in the edge's provenance. */
  canvasName: string | null
  id: string
  now?: string
}

/** The import file that saves one connector as a `sketch` edge. The label becomes the edge's note. */
export function sketchImportFile(input: SketchEdgeInput): RelationshipsExport {
  const { edge, sourceTable, targetTable } = input
  const { swap, directed } = storeDirection(edge)
  const a: Endpoint = { table: sourceTable }
  const b: Endpoint = { table: targetTable }
  const ca = edge.relationship?.source_column
  const cb = edge.relationship?.target_column
  if (ca) a.column = ca
  if (cb) b.column = cb
  const [source, target] = swap ? [b, a] : [a, b]
  return {
    version: 1,
    edges: [
      {
        id: input.id,
        kind: 'sketch',
        source,
        target,
        directed,
        provenance: { origin: 'sketch', source_ref: input.canvasName, fetched_at: input.now ?? new Date().toISOString() },
        evidence: null,
        status: 'accepted',
        note: edge.label ?? '',
        created_at: input.now ?? new Date().toISOString(),
        updated_at: input.now ?? new Date().toISOString(),
      },
    ],
    overlays: [],
  }
}

/** A fresh id for a stored edge: `e_` and 32 hex digits, the form the store uses. */
export function newStoredEdgeId(): string {
  return 'e_' + crypto.randomUUID().replace(/-/g, '')
}
