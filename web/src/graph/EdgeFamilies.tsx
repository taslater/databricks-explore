// The Graph's edge controls: a checkbox per family (and per kind under More), the legend of what is on screen, and the
// "From" line of an edge's Details. The legend lists only the line styles that are drawn.
import { useMemo } from 'react'
import type { GraphEdgeKind } from '../api/types'
import { edgeShown, isSuperseded } from './derive'
import { edgeSource } from './edgeSource'
import {
  edgeStyle,
  FAMILIES,
  FAMILY_HINT,
  FAMILY_LABEL,
  isInferred,
  KIND_LABEL,
  KINDS_OF,
  familyOf,
  type EdgeFamily,
  type KindStyle,
} from './edgeStyles'
import { hasEnds, useCardinality } from './EdgeEnds'
import { isModified, LENS_LABEL, type Lens } from './lens'
import { anyOrphans } from './relProfile'
import { useGraphStore } from './graphStore'
import type { GraphEdge } from '../api/types'

/** A short sample of a line style, for the filters and the legend. */
function Swatch({ style, faded }: { style: KindStyle; faded?: boolean }) {
  return (
    <svg className="lg-line" width="34" height="8" aria-hidden="true" opacity={faded ? 0.45 : 1}>
      <line
        x1="1"
        y1="4"
        x2="33"
        y2="4"
        stroke={style.stroke}
        strokeWidth={style.strokeWidth ?? 1.6}
        strokeDasharray={style.strokeDasharray}
      />
    </svg>
  )
}

/** The families the panel lists up front for each lens; the rest are under More. */
export const PANEL_FAMILIES: Record<Lens, readonly EdgeFamily[]> = { all: FAMILIES, flow: ['flow'], model: ['reference'] }

/** One checkbox per family the lens is about, and the other families and the per-kind ones under More. */
export function EdgeFilterBoxes() {
  const filters = useGraphStore((s) => s.filters)
  const setFilter = useGraphStore((s) => s.setFilter)
  const lens = useGraphStore((s) => s.lens)
  const up = PANEL_FAMILIES[lens]
  const box = (key: EdgeFamily | GraphEdgeKind, label: string, style: KindStyle, title?: string) => (
    <label key={key} className="check kind-filter" title={title}>
      <input type="checkbox" checked={filters[key]} onChange={(e) => setFilter(key, e.target.checked)} />
      <Swatch style={style} />
      {label}
    </label>
  )
  return (
    <>
      <h4 className="panel-heading">
        Edges{lens === 'all' ? '' : ` · ${LENS_LABEL[lens]} lens${isModified(filters, lens) ? ' (modified)' : ''}`}
      </h4>
      {up.map((f) => box(f, FAMILY_LABEL[f], edgeStyle(f, false), FAMILY_HINT[f]))}
      <details className="edge-kinds">
        <summary>More</summary>
        {FAMILIES.filter((f) => !up.includes(f)).map((f) => box(f, FAMILY_LABEL[f], edgeStyle(f, false), FAMILY_HINT[f]))}
        {FAMILIES.map((f) =>
          KINDS_OF[f].map((k) => box(k, KIND_LABEL[k], edgeStyle(f, false))),
        )}
      </details>
      <label className="check kind-filter" title="Edges a person rejected">
        <input type="checkbox" checked={filters.showRejected} onChange={(e) => setFilter('showRejected', e.target.checked)} />
        <Swatch style={edgeStyle('flow', false)} faded />
        rejected edges
      </label>
      <label className="check kind-filter" title="Edges that no longer hold, drawn dashed">
        <input type="checkbox" checked={filters.showSuperseded} onChange={(e) => setFilter('showSuperseded', e.target.checked)} />
        <Swatch style={edgeStyle('flow', false, true)} />
        superseded edges (no longer hold)
      </label>
    </>
  )
}

/** What the legend lists, for the edges the filters let show: each family drawn, dashed (inferred) and superseded. */
export function legendOf(edges: GraphEdge[]): { families: EdgeFamily[]; inferred: boolean; superseded: boolean } {
  const families = new Set<EdgeFamily>()
  let inferred = false
  let superseded = false
  for (const info of edges) {
    if (isSuperseded(info)) superseded = true
    else families.add(familyOf(info.kind))
    if (isInferred(info) && familyOf(info.kind) !== 'meaning') inferred = true
  }
  return { families: FAMILIES.filter((f) => families.has(f)), inferred, superseded }
}

/** What the edge checkboxes above do not say: dashed lines, the ends and orphan marks. Each edge type has its swatch in the list, once. */
export function EdgeLegend() {
  const edges = useGraphStore((s) => s.edges)
  const filters = useGraphStore((s) => s.filters)
  const { families, inferred } = useMemo(
    () => legendOf(edges.map((e) => e.data!.info).filter((info) => edgeShown(info, filters))),
    [edges, filters],
  )
  const measured = useCardinality().data
  const ends = hasEnds(measured) && families.includes('reference')
  const orphans = anyOrphans(measured) && families.includes('reference')
  if (!inferred && !ends && !orphans) return null
  return (
    <div className="edge-legend" aria-label="Legend">
      {inferred && (
        <div className="kind-filter">
          <Swatch style={edgeStyle('reference', true)} />
          dashed: inferred or proposed
        </div>
      )}
      {ends && (
        <div className="kind-filter" title="Drawn only where keys and nullability say so. Click an edge for the reason.">
          ends: || exactly one, o| zero or one, o&lt; zero or more
        </div>
      )}
      {orphans && (
        <div className="kind-filter" title="Measured: some keys have no match in the referenced table. Click the edge for the numbers.">
          <span style={{ color: 'var(--edge-orphan)', fontWeight: 700 }}>/</span> orphans: keys with no match
        </div>
      )}
    </div>
  )
}

/** "From: ..." under an edge's heading: the fact the edge stands on. Provenance and evidence stay below. */
export function EdgeFrom({ info }: { info: GraphEdge }) {
  return (
    <p className="edge-from">
      <span className="hint">From</span> {edgeSource(info)}
    </p>
  )
}
