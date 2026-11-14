import { NodeResizer, type Node, type NodeProps } from '@xyflow/react'
import type { ShapeKind, SketchNode } from '../types'
import { DEFAULT_FONT_SIZE, DEFAULT_STROKE } from '../model'
import { useSketchStore } from '../sketchStore'
import { InlineText } from './InlineText'
import { SideHandles } from './SideHandles'
import { useResizeHandlers, useSketchNode } from './useSketchNode'

export type SketchFlowNode = Node<Record<string, unknown>, 'shape' | 'text' | 'sticky' | 'frame' | 'placeholder'>

const STROKE_WIDTH = 2

/** The outline of a shape, drawn to the node's exact size so the stroke keeps its width when it is resized. */
function ShapeOutline({ kind, w, h, fill, stroke }: { kind: ShapeKind; w: number; h: number; fill: string; stroke: string }) {
  const sw = STROKE_WIDTH
  const common = { fill, stroke, strokeWidth: sw }
  let body
  if (kind === 'rect') {
    body = <rect x={sw / 2} y={sw / 2} width={Math.max(0, w - sw)} height={Math.max(0, h - sw)} {...common} />
  } else if (kind === 'rounded') {
    body = (
      <rect x={sw / 2} y={sw / 2} width={Math.max(0, w - sw)} height={Math.max(0, h - sw)} rx={14} ry={14} {...common} />
    )
  } else if (kind === 'ellipse') {
    body = <ellipse cx={w / 2} cy={h / 2} rx={Math.max(0, w / 2 - sw / 2)} ry={Math.max(0, h / 2 - sw / 2)} {...common} />
  } else if (kind === 'diamond') {
    body = <polygon points={`${w / 2},${sw / 2} ${w - sw / 2},${h / 2} ${w / 2},${h - sw / 2} ${sw / 2},${h / 2}`} {...common} />
  } else {
    // Cylinder: a flat top ellipse, straight sides, and a curved bottom.
    const ry = Math.min(18, h / 4)
    const x1 = sw / 2
    const x2 = w - sw / 2
    body = (
      <>
        <path
          d={`M${x1},${ry} A${(x2 - x1) / 2},${ry} 0 0 1 ${x2},${ry} L${x2},${h - ry} A${(x2 - x1) / 2},${ry} 0 0 1 ${x1},${h - ry} Z`}
          {...common}
        />
        <path d={`M${x1},${ry} A${(x2 - x1) / 2},${ry} 0 0 0 ${x2},${ry}`} fill="none" stroke={stroke} strokeWidth={sw} />
      </>
    )
  }
  return (
    <svg className="sk-outline" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {body}
    </svg>
  )
}

/** Padding that keeps a label inside the usable part of the shape. */
function labelInset(kind: ShapeKind | undefined): string {
  if (kind === 'ellipse') return '14% 16%'
  if (kind === 'diamond') return '22% 24%'
  if (kind === 'cylinder') return '34% 8% 12%'
  return '6px 10px'
}

/**
 * Rectangle, rounded rectangle, ellipse, diamond, cylinder (a database), text and sticky note. One component,
 * since they differ only in the outline and where the label sits. Double-click edits the label.
 */
export function ShapeNode({ id, selected }: NodeProps<SketchFlowNode>) {
  const node = useSketchNode(id)
  if (!node) return null
  return <ShapeBody node={node} selected={selected} />
}

function ShapeBody({ node, selected }: { node: SketchNode; selected: boolean }) {
  const id = node.id
  const editing = useSketchStore((s) => s.editingId === id)
  const seed = useSketchStore((s) => (s.editingId === id ? s.editingSeed : null))
  const setEditing = useSketchStore((s) => s.setEditing)
  const setLabel = useSketchStore((s) => s.setLabel)
  const resize = useResizeHandlers(id)
  const locked = node.locked === true
  const fill = node.fill ?? '#ffffff'
  const stroke = node.stroke ?? DEFAULT_STROKE
  const fontSize = node.font_size ?? DEFAULT_FONT_SIZE
  const { w, h } = node.size
  const isShape = node.type === 'shape'
  const isSticky = node.type === 'sticky'

  const labelStyle = {
    fontSize,
    padding: isShape ? labelInset(node.shape) : isSticky ? '10px' : '2px 4px',
    textAlign: isShape ? ('center' as const) : ('left' as const),
    alignItems: isShape ? 'center' : isSticky ? 'flex-start' : 'center',
    justifyContent: isShape ? 'center' : 'flex-start',
  }

  return (
    <div
      className={`sk-node sk-${node.type}${selected ? ' selected' : ''}${locked ? ' locked' : ''}`}
      style={isSticky ? { background: fill === 'none' ? 'transparent' : fill, borderColor: stroke } : undefined}
      onDoubleClick={(e) => {
        e.stopPropagation()
        if (!locked) setEditing(id)
      }}
    >
      <NodeResizer
        isVisible={selected && !locked}
        minWidth={40}
        minHeight={24}
        lineClassName="sketch-export-hide"
        handleClassName="sketch-export-hide"
        {...resize}
      />
      {isShape && node.shape && (
        <ShapeOutline kind={node.shape} w={w} h={h} fill={fill === 'none' ? 'none' : fill} stroke={stroke} />
      )}
      <InlineText
        value={node.label ?? ''}
        editing={editing}
        seed={seed}
        onCommit={(v) => {
          setLabel(id, v)
          setEditing(null)
        }}
        placeholder={isShape ? undefined : node.type === 'text' ? 'Text' : 'Note'}
        style={labelStyle}
        className={isShape ? 'sk-label-shape' : 'sk-label-flat'}
      />
      {locked && <span className="sk-lock sketch-export-hide" title="Locked" aria-label="Locked">&#128274;</span>}
      <SideHandles />
    </div>
  )
}
