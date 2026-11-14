import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react'
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
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { CanvasWindow } from '../api/types'
import { useCanvasStore, DEFAULT_NOTE_SIZE, DEFAULT_QUERY_SIZE, type CanvasSize } from '../store/canvasStore'
import { useUiStore } from '../store/uiStore'
import { TABLE_DRAG_MIME } from '../shared/Picker'
import { sketchEdgeTypes, sketchNodeTypes, toSketchFlowEdge, toSketchFlowNode } from '../sketch/flow'
import { GRID, effectiveZ } from '../sketch/model'
import { useSketchStore } from '../sketch/sketchStore'
import { useSketchKeys } from '../sketch/useSketchKeys'
import { sketchFlowProps, useSketchInteractions } from '../sketch/useSketchInteractions'
import { EditBar } from '../sketch/panels/EditBar'
import { Palette } from '../sketch/panels/Palette'
import { isPlacingTool, type SketchHost, type Tool } from '../sketch/types'
import { deriveLinks } from './persistence/canvasFile'
import { QueryWindow, type QueryFlowNode } from './nodes/QueryWindow'
import { NoteWindow, type NoteFlowNode } from './nodes/NoteWindow'
import { TableCard, type TableFlowNode } from './nodes/TableCard'
import { withBoundary } from './nodes/withBoundary'
import { CanvasToolbar } from './CanvasToolbar'
import { maximizedFrame, type Frame } from './maximize'
import { useQueryTables } from './linking/useQueryTables'
import { tableEdges } from './linking/tableEdges'
import { facingHandles } from './linking/handles'

// Defined outside the component so React Flow sees a stable object. Each type has its own error boundary.
const nodeTypes = {
  query: withBoundary(QueryWindow),
  note: withBoundary(NoteWindow),
  table: withBoundary(TableCard),
  ...sketchNodeTypes,
}

type CanvasFlowNode = QueryFlowNode | NoteFlowNode | TableFlowNode

/** What the sketch module sees of the canvas: its windows, with their geometry. Everything else stays here. */
const canvasHost: SketchHost = {
  nodes: () =>
    useCanvasStore.getState().windows.map((w) => ({
      id: w.id,
      type: w.type,
      position: w.position,
      size: w.size,
      z: w.z,
      locked: w.locked,
      title: w.title,
      table: w.table,
      // A table card can be fetched again, so Delete may remove it. Query windows and notes hold SQL and text.
      removable: w.type === 'table',
    })),
  patch: (patches) => useCanvasStore.getState().patchGeometry(patches),
  remove: (ids) => useCanvasStore.getState().removeWindows(ids),
}

function toFlowNode(w: CanvasWindow, selected: boolean, frame: Frame | null, tool: Tool): CanvasFlowNode {
  const size = frame ? frame.size : w.size
  return {
    id: w.id,
    type: w.type === 'note' || w.type === 'table' ? w.type : 'query',
    position: frame ? frame.position : w.position,
    data: {},
    selected,
    width: size.w,
    // Collapsed nodes drop the fixed height so React Flow measures the title bar.
    height: w.collapsed && !frame ? undefined : size.h,
    draggable: w.locked !== true && tool !== 'hand',
    deletable: false,
    zIndex: effectiveZ(w),
    // A maximized window sits above the others and stays put.
    ...(frame ? { draggable: false, zIndex: 1000 } : {}),
  }
}

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    // Storage can be unavailable. The choice still applies for this session.
  }
}

/** Canvas: React Flow with query windows, notes, table cards, sketch shapes and connectors. */
export function CanvasView() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  )
}

function CanvasInner() {
  const windows = useCanvasStore((s) => s.windows)
  const viewport = useCanvasStore((s) => s.viewport)
  const canvasName = useCanvasStore((s) => s.canvasName)
  const maximizedId = useCanvasStore((s) => s.maximizedId)
  const setMaximized = useCanvasStore((s) => s.setMaximized)
  const addQueryWindow = useCanvasStore((s) => s.addQueryWindow)
  const addNoteWindow = useCanvasStore((s) => s.addNoteWindow)
  const addTableWindow = useCanvasStore((s) => s.addTableWindow)
  const setViewport = useCanvasStore((s) => s.setViewport)

  const sketchNodes = useSketchStore((s) => s.nodes)
  const sketchEdges = useSketchStore((s) => s.edges)
  const selectedIds = useSketchStore((s) => s.selectedIds)
  const selectedEdgeIds = useSketchStore((s) => s.selectedEdgeIds)
  const tool = useSketchStore((s) => s.tool)
  const snap = useSketchStore((s) => s.snap)

  const canvasDetailsOpen = useUiStore((s) => s.canvasDetailsOpen)
  const setCanvasDetailsOpen = useUiStore((s) => s.setCanvasDetailsOpen)

  const { screenToFlowPosition } = useReactFlow()
  const wrapRef = useRef<HTMLDivElement>(null)

  // The sketch module reaches the canvas's windows through this host.
  useEffect(() => {
    useSketchStore.getState().setHost(canvasHost)
  }, [])

  // A connector cannot outlive the window at one of its ends.
  const windowIds = useMemo(() => windows.map((w) => w.id).join('\n'), [windows])
  useEffect(() => {
    useSketchStore.getState().prune(windowIds === '' ? [] : windowIds.split('\n'))
  }, [windowIds])

  // Size of the canvas area, to size a maximized window against.
  const [box, setBox] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => setBox({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The minimap covers part of the canvas, so it is off until asked for.
  const [showMinimap, setShowMinimap] = useState(() => readFlag('canvasMinimap'))
  function toggleMinimap() {
    setShowMinimap((on) => {
      writeFlag('canvasMinimap', !on)
      return !on
    })
  }

  const maximized = maximizedId !== null && windows.some((w) => w.id === maximizedId)
  const frame = useMemo(() => (maximized ? maximizedFrame(viewport, box) : null), [maximized, viewport, box])

  const nodes = useMemo<Node[]>(() => {
    const selected = new Set(selectedIds)
    return [
      ...windows.map((w) => toFlowNode(w, selected.has(w.id), w.id === maximizedId ? frame : null, tool)),
      ...sketchNodes.map((n) => toSketchFlowNode(n, selected.has(n.id), tool)),
    ]
  }, [windows, sketchNodes, selectedIds, maximizedId, frame, tool])

  // Tables each query window reads (server lookup, debounced). Feeds the table edges below.
  const tableReads = useQueryTables(windows)

  // Derived edges are read-only: from each referenced window to the window that references it, and from each
  // table card to the queries that read it. They are thin and gray, and the sketch's own connectors are not.
  const edges = useMemo<Edge[]>(() => {
    const byId = new Map(windows.map((w) => [w.id, w]))
    const derived = (id: string, from: string, to: string, dashed: boolean): Edge => {
      const a = byId.get(from)
      const b = byId.get(to)
      const handles = a && b ? facingHandles(a, b) : null
      return {
        id,
        source: from,
        target: to,
        sourceHandle: handles?.source,
        targetHandle: handles?.target,
        className: 'edge-derived',
        deletable: false,
        reconnectable: false,
        selectable: false,
        focusable: false,
        style: dashed ? { strokeDasharray: '4 4' } : undefined,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#9aa4b2' },
      }
    }
    const picked = new Set(selectedEdgeIds)
    return [
      ...deriveLinks(windows).map((l) => derived(`${l.from}>${l.to}`, l.from, l.to, false)),
      // Table card to query window, for each table the query reads. Dashed to tell it from lineage.
      ...tableEdges(windows, tableReads).map((e) => derived(e.id, e.from, e.to, true)),
      ...sketchEdges.map((e) => toSketchFlowEdge(e, picked.has(e.id))),
    ]
  }, [windows, tableReads, sketchEdges, selectedEdgeIds])

  const wrapperBox = useCallback(() => wrapRef.current?.getBoundingClientRect(), [])
  const interactions = useSketchInteractions(screenToFlowPosition, wrapperBox)

  // Double-click on empty canvas adds a query window at the click point.
  function onDoubleClick(e: MouseEvent<HTMLDivElement>) {
    const target = e.target as Element
    if (
      target.closest(
        '.react-flow__node, .react-flow__panel, .react-flow__controls, .react-flow__minimap, .react-flow__edge, .react-flow__edgelabel-renderer, .sk-palette',
      )
    ) {
      return
    }
    if (useSketchStore.getState().tool !== 'select') return
    addQueryWindow(screenToFlowPosition({ x: e.clientX, y: e.clientY }))
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

  // Q and N add a window like the toolbar buttons. The sketch's own shortcuts are in useSketchKeys.
  const extraKeys = useMemo(
    () => ({ q: () => addQueryWindow(centredPoint(DEFAULT_QUERY_SIZE)), n: () => addNoteWindow(centredPoint(DEFAULT_NOTE_SIZE)) }),
    // centredPoint reads the live viewport through refs and the flow instance, so the handlers stay current.
    [addQueryWindow, addNoteWindow],
  )
  useSketchKeys(extraKeys)

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

  const flow = sketchFlowProps(tool, snap)
  const empty = windows.length === 0 && sketchNodes.length === 0

  return (
    <div
      className={`canvas-root tool-${tool}${isPlacingTool(tool) ? ' placing' : ''}`}
      ref={wrapRef}
      onDoubleClick={onDoubleClick}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onPointerDownCapture={interactions.onPointerDownCapture}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={sketchEdgeTypes}
        onNodesChange={interactions.onNodesChange}
        onEdgesChange={interactions.onEdgesChange}
        onNodeDragStart={interactions.onNodeDragStart}
        onNodeDragStop={interactions.onNodeDragStop}
        onConnect={interactions.onConnect}
        onReconnect={interactions.onReconnect}
        onEdgeDoubleClick={interactions.onEdgeDoubleClick}
        connectionMode={flow.connectionMode}
        viewport={viewport}
        onMove={(_, vp) => setViewport(vp)}
        // Backspace would delete a window and its SQL. The Delete key is handled in useSketchKeys instead,
        // and removes only sketch nodes, connectors and table cards.
        deleteKeyCode={flow.deleteKeyCode}
        selectionOnDrag={flow.selectionOnDrag && !maximized}
        panActivationKeyCode={flow.panActivationKeyCode}
        multiSelectionKeyCode={flow.multiSelectionKeyCode}
        elevateNodesOnSelect={flow.elevateNodesOnSelect}
        snapToGrid={flow.snapToGrid}
        snapGrid={flow.snapGrid}
        connectionRadius={flow.connectionRadius}
        reconnectRadius={flow.reconnectRadius}
        // Double-click adds a window, so it must not also zoom.
        zoomOnDoubleClick={false}
        // A maximized window fills the view, so the view is held still until it is restored.
        panOnDrag={maximized ? false : flow.panOnDrag}
        zoomOnScroll={!maximized}
        zoomOnPinch={!maximized}
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={GRID} />
        {!maximized && <Controls orientation="horizontal" showInteractive={false} className="canvas-controls" />}
        {showMinimap && <MiniMap pannable zoomable />}
        <Panel position="top-left">
          <div className="canvas-topleft">
            <div className="canvas-row">
              <button onClick={addAtCentre} title="Add a query window (Q)">
                + Query window
              </button>
              <button onClick={addNoteAtCentre} title="Add a Markdown note (N)">
                + Note
              </button>
              <button onClick={toggleMinimap} aria-pressed={showMinimap} title="Show or hide the minimap">
                Minimap
              </button>
              {maximized && <button onClick={() => setMaximized(null)}>Restore window</button>}
            </div>
            <EditBar fileStem={canvasName ?? 'diagram'}>
              <button
                onClick={() => setCanvasDetailsOpen(!canvasDetailsOpen)}
                aria-pressed={canvasDetailsOpen}
                title="Show or hide the properties panel"
              >
                Properties
              </button>
            </EditBar>
          </div>
        </Panel>
        <Panel position="center-left">
          <Palette />
        </Panel>
        <Panel position="top-right">
          <CanvasToolbar />
        </Panel>
      </ReactFlow>
      {interactions.preview && (
        <div
          className="sk-place-preview"
          style={{ left: interactions.preview.x, top: interactions.preview.y, width: interactions.preview.w, height: interactions.preview.h }}
        />
      )}
      {empty && (
        <div className="canvas-empty hint">
          Pick a shape from the left to sketch, or double-click the canvas (or use "+ Query window") to add a query.
        </div>
      )}
    </div>
  )
}
