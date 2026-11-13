import { useCallback, useMemo, useRef, type DragEvent, type MouseEvent } from 'react'
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type NodeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { CanvasWindow } from '../api/types'
import { useCanvasStore, DEFAULT_NOTE_SIZE, DEFAULT_QUERY_SIZE, type CanvasSize } from '../store/canvasStore'
import { TABLE_DRAG_MIME } from '../shared/Picker'
import { deriveLinks } from './persistence/canvasFile'
import { QueryWindow, type QueryFlowNode } from './nodes/QueryWindow'
import { NoteWindow, type NoteFlowNode } from './nodes/NoteWindow'
import { TableCard, type TableFlowNode } from './nodes/TableCard'
import { withBoundary } from './nodes/withBoundary'
import { CanvasToolbar } from './CanvasToolbar'
import { useQueryTables } from './linking/useQueryTables'
import { tableEdges } from './linking/tableEdges'

// Defined outside the component so React Flow sees a stable object. Each type has its own error boundary.
const nodeTypes = { query: withBoundary(QueryWindow), note: withBoundary(NoteWindow), table: withBoundary(TableCard) }

type CanvasFlowNode = QueryFlowNode | NoteFlowNode | TableFlowNode

function toFlowNode(w: CanvasWindow, selected: boolean): CanvasFlowNode {
  return {
    id: w.id,
    type: w.type === 'note' || w.type === 'table' ? w.type : 'query',
    position: w.position,
    data: {},
    selected,
    width: w.size.w,
    // Collapsed nodes drop the fixed height so React Flow measures the title bar.
    height: w.collapsed ? undefined : w.size.h,
  }
}

/** Query canvas: React Flow with pan, zoom, minimap, and controls. */
export function CanvasView() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  )
}

function CanvasInner() {
  const windows = useCanvasStore((s) => s.windows)
  const selectedId = useCanvasStore((s) => s.selectedId)
  const viewport = useCanvasStore((s) => s.viewport)
  const addQueryWindow = useCanvasStore((s) => s.addQueryWindow)
  const addNoteWindow = useCanvasStore((s) => s.addNoteWindow)
  const addTableWindow = useCanvasStore((s) => s.addTableWindow)
  const moveWindow = useCanvasStore((s) => s.moveWindow)
  const setSelected = useCanvasStore((s) => s.setSelected)
  const setViewport = useCanvasStore((s) => s.setViewport)

  const { screenToFlowPosition } = useReactFlow()
  const wrapRef = useRef<HTMLDivElement>(null)

  const nodes = useMemo(
    () => windows.map((w) => toFlowNode(w, w.id === selectedId)),
    [windows, selectedId],
  )

  // Tables each query window reads (server lookup, debounced). Feeds the table edges below.
  const tableReads = useQueryTables(windows)

  // Read-only edges: from each referenced window to the window that references it.
  // Derived from the SQL with the same function the save path uses. Nothing here writes back.
  const edges = useMemo<Edge[]>(
    () => [
      ...deriveLinks(windows).map((l) => ({
        id: `${l.from}>${l.to}`,
        source: l.from,
        target: l.to,
        deletable: false,
        reconnectable: false,
        selectable: false,
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
      // Table card to query window, for each table the query reads. Dashed to tell it from lineage.
      ...tableEdges(windows, tableReads).map((e) => ({
        id: e.id,
        source: e.from,
        target: e.to,
        deletable: false,
        reconnectable: false,
        selectable: false,
        style: { strokeDasharray: '4 4' },
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    ],
    [windows, tableReads],
  )

  // Controlled flow: React Flow reports changes and the store applies them.
  // Dimension changes are ignored here. The resizer writes size through resizeWindow.
  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasFlowNode>[]) => {
      for (const c of changes) {
        if (c.type === 'position' && c.position) {
          moveWindow(c.id, c.position)
        } else if (c.type === 'select') {
          if (c.selected) setSelected(c.id)
          else if (useCanvasStore.getState().selectedId === c.id) setSelected(null)
        }
      }
    },
    [moveWindow, setSelected],
  )

  // Double-click on empty canvas adds a window at the click point.
  function onDoubleClick(e: MouseEvent<HTMLDivElement>) {
    const target = e.target as Element
    if (target.closest('.react-flow__node, .react-flow__panel, .react-flow__controls, .react-flow__minimap')) {
      return
    }
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    addQueryWindow(pos)
  }

  // Top-left corner that centres a window of this size on the visible canvas.
  function centredPoint(size: CanvasSize) {
    const rect = wrapRef.current?.getBoundingClientRect()
    const centre = rect
      ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: 0, y: 0 }
    // Offset each new window so repeated clicks do not stack exactly.
    const offset = (windows.length % 10) * 24
    return { x: centre.x - size.w / 2 + offset, y: centre.y - size.h / 2 + offset }
  }

  // Toolbar buttons place the window at the centre of the visible canvas.
  function addAtCentre() {
    addQueryWindow(centredPoint(DEFAULT_QUERY_SIZE))
  }

  function addNoteAtCentre() {
    addNoteWindow(centredPoint(DEFAULT_NOTE_SIZE))
  }

  // Drop target for tables dragged from the picker. The drop point becomes the card's corner.
  // The picker sets the MIME type. dataTransfer values are readable only on drop, so dragover checks types.
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes(TABLE_DRAG_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    const fullName = e.dataTransfer.getData(TABLE_DRAG_MIME).trim()
    if (fullName === '') return
    e.preventDefault()
    addTableWindow(screenToFlowPosition({ x: e.clientX, y: e.clientY }), fullName)
  }

  return (
    <div
      className="canvas-root"
      ref={wrapRef}
      onDoubleClick={onDoubleClick}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        // No user-drawn connections. The edges above are display-only.
        nodesConnectable={false}
        viewport={viewport}
        onMove={(_, vp) => setViewport(vp)}
        // Backspace would delete a window and its SQL. Deleting goes through the window's button.
        deleteKeyCode={null}
        // Double-click adds a window, so it must not also zoom.
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: false }}
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable />
        <Panel position="top-left">
          <button onClick={addAtCentre}>+ Query window</button>{' '}
          <button onClick={addNoteAtCentre}>+ Note</button>
        </Panel>
        <Panel position="top-right">
          <CanvasToolbar />
        </Panel>
      </ReactFlow>
      {windows.length === 0 && (
        <div className="canvas-empty hint">Double-click the canvas or use "+ Query window" to add one.</div>
      )}
    </div>
  )
}
