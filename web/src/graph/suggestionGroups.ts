// Rows of the Suggestions list: single column pairs, and composite keys (several pairs joined in one condition)
// shown as one row. Pure: no React, no fetch.
import type { Evidence, Relationship } from '../api/types'

/** A composite key the server recorded on a pair: every column pair joined together, and the runs that did so. */
interface Together {
  columns: [string, string][]
  runs: number
}

/** `evidence.together` is newer than the shared API types, so it is read through this. */
const togetherOf = (e: Relationship): Together[] =>
  (e.evidence as (Evidence & { together?: Together[] }) | null)?.together ?? []

export interface SuggestionRow {
  /** Stable key for selection: the edge id for a single pair, or the composite's table pair and columns. */
  key: string
  /** Ids to review when the row is accepted or rejected: every edge of the row that is in the list. */
  ids: string[]
  edges: Relationship[]
  composite: boolean
  source: string
  target: string
  /** The (source column, target column) pairs of the row: one for a single pair, all of them for a composite. */
  columns: [string, string][]
  runs: number
  users: number
  lastSeen: string
}

const pairOf = (e: Relationship): string => `${e.source.column ?? ''}\t${e.target.column ?? ''}`

/**
 * Rows for a list of stored column edges (most evidence first): a composite row for each set of column pairs
 * that were joined together, and a row of its own for each pair that also appeared alone (more runs than the
 * composites it is in account for, or no composites). Rows are ordered by runs, most first.
 */
export function groupSuggestions(edges: readonly Relationship[]): SuggestionRow[] {
  const found: { row: SuggestionRow; at: number }[] = []
  const composites = new Map<string, { row: SuggestionRow; at: number }>()

  edges.forEach((e, at) => {
    const together = togetherOf(e)
    const accounted = together.reduce((sum, t) => sum + t.runs, 0)
    if (together.length === 0 || (e.evidence?.runs ?? 0) > accounted) {
      found.push({
        at,
        row: {
          key: e.id,
          ids: [e.id],
          edges: [e],
          composite: false,
          source: e.source.table,
          target: e.target.table,
          columns: [[e.source.column ?? '', e.target.column ?? '']],
          runs: e.evidence?.runs ?? 0,
          users: e.evidence?.users ?? 0,
          lastSeen: e.evidence?.last_seen ?? '',
        },
      })
    }
    for (const t of together) {
      if (!t.columns.some((c) => c.join('\t') === pairOf(e))) continue
      const key = `${e.source.table}\t${e.target.table}\t${t.columns.map((c) => c.join('\t')).join('\n')}`
      let group = composites.get(key)
      if (!group) {
        const row: SuggestionRow = {
          key,
          ids: [],
          edges: [],
          composite: true,
          source: e.source.table,
          target: e.target.table,
          columns: t.columns,
          runs: t.runs,
          users: 0,
          lastSeen: '',
        }
        group = { row, at }
        composites.set(key, group)
      }
      const row = group.row
      row.ids.push(e.id)
      row.edges.push(e)
      row.users = Math.max(row.users, e.evidence?.users ?? 0)
      row.lastSeen = (e.evidence?.last_seen ?? '') > row.lastSeen ? (e.evidence?.last_seen ?? '') : row.lastSeen
    }
  })

  return [...found, ...composites.values()].sort((a, b) => b.row.runs - a.row.runs || a.at - b.at).map((x) => x.row)
}

/** The views that join on every column pair of a row (a composite key's pairs must all be joined by the same view). */
export function viewsOfRow(row: SuggestionRow, views: Record<string, string[]> | undefined): string[] {
  const each = row.edges.map((e) => views?.[e.id] ?? [])
  return each.length === 0 ? [] : each[0].filter((v) => each.every((list) => list.includes(v)))
}
