// What a flow edge does with its source, as the Graph draws and words it. The server reads the SQL (transforms.py).
import { Position } from '@xyflow/react'
import type { EdgeTransform, TransformCandidate, TransformGlyph, TransformsAnswer } from '../api/edgeTransforms'
import type { FlowEdge } from './types'

/** Pixels from the target's border to the first glyph, and between glyphs. */
const FIRST = 30
const STEP = 22

/** The flow edges that can have a transform: a table to a table, one direction, no column level, no placeholder. */
export function transformCandidates(edges: ReadonlyArray<FlowEdge>): TransformCandidate[] {
  const out: TransformCandidate[] = []
  for (const e of edges) {
    const i = e.data!.info
    if ((i.kind !== 'view_dep' && i.kind !== 'lineage') || i.source_column || i.directed === false || i.bidir) continue
    if (i.source.startsWith('ph:') || i.target.startsWith('ph:') || e.data?.superseded) continue
    out.push({ id: i.id, source: i.source, target: i.target })
  }
  return out.slice(0, 400)
}

/** The same edges, each flow edge with its transform in `data.transform` when the server read one. */
export function withTransforms(edges: FlowEdge[], answer: TransformsAnswer | undefined): FlowEdge[] {
  if (!answer) return edges
  return edges.map((e) => {
    const t = answer.edges[e.data!.info.id]?.transform
    return t ? { ...e, data: { ...e.data!, transform: t } } : e
  })
}

/** Where the n-th glyph sits: along the edge, out from the target's border on `side`. */
export function glyphSpot(x: number, y: number, side: Position, n: number): { x: number; y: number } {
  const d = FIRST + n * STEP
  return side === Position.Left ? { x: x - d, y } : side === Position.Right ? { x: x + d, y } : side === Position.Top ? { x, y: y - d } : { x, y: y + d }
}

const JOIN_WORD: Record<string, string> = { inner: 'Joined', left: 'Left-joined', right: 'Right-joined', full: 'Full-joined', cross: 'Cross-joined' }

/** "customer_id = orders.customer_id" for each key of a join. */
export function joinKeyText(joined: NonNullable<EdgeTransform['joined']>): string {
  return joined.keys.map((k) => (k.other ? `${k.column} = ${k.other.split('.').slice(-2).join('.')}` : k.column)).join(', ')
}

/** The tooltip of one glyph. */
export function glyphTitle(g: TransformGlyph, t: EdgeTransform): string {
  switch (g) {
    case 'aggregate': {
      const a = t.aggregate
      return a ? `Aggregates${a.keys.length ? `: groups by ${a.keys.join(', ')}` : ' the whole table'}${a.functions.length ? ` (${a.functions.join(', ')})` : ''}` : 'Aggregates'
    }
    case 'join':
      return t.joined ? `${JOIN_WORD[t.joined.type] ?? 'Joined'} in${t.joined.keys.length ? ` on ${joinKeyText(t.joined)}` : ''}` : 'Joined in'
    case 'union':
      return `One of ${t.union?.branches ?? 'several'} unioned queries`
    case 'dedupe':
      return t.dedupe ? `Keeps one row per ${t.dedupe.keys.join(', ')}` : 'Distinct rows only'
    case 'filter': {
      const n = t.filters.length
      return n === 1 ? `Filtered: ${t.filters[0].sql}` : `Filtered by ${n} conditions`
    }
  }
}

/** The short words for a filter's kind. */
export const FILTER_KIND: Record<EdgeTransform['filters'][number]['kind'], string> = {
  where: 'WHERE',
  qualify: 'QUALIFY',
  semi: 'keeps only rows that match',
  anti: 'drops rows that match',
}

/** What the transform says about this source in one phrase each, for Details. Empty when the source is read as it is. */
export function howLines(t: EdgeTransform): string[] {
  const lines: string[] = []
  if (t.driving && !t.joined) lines.push('The table the query reads from (FROM).')
  if (t.joined) lines.push(`${JOIN_WORD[t.joined.type] ?? 'Joined'} in${t.joined.keys.length ? ` on ${joinKeyText(t.joined)}` : ''}.`)
  if (t.union) lines.push(`One of ${t.union.branches} queries joined by UNION.`)
  if (!t.driving && !t.joined && !t.union && t.filters.length) lines.push('Only decides which rows stay; none of its columns are in the result.')
  if (t.aggregate) {
    const a = t.aggregate
    lines.push(`Aggregated${a.keys.length ? `: GROUP BY ${a.keys.join(', ')}` : ' as a whole'}${a.functions.length ? ` (${a.functions.join(', ')})` : ''}.`)
    if (a.having) lines.push(`HAVING ${a.having}`)
  }
  if (t.dedupe) lines.push(`Keeps one row per ${t.dedupe.keys.join(', ')} (row_number() = 1).`)
  else if (t.distinct) lines.push('SELECT DISTINCT: duplicate rows are dropped.')
  if (t.window) lines.push('Window functions are computed over it.')
  if (t.pivot) lines.push('Pivoted.')
  if (t.merge) lines.push(`Merged into the target: ${t.merge.actions.join(', ') || 'no action'}${t.merge.keys.length ? ` on ${t.merge.keys.join(', ')}` : ''}.`)
  return lines
}

/** Whether the source passes through unchanged: read, with no join, filter, aggregate, dedupe or union. */
export const isPassThrough = (t: EdgeTransform): boolean =>
  !t.joined && !t.union && !t.aggregate && !t.dedupe && !t.distinct && !t.filters.length && !t.pivot && !t.merge
