import { Handle, Position } from '@xyflow/react'
import { ANCHOR_IN, ANCHOR_OUT, anchorStyle } from '../../shared/anchors'

const SIDES = [
  { id: 't', position: Position.Top },
  { id: 'r', position: Position.Right },
  { id: 'b', position: Position.Bottom },
  { id: 'l', position: Position.Left },
] as const

/**
 * Connection points on all four sides of a node. The canvas runs React Flow in loose connection mode, so any
 * of these can start a connector and any can end one. Ids are t, r, b and l (the `source_handle` and
 * `target_handle` of a saved connector). Hidden until the node is hovered or selected.
 *
 * Each side also has two anchors that are never drawn or grabbed, `<side>-in` and `<side>-out`. A side that
 * carries connectors both ways draws them there instead of at the center (see sketch/anchors.ts).
 */
export function SideHandles() {
  return (
    <>
      {SIDES.map((s) => (
        <Handle key={s.id} id={s.id} type="source" position={s.position} className="sk-handle sketch-export-hide" />
      ))}
      {SIDES.flatMap((s) => [
        <Handle key={`${s.id}-in`} id={`${s.id}-in`} type="source" position={s.position} className="sk-anchor" style={anchorStyle(s.id, ANCHOR_IN)} />,
        <Handle key={`${s.id}-out`} id={`${s.id}-out`} type="source" position={s.position} className="sk-anchor" style={anchorStyle(s.id, ANCHOR_OUT)} />,
      ])}
    </>
  )
}
