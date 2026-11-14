import { NodeResizer, type NodeProps } from '@xyflow/react'
import { DEFAULT_FONT_SIZE } from '../model'
import { useSketchStore } from '../sketchStore'
import { InlineText } from './InlineText'
import { SideHandles } from './SideHandles'
import { useResizeHandlers, useSketchNode, } from './useSketchNode'
import type { SketchFlowNode } from './ShapeNode'

/**
 * A frame groups other nodes by sitting behind them: moving the frame moves the unlocked nodes inside it.
 * Only the header and the border take the mouse, so a marquee can start inside a frame.
 */
export function FrameNode({ id, selected }: NodeProps<SketchFlowNode>) {
  const node = useSketchNode(id)
  const editing = useSketchStore((s) => s.editingId === id)
  const setEditing = useSketchStore((s) => s.setEditing)
  const setLabel = useSketchStore((s) => s.setLabel)
  const resize = useResizeHandlers(id)
  if (!node) return null
  const locked = node.locked === true
  const stroke = node.stroke ?? '#6b7280'
  const fill = node.fill ?? '#e5e7eb'
  return (
    <div
      className={`sk-node sk-frame${selected ? ' selected' : ''}${locked ? ' locked' : ''}`}
      style={{ borderColor: stroke }}
    >
      <NodeResizer
        isVisible={selected && !locked}
        minWidth={80}
        minHeight={60}
        lineClassName="sketch-export-hide"
        handleClassName="sketch-export-hide"
        {...resize}
      />
      <div className="sk-frame-bg" style={{ background: fill === 'none' ? 'transparent' : fill }} />
      <div
        className="sk-frame-header"
        style={{ color: stroke, fontSize: node.font_size ?? DEFAULT_FONT_SIZE }}
        onDoubleClick={(e) => {
          e.stopPropagation()
          if (!locked) setEditing(id)
        }}
      >
        <InlineText
          value={node.label ?? ''}
          editing={editing}
          onCommit={(v) => {
            setLabel(id, v)
            setEditing(null)
          }}
          placeholder="Frame"
          className="sk-label-frame"
        />
        {locked && <span className="sk-lock sketch-export-hide" aria-label="Locked">&#128274;</span>}
      </div>
      <span className="sk-frame-edge top" />
      <span className="sk-frame-edge bottom" />
      <span className="sk-frame-edge left" />
      <span className="sk-frame-edge right" />
      <SideHandles />
    </div>
  )
}
