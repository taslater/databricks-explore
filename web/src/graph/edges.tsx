import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react'
import { EDGE_COLORS } from './format'
import type { FlowEdge } from './types'

interface KindStyle {
  stroke: string
  strokeDasharray?: string
}

// Legacy styles: lineage solid, FK dashed, view dependency solid in its own color, stale lineage dotted and gray.
const KIND_STYLE: Record<'lineage' | 'fk' | 'view_dep' | 'stale', KindStyle> = {
  lineage: { stroke: EDGE_COLORS.lineage },
  fk: { stroke: EDGE_COLORS.fk, strokeDasharray: '6 4' },
  view_dep: { stroke: EDGE_COLORS.view_dep },
  stale: { stroke: EDGE_COLORS.stale, strokeDasharray: '2 3' },
}

function makeEdge(kind: keyof typeof KIND_STYLE) {
  const kindStyle = KIND_STYLE[kind]
  function Edge({
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
    const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
    return (
      <BaseEdge
        path={path}
        markerStart={markerStart}
        markerEnd={markerEnd}
        style={{
          ...kindStyle,
          strokeWidth: selected ? 3.5 : 1.6,
          opacity: data?.faded ? 0.2 : 1,
        }}
      />
    )
  }
  return Edge
}

/** Edge type per kind. Keys match the server's edge kind, plus `stale`, which the view picks for lineage older than the stale-days setting. */
export const EDGE_TYPES = {
  lineage: makeEdge('lineage'),
  fk: makeEdge('fk'),
  view_dep: makeEdge('view_dep'),
  stale: makeEdge('stale'),
}
