// Pure helpers for showing a node's columns and drawing edges between column handles. No React, no fetch.
import type { TableInfo } from '../api/types'

export interface ColumnInfo {
  name: string
  type: string
  /** Part of the primary key, or of a foreign key (read from the table's constraints). Set only when true. */
  pk?: boolean
  fk?: boolean
}

/** How many columns a node lists: none, the keys and connected ones, or all. A node's button cycles them. */
export type ColumnLevel = 'none' | 'keys' | 'all'

/** The level a node is at. `showColumns` is the node being open at all, `allColumns` the step past keys. */
export function columnLevel(d: { showColumns?: boolean; allColumns?: boolean }): ColumnLevel {
  return !d.showColumns ? 'none' : d.allColumns ? 'all' : 'keys'
}

/** The level after this one: none, keys, all, then none again. */
export const nextLevel = (level: ColumnLevel): ColumnLevel => (level === 'none' ? 'keys' : level === 'keys' ? 'all' : 'none')

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const record = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

/** The lowercased primary key columns and foreign key columns declared in a table's constraints. */
export function keyColumns(constraints: readonly unknown[] | undefined): { pk: Set<string>; fk: Set<string> } {
  const pk = new Set<string>()
  const fk = new Set<string>()
  for (const c of constraints ?? []) {
    const con = record(c)
    for (const n of strings(record(con?.primary_key_constraint)?.child_columns)) pk.add(n.toLowerCase())
    for (const n of strings(record(con?.foreign_key_constraint)?.child_columns)) fk.add(n.toLowerCase())
  }
  return { pk, fk }
}

/** A type in a row: its base, so `struct<a:int,b:string>` reads `struct<…>` and `decimal(10,2)` stays as it is. */
export const baseType = (type: string): string => type.replace(/<[\s\S]*$/, '<…>')

/** The columns of a `tables.get` payload, in table order. Entries without a name are dropped. */
export function columnsOf(info: TableInfo): ColumnInfo[] {
  const out: ColumnInfo[] = []
  const { pk, fk } = keyColumns(info.table_constraints)
  for (const c of info.columns ?? []) {
    if (typeof c.name !== 'string' || !c.name) continue
    const text = c.type_text ?? c.type_name
    const lower = c.name.toLowerCase()
    out.push({ name: c.name, type: typeof text === 'string' ? text : '', ...(pk.has(lower) && { pk: true }), ...(fk.has(lower) && { fk: true }) })
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
 * The columns a node draws. At the keys level a column earns its row by being a key (primary or foreign) or by having
 * a visible column edge (`involved`), in table order; `all` draws every column. The rest are the `+N more` row.
 */
export function visibleColumns(
  columns: readonly ColumnInfo[],
  involved: Iterable<string>,
  all: boolean,
): ColumnInfo[] {
  if (all) return [...columns]
  const wanted = new Set([...involved].map((n) => n.toLowerCase()))
  return columns.filter((c) => c.pk || c.fk || wanted.has(c.name.toLowerCase()))
}

/** The rows a node draws now: none while its columns are off or not yet loaded. */
export function rowsOf(d: { columns?: ColumnInfo[]; showColumns?: boolean; allColumns?: boolean; involved?: string[] }): ColumnInfo[] {
  return d.showColumns && d.columns ? visibleColumns(d.columns, d.involved ?? [], !!d.allColumns) : []
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
