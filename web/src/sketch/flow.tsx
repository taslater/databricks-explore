// What a host passes to React Flow to draw the sketch: node and edge types, and the conversions from store
// objects to React Flow nodes and edges. The Canvas uses them today. The Graph tab could use them for annotations.
import type { ComponentType } from 'react'
import { MarkerType, type Node, type NodeProps } from '@xyflow/react'
import { ErrorBoundary } from '../shared/ErrorBoundary'
import { SketchEdgeView, type SketchFlowEdge } from './edges/SketchEdgeView'
import { FrameNode } from './nodes/FrameNode'
import { PlaceholderNode } from './nodes/PlaceholderNode'
import { ShapeNode } from './nodes/ShapeNode'
import { DEFAULT_EDGE_COLOR, effectiveZ } from './model'
import { useSketchStore } from './sketchStore'
import type { Point, SketchEdge, SketchNode, Tool } from './types'

/** Error boundary per node, so a crash in one sketch node shows an error card there and nothing else. */
function withSketchBoundary<P extends NodeProps>(Inner: ComponentType<P>): ComponentType<P> {
  function Bounded(props: P) {
    return (
      <ErrorBoundary
        fallback={(error, reset) => (
          <div className="sk-node error-card" role="alert">
            <strong>This node crashed.</strong>
            <pre className="error-card-message">{error.message}</pre>
            <div className="error-card-actions nodrag">
              <button onClick={reset}>Reset</button>
              <button
                onClick={() => {
                  useSketchStore.getState().select([props.id])
                  useSketchStore.getState().removeSelection()
                }}
              >
                Delete
              </button>
            </div>
          </div>
        )}
      >
        <Inner {...props} />
      </ErrorBoundary>
    )
  }
  Bounded.displayName = `SketchBounded(${Inner.displayName ?? Inner.name})`
  return Bounded
}

/** Stable objects, defined once, so React Flow does not see new types on every render. */
export const sketchNodeTypes = {
  shape: withSketchBoundary(ShapeNode),
  text: withSketchBoundary(ShapeNode),
  sticky: withSketchBoundary(ShapeNode),
  frame: withSketchBoundary(FrameNode),
  placeholder: withSketchBoundary(PlaceholderNode),
}

export const sketchEdgeTypes = { sketch: SketchEdgeView }

/** One sketch node as a React Flow node. A placeholder gets no fixed height: it is as tall as its columns. */
export function toSketchFlowNode(n: SketchNode, selected: boolean, tool: Tool): Node {
  const frame = n.type === 'frame'
  return {
    id: n.id,
    type: n.type,
    position: n.position,
    data: {},
    selected,
    width: n.size.w,
    height: n.type === 'placeholder' ? undefined : n.size.h,
    draggable: n.locked !== true && tool !== 'hand',
    deletable: false,
    zIndex: effectiveZ(n),
    // A frame's body lets the mouse through to the canvas (so a marquee can start inside it).
    // Its header and border switch pointer events back on.
    ...(frame ? { style: { pointerEvents: 'none' as const } } : {}),
  }
}

/** One connector as a React Flow edge. */
export function toSketchFlowEdge(e: SketchEdge, selected: boolean, labelAt?: Point): SketchFlowEdge {
  const color = e.color ?? DEFAULT_EDGE_COLOR
  return {
    id: e.id,
    type: 'sketch',
    source: e.source,
    target: e.target,
    sourceHandle: e.source_handle ?? null,
    targetHandle: e.target_handle ?? null,
    selected,
    reconnectable: true,
    deletable: false,
    focusable: false,
    data: { edge: e, ...(labelAt ? { labelAt } : {}) },
    markerStart: e.arrow_start ? { type: MarkerType.ArrowClosed, color, width: 18, height: 18 } : undefined,
    markerEnd: e.arrow_end ? { type: MarkerType.ArrowClosed, color, width: 18, height: 18 } : undefined,
    zIndex: 5,
  }
}

