// Profiling a relationship, the parts that need no React: which edges can be profiled, and how the orphan tick sits on its edge.
import { Position } from '@xyflow/react'
import type { Cardinality, RelationshipProfile } from '../api/types'
import type { ProfileEdge } from '../api/relProfile'
import { endCandidates, rotationFor } from './EdgeEnds'
import { lastPart } from './format'
import type { FlowEdge } from './types'

/** Relationships one request profiles at most (the server's limit). */
export const MAX_PROFILE_EDGES = 10

/** The edges a profile can be asked for: table-level reference edges. With `ticked`, only those between two ticked tables. */
export function profilableEdges(edges: ReadonlyArray<FlowEdge>, ticked?: ReadonlySet<string>): ProfileEdge[] {
  const all = endCandidates(edges)
  const some = ticked && ticked.size > 0 ? all.filter((e) => ticked.has(e.source) && ticked.has(e.target)) : all
  return some.filter((e) => e.source.toLowerCase() !== e.target.toLowerCase())
}

/** `1.2%`, or `<0.1%` for a share too small to show (the same as the server's wording). */
export function percent(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return '0%'
  const p = (100 * part) / whole
  return p < 0.1 ? '<0.1%' : p < 10 ? `${p.toFixed(1)}%` : `${Math.round(p)}%`
}

/** "1.2% of orders (3,410 rows, 212 keys) have no match in customers", or null when nothing is orphaned. */
export function orphanText(p: RelationshipProfile | undefined): string | null {
  if (!p || p.orphan_rows <= 0) return null
  return `${percent(p.orphan_rows, p.a_rows)} of ${lastPart(p.source)} (${p.orphan_rows.toLocaleString('en-US')} rows, ${p.orphan_keys.toLocaleString('en-US')} keys) have no match in ${lastPart(p.target)}`
}

/** Whether a relationship's measurement found orphans: the only thing the graph marks beyond the ends. */
export const hasOrphans = (c: Cardinality | null | undefined): boolean => !!c?.profile && c.profile.orphan_rows > 0

/** Whether any edge on screen has orphans, for the legend. */
export const anyOrphans = (ends: Record<string, Cardinality | null> | undefined): boolean => !!ends && Object.values(ends).some(hasOrphans)

/** How far along the line from the referenced table the tick sits, past the crow's-foot glyph, and its half length. */
export const TICK_AT = 24
export const TICK_HALF = 6

/** Where the tick goes: its centre, and the turn that makes its +x run away from the node on `side`. */
export function tickPlace(x: number, y: number, side: Position): { x: number; y: number; rotate: number } {
  return { x, y, rotate: rotationFor(side) }
}
