// Pure helpers between /api/relationships and what the graph draws. No React, no fetch.
import type { GraphEdge, Relationship, RelationshipsResponse, RelationsResponse } from '../api/types'
import { isDerivedKind } from './edgeStyles'
import { parseTs } from './format'

function laterOf(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b
  if (!b) return a
  return parseTs(b) > parseTs(a) ? b : a
}

/** One server edge as a graph edge, with the legacy fields (`child_columns`, `last_seen`, ...) filled in. */
function adapt(r: Relationship): GraphEdge {
  const info: GraphEdge = {
    id: r.id,
    source: r.source.table,
    target: r.target.table,
    kind: r.kind,
    directed: r.directed,
    status: r.status,
    note: r.note,
    provenance: r.provenance,
    // A derived note lives on the table-level edge itself. A stored edge is patched through its members.
    patch_ids: isDerivedKind(r.kind) ? [r.id] : r.members?.length ? r.members : [r.id],
  }
  if (r.evidence) info.evidence = r.evidence
  if (r.evidence?.last_seen) info.last_seen = r.evidence.last_seen
  if (r.kind === 'fk') {
    const pairs = r.columns ?? []
    info.constraint = r.provenance.source_ref ?? undefined
    info.child_columns = pairs.map((c) => c.source).filter((c): c is string => !!c)
    info.parent_columns = pairs.map((c) => c.target).filter((c): c is string => !!c)
    info.label = info.child_columns.join(', ')
  }
  return info
}

/**
 * Turns server edges (table level) into graph edges.
 * Lineage seen in both directions arrives as two directed edges. They become one `bidir` edge with
 * the legacy id `lineage:<a><-><b>` (names sorted), so saved diagrams and re-expansion agree on ids.
 */
// Python twin: graphs.graph_edges (tests/test_parity.py and web/src/parity.test.ts run both on the same cases).
export function toGraphEdges(rels: Relationship[]): GraphEdge[] {
  const out: GraphEdge[] = []
  const lineage = new Map<string, GraphEdge>()
  for (const r of rels) {
    const info = adapt(r)
    if (r.kind !== 'lineage') {
      out.push(info)
      continue
    }
    const pair = [info.source, info.target].sort().join('<->')
    const direction = `${info.source}->${info.target}`
    const merged = lineage.get(pair)
    if (!merged) {
      info.id = `lineage:${pair}`
      info.bidir = false
      info.last_seen_by_dir = { [direction]: info.last_seen ?? '' }
      lineage.set(pair, info)
      out.push(info)
      continue
    }
    if (!(direction in (merged.last_seen_by_dir ?? {}))) merged.bidir = true
    merged.last_seen_by_dir = { ...merged.last_seen_by_dir, [direction]: info.last_seen ?? '' }
    merged.last_seen = laterOf(merged.last_seen, info.last_seen)
    merged.patch_ids = [...(merged.patch_ids ?? []), ...(info.patch_ids ?? [])]
    // Superseded only when every direction is.
    if (info.status !== 'superseded' && merged.status === 'superseded') merged.status = info.status
    merged.note = merged.note || info.note
  }
  return out
}

/**
 * Column-level edges from a `level=column` response: the ones with a column at both ends, each kept as its own
 * edge (lineage in two directions stays two edges). Table-level edges in the same response are left out.
 */
export function toColumnEdges(resp: RelationshipsResponse): GraphEdge[] {
  const out: GraphEdge[] = []
  for (const r of resp.edges) {
    if (!r.source.column || !r.target.column) continue
    const info = adapt(r)
    info.source_column = r.source.column
    info.target_column = r.target.column
    info.patch_ids = [r.id]
    out.push(info)
  }
  return out
}

/** The /api/relationships response in the shape the graph store merges. */
export function toRelations(resp: RelationshipsResponse): RelationsResponse {
  return { nodes: resp.nodes, edges: toGraphEdges(resp.edges), errors: resp.errors }
}

/**
 * The ids to send to PATCH /api/relationships/<id> for an edge on screen.
 * Edges from a diagram saved before the store existed have no `patch_ids`. They are all derived, and a
 * derived id is `kind:source->target`, with one id per direction for lineage.
 */
export function patchIds(info: GraphEdge): string[] {
  if (info.patch_ids?.length) return info.patch_ids
  if (info.kind !== 'lineage') return [info.id]
  const directions = Object.keys(info.last_seen_by_dir ?? {})
  const pairs: Array<[string, string]> = directions.length
    ? directions.map((d) => d.split('->') as [string, string])
    : info.bidir
      ? [
          [info.source, info.target],
          [info.target, info.source],
        ]
      : [[info.source, info.target]]
  return pairs.map(([s, t]) => `lineage:${s}->${t}`)
}

/** Stored edges (not derived from Unity Catalog) can be accepted or rejected. */
export const canReview = (info: GraphEdge): boolean => !isDerivedKind(info.kind)
