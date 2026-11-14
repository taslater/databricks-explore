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

/** The handle pair for an edge between two columns: facing each other, by which node is further right. */
export function columnHandles(
  sourceX: number,
  targetX: number,
  selfLoop: boolean,
  sourceColumn: string,
  targetColumn: string,
): { sourceHandle: string; targetHandle: string } {
  if (selfLoop) return { sourceHandle: columnHandleId('s', 'r', sourceColumn), targetHandle: columnHandleId('t', 'r', targetColumn) }
  return targetX >= sourceX
    ? { sourceHandle: columnHandleId('s', 'r', sourceColumn), targetHandle: columnHandleId('t', 'l', targetColumn) }
    : { sourceHandle: columnHandleId('s', 'l', sourceColumn), targetHandle: columnHandleId('t', 'r', targetColumn) }
}

/** A short label for a column pair, e.g. `orders.customer_id`. */
export const columnLabel = (table: string, column: string): string => `${table.split('.').pop() ?? table}.${column}`
