import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react'
import { edgeStyle, isInferred, type EdgeFamily } from './edgeStyles'
import type { FlowEdge } from './types'

/** Width in pixels of the invisible path that takes clicks and hovers, so a thin line is easy to hit. React Flow's default is 20. */
export const EDGE_INTERACTION_WIDTH = 32

/** Rejected edges are barely there. */
const REJECTED_OPACITY = 0.3

function makeEdge(family: EdgeFamily, superseded = false) {
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
    const rejected = data?.info.status === 'rejected'
    return (
      <BaseEdge
        path={path}
        markerStart={markerStart}
        markerEnd={markerEnd}
        interactionWidth={EDGE_INTERACTION_WIDTH}
        style={{
          ...edgeStyle(family, data ? isInferred(data.info) : false, superseded),
          ...(selected ? { strokeWidth: 3.5 } : null),
          opacity: data?.faded ? 0.2 : rejected ? REJECTED_OPACITY : 1,
        }}
      />
    )
  }
  return Edge
}

/** Edge type per family, plus `superseded`, which the view picks for an edge that no longer holds. */
export const EDGE_TYPES = {
  flow: makeEdge('flow'),
  reference: makeEdge('reference'),
  meaning: makeEdge('meaning'),
  superseded: makeEdge('flow', true),
}
