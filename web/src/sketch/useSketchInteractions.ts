// React Flow event handlers for the sketch: selection, moving (with frames carrying what is inside them),
// connecting and reconnecting, and placing a node with a tool. A host passes them to <ReactFlow>.
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { ConnectionMode, type Connection, type EdgeChange, type Node, type NodeChange, type XYPosition } from '@xyflow/react'
import { containedIds, defaultSize, GRID, toItems, toolToNode } from './model'
import { useSketchStore } from './sketchStore'
import { isPlacingTool, type Point, type Tool } from './types'

interface Carry {
  /** The frame that is being dragged, and where it started. */
  frameId: string
  frameStart: Point
  /** What moves with it, and where each started. */
  carried: Record<string, Point>
}

/** Props for <ReactFlow> that depend on the tool: marquee or pan on drag, snapping, loose connections. */
export function sketchFlowProps(tool: Tool, snap: boolean) {
  return {
    connectionMode: ConnectionMode.Loose,
    // Left-drag on the background is a marquee. Pan with the hand tool, the space bar, or the middle and right buttons.
    panOnDrag: tool === 'hand' ? true : [1, 2],
    selectionOnDrag: tool === 'select' || tool === 'connect',
    panActivationKeyCode: 'Space',
    multiSelectionKeyCode: ['Shift', 'Meta', 'Control'],
    deleteKeyCode: null,
    elevateNodesOnSelect: false,
    snapToGrid: snap,
    snapGrid: [GRID, GRID] as [number, number],
    connectionRadius: 28,
    reconnectRadius: 16,
  }
}

export interface PlacePreview {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Handlers for <ReactFlow>. `screenToFlow` comes from useReactFlow.
 * The returned `onPointerDownCapture` belongs on the element that wraps the canvas: while a placing tool is
 * active it takes the press (click to place a default-size node, drag to draw its size) before React Flow sees it.
 */
export function useSketchInteractions(screenToFlow: (p: XYPosition) => XYPosition, wrapperBox: () => DOMRect | undefined) {
  const carry = useRef<Carry | null>(null)
  const [preview, setPreview] = useState<PlacePreview | null>(null)

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    const st = useSketchStore.getState()
    const moves: Record<string, Point> = {}
    let selected: Set<string> | null = null
    for (const c of changes) {
      if (c.type === 'position' && c.position) {
        const cr = carry.current
        // A node carried by a frame is placed from the frame's movement, so its own change is ignored.
        if (cr && c.id in cr.carried) continue
        moves[c.id] = { x: c.position.x, y: c.position.y }
        if (cr && c.id === cr.frameId) {
          const dx = c.position.x - cr.frameStart.x
          const dy = c.position.y - cr.frameStart.y
          for (const [id, start] of Object.entries(cr.carried)) moves[id] = { x: start.x + dx, y: start.y + dy }
        }
      } else if (c.type === 'select') {
        if (!selected) selected = new Set(st.selectedIds)
        if (c.selected) selected.add(c.id)
        else selected.delete(c.id)
      }
    }
    if (Object.keys(moves).length > 0) st.moveItems(moves)
    if (selected) st.select([...selected], st.selectedEdgeIds)
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const st = useSketchStore.getState()
    let selected: Set<string> | null = null
    for (const c of changes) {
      if (c.type === 'select') {
        if (!selected) selected = new Set(st.selectedEdgeIds)
        if (c.selected) selected.add(c.id)
        else selected.delete(c.id)
      }
    }
    if (selected) st.select(st.selectedIds, [...selected])
  }, [])

  // One undo step per drag: the state is recorded when the gesture starts.
  const onNodeDragStart = useCallback((_: unknown, node: Node, dragged: Node[]) => {
    const st = useSketchStore.getState()
    st.checkpoint(`drag:${node.id}:${Date.now()}`)
    const items = toItems(st.nodes, st.host.nodes())
    const draggedIds = new Set(dragged.map((d) => d.id))
    carry.current = null
    const frame = items.find((i) => draggedIds.has(i.id) && i.type === 'frame')
    if (!frame) return
    const carried: Record<string, Point> = {}
    for (const id of containedIds(frame, items)) {
      if (draggedIds.has(id)) continue
      const it = items.find((i) => i.id === id)
      if (it) carried[id] = { ...it.position }
    }
    carry.current = { frameId: frame.id, frameStart: { ...frame.position }, carried }
  }, [])

  const onNodeDragStop = useCallback(() => {
    carry.current = null
  }, [])

  const onConnect = useCallback((c: Connection) => {
    useSketchStore.getState().connect(c)
  }, [])

  const onReconnect = useCallback((oldEdge: { id: string }, c: Connection) => {
    useSketchStore.getState().reconnect(oldEdge.id, c)
  }, [])

  const onEdgeDoubleClick = useCallback((_: unknown, edge: { id: string }) => {
    const st = useSketchStore.getState()
    if (st.edges.some((e) => e.id === edge.id)) st.setEditingEdge(edge.id)
  }, [])

  const onPointerDownCapture = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const tool = useSketchStore.getState().tool
      if (!isPlacingTool(tool) || e.button !== 0) return
      const target = e.target as Element
      if (target.closest('.react-flow__panel, .react-flow__controls, .react-flow__minimap, .sk-palette, .sk-editbar')) return
      e.preventDefault()
      e.stopPropagation()
      const box = wrapperBox()
      const origin = { x: e.clientX, y: e.clientY }
      const rect = (ev: { clientX: number; clientY: number }): PlacePreview => ({
        x: Math.min(origin.x, ev.clientX) - (box?.left ?? 0),
        y: Math.min(origin.y, ev.clientY) - (box?.top ?? 0),
        w: Math.abs(ev.clientX - origin.x),
        h: Math.abs(ev.clientY - origin.y),
      })
      setPreview(rect(e))
      const move = (ev: PointerEvent) => setPreview(rect(ev))
      const up = (ev: PointerEvent) => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        setPreview(null)
        const spec = toolToNode(tool)
        if (!spec) return
        const dragged = Math.abs(ev.clientX - origin.x) > 8 && Math.abs(ev.clientY - origin.y) > 8
        const st = useSketchStore.getState()
        if (dragged && spec.type !== 'placeholder') {
          const a = screenToFlow({ x: Math.min(origin.x, ev.clientX), y: Math.min(origin.y, ev.clientY) })
          const b = screenToFlow({ x: Math.max(origin.x, ev.clientX), y: Math.max(origin.y, ev.clientY) })
          st.placeTool(tool, a, { w: b.x - a.x, h: b.y - a.y })
        } else {
          // A click puts the default size centered on the click.
          const at = screenToFlow({ x: origin.x, y: origin.y })
          const size = defaultSize(spec.type, spec.shape)
          st.placeTool(tool, { x: at.x - size.w / 2, y: spec.type === 'placeholder' ? at.y : at.y - size.h / 2 })
        }
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [screenToFlow, wrapperBox],
  )

  return { onNodesChange, onEdgesChange, onNodeDragStart, onNodeDragStop, onConnect, onReconnect, onEdgeDoubleClick, onPointerDownCapture, preview }
}
