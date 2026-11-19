import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react'
import type { GraphEdgeKind } from '../api/types'
import { KIND_STYLE } from './edgeStyles'
import { EdgeGrainGlyph } from './NodeFacts'
import type { FlowEdge } from './types'

/** Width in pixels of the invisible path that takes clicks and hovers, so a thin line is easy to hit. React Flow's default is 20. */
export const EDGE_INTERACTION_WIDTH = 32

/** Rejected edges are barely there, proposed ones are lighter than accepted or derived ones. */
const STATUS_OPACITY = { rejected: 0.3, proposed: 0.65 } as const

function makeEdge(kind: GraphEdgeKind | 'superseded') {
  const kindStyle = KIND_STYLE[kind]
  function Edge({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    markerStart,
    markerEnd,
    selected,
    data,
  }: EdgeProps<FlowEdge>) {
    const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
    const status = data?.info.status
    const statusOpacity = status === 'rejected' || status === 'proposed' ? STATUS_OPACITY[status] : 1
    return (
      <>
        <BaseEdge
          path={path}
          markerStart={markerStart}
          markerEnd={markerEnd}
          interactionWidth={EDGE_INTERACTION_WIDTH}
          style={{
            strokeWidth: 1.6,
            ...kindStyle,
            ...(selected ? { strokeWidth: 3.5 } : null),
            opacity: data?.faded ? 0.2 : statusOpacity,
          }}
        />
        <EdgeGrainGlyph id={id} change={data?.grainChange} x={labelX} y={labelY} faded={data?.faded} />
      </>
    )
  }
  return Edge
}

/** Edge type per kind. Keys match the server's edge kind, plus `superseded`, which the view picks for an edge that no longer holds. */
export const EDGE_TYPES = {
  lineage: makeEdge('lineage'),
  fk: makeEdge('fk'),
  view_dep: makeEdge('view_dep'),
  join_mined: makeEdge('join_mined'),
  manual: makeEdge('manual'),
  sketch: makeEdge('sketch'),
  concept_link: makeEdge('concept_link'),
  ontology: makeEdge('ontology'),
  superseded: makeEdge('superseded'),
}
