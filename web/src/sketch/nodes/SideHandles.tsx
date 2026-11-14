import { Handle, Position } from '@xyflow/react'

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
 */
export function SideHandles() {
  return (
    <>
      {SIDES.map((s) => (
        <Handle key={s.id} id={s.id} type="source" position={s.position} className="sk-handle sketch-export-hide" />
      ))}
    </>
  )
}
