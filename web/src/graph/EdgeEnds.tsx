// Crow's-foot ends on reference edges: a glyph at each table, read from keys and nullability (cardinality.py).
// An end is drawn only when it is known: a plain end means "unknown", never "one".
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Position } from '@xyflow/react'
import { useMemo } from 'react'
import { getCardinality } from '../api/client'
import type { Cardinality, CardinalityEndKind, GraphEdge } from '../api/types'
import { useUiStore } from '../store/uiStore'
import { useGraphStore } from './graphStore'
import type { FlowEdge } from './types'

/** The kinds whose edges have ends: the reference family, between two tables. */
const END_KINDS = ['fk', 'join_mined', 'manual']

export const END_NAME: Record<CardinalityEndKind, string> = {
  one: 'exactly one',
  zero_one: 'zero or one',
  one_many: 'one or more',
  zero_many: 'zero or more',
}

/** One mark of a glyph, drawn with the line running along +x from the table's border. */
export type Mark = { bar: number } | { foot: number } | { ring: number }

const FOOT = 12
const RING = 3.5

/** The marks of an end, from the table outward. */
export function marksOf(end: CardinalityEndKind): Mark[] {
  switch (end) {
    case 'one':
      return [{ bar: 5 }, { bar: 9 }]
    case 'zero_one':
      return [{ bar: 5 }, { ring: 11.5 }]
    case 'one_many':
      return [{ foot: FOOT }, { bar: FOOT + 4 }]
    case 'zero_many':
      return [{ foot: FOOT }, { ring: FOOT + 5.5 }]
  }
}

/** Degrees to turn a glyph so its +x runs away from the node on this side. */
export const rotationFor = (side: Position): number =>
  side === Position.Left ? 180 : side === Position.Bottom ? 90 : side === Position.Top ? -90 : 0

/** One end of an edge, at (x, y) on the border of a node on `side`. */
export function EdgeEnd({ x, y, side, end, stroke, width, opacity = 1 }: { x: number; y: number; side: Position; end: CardinalityEndKind; stroke: string; width: number; opacity?: number }) {
  return (
    <g transform={`translate(${x} ${y}) rotate(${rotationFor(side)})`} stroke={stroke} strokeWidth={width} fill="none" opacity={opacity} data-end={end}>
      {marksOf(end).map((m, i) =>
        'bar' in m ? (
          <line key={i} x1={m.bar} y1={-5} x2={m.bar} y2={5} />
        ) : 'foot' in m ? (
          <path key={i} d={`M0 -6 L${m.foot} 0 L0 6`} />
        ) : (
          <circle key={i} cx={m.ring} cy={0} r={RING} fill="#fff" />
        ),
      )}
    </g>
  )
}

/** The reference edges that can have ends, as the server wants them: table edges and the column edges that refine them (a foreign key's column pair). Placeholders have none. */
export function endCandidates(edges: ReadonlyArray<FlowEdge>): Array<{ id: string; kind: string; source: string; target: string; source_column?: string; target_column?: string }> {
  const out: Array<{ id: string; kind: string; source: string; target: string; source_column?: string; target_column?: string }> = []
  for (const e of edges) {
    const i = e.data!.info
    if (!END_KINDS.includes(i.kind) || i.source.startsWith('ph:') || i.target.startsWith('ph:')) continue
    out.push({ id: i.id, kind: i.kind, source: i.source, target: i.target, ...(i.source_column && i.target_column && { source_column: i.source_column, target_column: i.target_column }) })
  }
  return out.slice(0, 400)
}

/** The ends of the reference edges on the graph, read from the server's cache of table metadata. Silent when they cannot be read. */
export function useCardinality() {
  const profile = useUiStore((s) => s.connectedProfile)
  const edges = useGraphStore((s) => s.edges)
  const columnEdges = useGraphStore((s) => s.columnEdges)
  const wanted = useMemo(() => endCandidates([...edges, ...columnEdges]), [edges, columnEdges])
  const key = wanted.map((e) => `${e.id}|${e.source}|${e.target}`).sort()
  return useQuery({
    queryKey: ['cardinality', profile, key],
    queryFn: () => getCardinality(wanted),
    enabled: profile !== null && wanted.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  })
}

/** The same edges, each reference edge with its ends in `data.cardinality` (the server's answer, else what an agent saved). */
export function withCardinality(edges: FlowEdge[], ends: Record<string, Cardinality | null> | undefined): FlowEdge[] {
  return edges.map((e) => {
    const c = ends?.[e.data!.info.id] ?? e.data!.info.cardinality
    return c ? { ...e, data: { ...e.data!, cardinality: c } } : e
  })
}

/** Details of a reference edge: how many rows match on each side, and why that is known. Nothing when no end is. */
export function EdgeCardinality({ info }: { info: GraphEdge }) {
  const known = useCardinality().data?.[info.id] ?? info.cardinality
  if (!known?.sentence) return null
  return (
    <div className="edge-ends">
      <h4>Rows</h4>
      <p>{known.sentence}</p>
    </div>
  )
}

/** Whether the legend should explain the ends: some edge on screen has one. */
export function hasEnds(ends: Record<string, Cardinality | null> | undefined): boolean {
  return !!ends && Object.values(ends).some((c) => c && (c.source || c.target))
}
