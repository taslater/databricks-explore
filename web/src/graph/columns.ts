// Pure helpers for showing a node's columns and drawing edges between column handles. No React, no fetch.
import type { TableInfo } from '../api/types'

export interface ColumnInfo {
  name: string
  type: string
}

/** A wide table shows this many columns at most, unless the user asks for all. Columns with an edge always show. */
export const COLUMN_LIMIT = 12

/** The columns of a `tables.get` payload, in table order. Entries without a name are dropped. */
export function columnsOf(info: TableInfo): ColumnInfo[] {
  const out: ColumnInfo[] = []
  for (const c of info.columns ?? []) {
    if (typeof c.name !== 'string' || !c.name) continue
    const text = c.type_text ?? c.type_name
    out.push({ name: c.name, type: typeof text === 'string' ? text : '' })
  }
  return out
}

/** Column lookup that ignores case: mined joins are lowercase, Unity Catalog may not be. */
export function findColumn(columns: readonly ColumnInfo[], name: string | undefined): ColumnInfo | undefined {
  if (!name) return undefined
  const lower = name.toLowerCase()
  return columns.find((c) => c.name.toLowerCase() === lower)
}

/**
 * The columns a node draws. A table of up to COLUMN_LIMIT columns shows all of them. A wider one shows the
 * columns that have an edge (`involved`) and then the first others, up to the limit, in table order.
 */
export function visibleColumns(
  columns: readonly ColumnInfo[],
  involved: Iterable<string>,
  all: boolean,
): ColumnInfo[] {
  if (all || columns.length <= COLUMN_LIMIT) return [...columns]
  const wanted = new Set([...involved].map((n) => n.toLowerCase()))
  const picked = columns.filter((c) => wanted.has(c.name.toLowerCase()))
  const room = Math.max(0, COLUMN_LIMIT - picked.length)
  const extra = new Set(columns.filter((c) => !wanted.has(c.name.toLowerCase())).slice(0, room))
  return columns.filter((c) => wanted.has(c.name.toLowerCase()) || extra.has(c))
}

export type HandleRole = 's' | 't'
export type HandleSide = 'l' | 'r'

/** Id of one handle on a column row. Each row has a source and a target handle on each side. */
export const columnHandleId = (role: HandleRole, side: HandleSide, column: string): string => `${role}-${side}:${column}`

/** The horizontal extent of a node: where its left edge is and how wide it is. Only this decides which side an edge uses. */
export interface Span {
  x: number
  width: number
}

/**
 * Which side of each node a column edge uses. Side by side (a gap between them), the edge leaves the facing sides, so
 * it runs straight across. Stacked (their horizontal extents overlap, nothing to face), both ends use the same side:
 * the edge leaves, bends once outside the nodes and comes back in, instead of crossing over to the far side of the
 * target and curling back. That side is the right one unless the target sits further left.
 */
export function columnSides(source: Span, target: Span, selfLoop: boolean): { source: HandleSide; target: HandleSide } {
  if (selfLoop) return { source: 'r', target: 'r' }
  if (target.x >= source.x + source.width) return { source: 'r', target: 'l' }
  if (target.x + target.width <= source.x) return { source: 'l', target: 'r' }
  const both: HandleSide = target.x + target.width / 2 >= source.x + source.width / 2 ? 'r' : 'l'
  return { source: both, target: both }
}

/** The handle pair for an edge between two columns (see columnSides). */
export function columnHandles(
  source: Span,
  target: Span,
  selfLoop: boolean,
  sourceColumn: string,
  targetColumn: string,
): { sourceHandle: string; targetHandle: string } {
  const side = columnSides(source, target, selfLoop)
  return {
    sourceHandle: columnHandleId('s', side.source, sourceColumn),
    targetHandle: columnHandleId('t', side.target, targetColumn),
  }
}

/** A short label for a column pair, e.g. `orders.customer_id`. */
export const columnLabel = (table: string, column: string): string => `${table.split('.').pop() ?? table}.${column}`

/**
 * The nodes that appeared since `before` and should show their columns because Show columns is on: table nodes,
 * not placeholders. Nodes already on the graph keep whatever they were set to.
 */
export function newTableIds(columnsOn: boolean, before: readonly string[], nodes: ReadonlyArray<{ id: string }>): string[] {
  if (!columnsOn) return []
  const had = new Set(before)
  return nodes.map((n) => n.id).filter((id) => !had.has(id) && !id.startsWith('ph:'))
}
