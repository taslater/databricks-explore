import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react'
import { edgeStyle, FAMILY_STYLE, isInferred, type EdgeFamily } from './edgeStyles'
import { EdgeEnd } from './EdgeEnds'
import { EdgeGrainGlyph } from './NodeFacts'
import { EdgeTransformGlyphs } from './EdgeTransforms'
import type { FlowEdge } from './types'

/** Width in pixels of the invisible path that takes clicks and hovers, so a thin line is easy to hit. React Flow's default is 20. */
export const EDGE_INTERACTION_WIDTH = 32

/** Rejected edges are barely there. */
const REJECTED_OPACITY = 0.3

/** An end is drawn in the reference color and fades with its line. */
const endLook = (faded?: boolean, rejected?: boolean) => ({ stroke: FAMILY_STYLE.reference.stroke, width: 1.2, opacity: faded ? 0.2 : rejected ? REJECTED_OPACITY : 1 })

function makeEdge(family: EdgeFamily, superseded = false) {
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
    const rejected = data?.info.status === 'rejected'
    return (
      <>
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
        {family === 'reference' && data?.cardinality && (
          <>
            {data.cardinality.source && <EdgeEnd x={sourceX} y={sourceY} side={sourcePosition} end={data.cardinality.source.end} {...endLook(data.faded, rejected)} />}
            {data.cardinality.target && <EdgeEnd x={targetX} y={targetY} side={targetPosition} end={data.cardinality.target.end} {...endLook(data.faded, rejected)} />}
          </>
        )}
        <EdgeGrainGlyph id={id} change={data?.transform?.glyphs.includes('aggregate') ? undefined : data?.grainChange} x={labelX} y={labelY} faded={data?.faded} />
        <EdgeTransformGlyphs id={id} transform={data?.transform} x={targetX} y={targetY} side={targetPosition} faded={data?.faded} />
      </>
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
