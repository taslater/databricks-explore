// Pure logic for the read-only edges from TableCards to the query windows that read them.
// No React, fetch, or store imports, so tests can call it directly.
import type { CanvasWindow } from '../../api/types'

export interface TableEdge {
  id: string
  /** The table card (source). */
  from: string
  /** The query window that reads the table (target). */
  to: string
}

/**
 * Returns one edge per (table card, query window) pair where the window reads the card's table.
 *
 * `reads` maps a query window id to the table names the server reported for it. Matching is
 * case-insensitive, because Unity Catalog names are. Windows that are not queries, and table
 * cards with no `table`, are ignored. A card and a window appear in at most one edge.
 */
export function tableEdges(windows: CanvasWindow[], reads: Record<string, readonly string[]>): TableEdge[] {
  const cardsByTable = new Map<string, string[]>()
  for (const w of windows) {
    if (w.type !== 'table' || !w.table) continue
    const key = w.table.toLowerCase()
    const ids = cardsByTable.get(key) ?? []
    ids.push(w.id)
    cardsByTable.set(key, ids)
  }

  const out: TableEdge[] = []
  for (const w of windows) {
    if (w.type !== 'query') continue
    const names = reads[w.id]
    if (!names || names.length === 0) continue
    const seen = new Set<string>()
    for (const name of names) {
      for (const cardId of cardsByTable.get(name.toLowerCase()) ?? []) {
        if (seen.has(cardId)) continue
        seen.add(cardId)
        out.push({ id: `table:${cardId}>${w.id}`, from: cardId, to: w.id })
      }
    }
  }
  return out
}
