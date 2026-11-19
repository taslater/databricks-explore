// Pure helpers for the card facts (grain line, size badge, late dot): the size badge, the grain change on a flow edge, and what gets overlaid on nodes and edges.
import type { FactsByTable, Grain, TableStats } from '../api/nodeFacts'
import type { FlowEdge, FlowNode } from './types'

const trim = (n: number) => (n >= 10 || Number.isInteger(n) ? String(Math.round(n)) : n.toFixed(1))

/** Rows as a short count: 950, 12K, 1.9M, 12M, 1.2B. */
export function shortCount(n: number): string {
  if (n < 1000) return String(n)
  const units: Array<[number, string]> = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ]
  for (const [size, suffix] of units) if (n >= size) return trim(n / size) + suffix
  return String(n)
}

/** Bytes as 3.1 GB, 480 MB, 12 KB. */
export function shortBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${trim(v)} ${units[i]}`
}

/** The badge at the end of a card's name row: rows when known, else size, else nothing. */
export function sizeBadge(stats: TableStats | null | undefined): string | null {
  if (!stats) return null
  if (stats.rows !== null) return shortCount(stats.rows)
  return stats.bytes !== null ? shortBytes(stats.bytes) : null
}

/** "2 h", "3 d", "45 min": a span of seconds, rounded down to its largest unit. */
export function spanLabel(seconds: number): string {
  const m = Math.floor(seconds / 60)
  if (m < 60) return `${Math.max(m, 1)} min`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`
}

/** "3 h ago", "12 min ago": how long before now an ISO time was. */
export const ago = (iso: string | null | undefined, now: number = Date.now()): string =>
  iso && !Number.isNaN(Date.parse(iso)) ? `${spanLabel(Math.max(0, (now - Date.parse(iso)) / 1000))} ago` : 'unknown'

const sameKeys = (a: Grain, b: Grain): boolean =>
  a.columns.length > 0 && b.columns.length > 0
    ? a.columns.length === b.columns.length && a.columns.every((c) => b.columns.some((d) => d.toLowerCase() === c.toLowerCase()))
    : a.label === b.label

/** `per order_id × line_no → per customer_id × order_date` when a GROUP BY target has a different grain than its source, else null. */
export function grainChange(source: Grain | null | undefined, target: Grain | null | undefined): string | null {
  if (!source || !target || target.basis !== 'group_by' || sameKeys(source, target)) return null
  return `${source.label} → ${target.label}`
}

/** The same nodes, each with its grain and size facts in `data.facts`. Nodes with none come back untouched. */
export function withNodeFacts(nodes: FlowNode[], facts: FactsByTable | undefined): FlowNode[] {
  if (!facts) return nodes
  return nodes.map((n) => (facts[n.id] ? { ...n, data: { ...n.data, facts: facts[n.id] } } : n))
}

/** Flow edges (view dependencies and lineage) whose target is a GROUP BY of a different grain carry `data.grainChange`, which draws the Σ. */
export function withGrainChanges(edges: FlowEdge[], facts: FactsByTable | undefined): FlowEdge[] {
  if (!facts) return edges
  return edges.map((e) => {
    const info = e.data?.info
    if (!info || (info.kind !== 'view_dep' && info.kind !== 'lineage') || info.directed === false || info.bidir || e.data?.superseded) return e
    const change = grainChange(facts[e.source]?.grain, facts[e.target]?.grain)
    return change ? { ...e, data: { ...e.data!, grainChange: change } } : e
  })
}
