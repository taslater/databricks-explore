import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react'
import { DEFAULT_EDGE_COLOR } from '../model'
import { useSketchStore } from '../sketchStore'
import { InlineText } from '../nodes/InlineText'
import type { SketchEdge } from '../types'

export type SketchFlowEdge = Edge<{ edge: SketchEdge }, 'sketch'>

/**
 * A user-drawn connector: straight, orthogonal (step) or curved, solid or dashed, with arrowheads chosen on
 * each end and a label in the middle that is edited in place. Derived links are not drawn by this component,
 * so the two stay visually distinct (these are dark and solid by default; derived ones are thin and gray).
 */
export function SketchEdgeView(props: EdgeProps<SketchFlowEdge>) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerStart, markerEnd, selected, data } = props
  const editing = useSketchStore((s) => s.editingEdgeId === id)
  const setEditingEdge = useSketchStore((s) => s.setEditingEdge)
  const setEdgeLabel = useSketchStore((s) => s.setEdgeLabel)
  const edge = data?.edge
  const line = edge?.line ?? 'step'

  const args = { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }
  const [path, labelX, labelY] =
    line === 'straight'
      ? getStraightPath(args)
      : line === 'curve'
        ? getBezierPath(args)
        : getSmoothStepPath({ ...args, borderRadius: 0 })

  const color = edge?.color ?? DEFAULT_EDGE_COLOR
  const label = edge?.label ?? ''

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerStart={markerStart}
        markerEnd={markerEnd}
        interactionWidth={20}
        style={{
          stroke: color,
          strokeWidth: selected ? 3 : 2,
          strokeDasharray: edge?.dashed ? '8 5' : undefined,
        }}
      />
      {(label !== '' || editing) && (
        <EdgeLabelRenderer>
          <div
            className={`sk-edge-label nodrag nopan${selected ? ' selected' : ''}`}
            data-edge-id={id}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              setEditingEdge(id)
            }}
          >
            <InlineText
              value={label}
              editing={editing}
              onCommit={(v) => {
                setEdgeLabel(id, v)
                setEditingEdge(null)
              }}
              className="sk-edge-text"
            />
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
