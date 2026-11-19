import '@xyflow/react/dist/style.css'
import {
  ConnectionMode,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeMouseHandler,
  type OnConnectEnd,
  type EdgeMouseHandler,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react'
import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { useCertification, useConceptsForTables } from '../api/concepts'
import { useNodeFacts } from '../api/nodeFacts'
import { withCertification } from '../concepts/certification'
import { useConceptsStore } from '../concepts/conceptsStore'
import { conceptOverlay, isConceptEdge } from '../concepts/overlay'
import { ConceptNode } from './ConceptNode'
import { useGraphActions } from './actions'
import { deriveFlow } from './derive'
import { GroupBoxNode, groupBoxNodes, type GroupBoxFlowNode } from './CollapseMarks'
import { isSummaryId, withMergedTransforms, BOX_PREFIX } from './collapse'
import { useCollapseView, useGroupTags } from './useCollapse'
import { EDGE_TYPES } from './edges'
import { useNodeColors } from './ColorByControl'
import { withFills } from './colorBy'
import { useCardinality, withCardinality } from './EdgeEnds'
import { useEdgeTransforms } from './EdgeTransforms'
import { withTransforms } from './transformText'
import { EDGE_COLORS } from './format'
import { useGraphStore } from './graphStore'
import { GraphToolbar } from './GraphToolbar'
import { MineDialog } from './MineDialog'
import { MiningPanel } from './MiningPanel'
import { withGrainChanges, withNodeFacts } from './cardFacts'
import { EdgeMenuHost, ProfileDialog, useEdgeContextMenu } from './ProfileDialog'
import { useNeighborScan, withNeighborCounts } from './neighborScan'
import { TableStatsDialog } from './TableStatsDialog'
import { TableNode } from './TableNode'
import type { ConceptFlowNode, FlowEdge, FlowNode } from './types'
import { useUiStore } from '../store/uiStore'
import { TABLE_DRAG_MIME } from '../shared/tableDrag'

// Defined at module scope so React Flow does not rebuild its node and edge types on every render.
const NODE_TYPES = { table: TableNode, concept: ConceptNode, groupbox: GroupBoxNode }
const CONNECTION_LINE_STYLE = { stroke: EDGE_COLORS.manual, strokeWidth: 2 }
/** Keys that add a clicked node to the selection: Shift as in most diagram tools, plus the platform modifier. */
const MULTI_SELECT_KEYS = ['Shift', 'Meta', 'Control']

/** The table node under the pointer where a drag ended, if any. Dropping anywhere on a node connects to it. */
function nodeIdAt(event: MouseEvent | TouchEvent): string | undefined {
  const point = 'changedTouches' in event ? event.changedTouches[0] : event
  const el = document.elementFromPoint(point.clientX, point.clientY)
  return el?.closest('.react-flow__node')?.getAttribute('data-id') ?? undefined
}

/** Relationship graph. Toolbar on top, React Flow canvas below. */
export function GraphView() {
  const pickerCollapsed = useUiStore((s) => s.pickerCollapsed)
  const drawer = useGraphStore((s) => s.drawer)
  const mineDialog = useGraphStore((s) => s.mineDialog)
  const actions = useGraphActions()

  // A table dragged from the picker and dropped here is added to the graph, keeping what is there.
  // dataTransfer values are readable only on drop, so dragover checks the type.
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer.types.includes(TABLE_DRAG_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    const fullName = e.dataTransfer.getData(TABLE_DRAG_MIME).trim()
    if (fullName === '') return
    e.preventDefault()
    void actions.addObject(fullName)
  }

  return (
    <div className="graph-view">
      <GraphToolbar showPickerToggle={pickerCollapsed} />
      <div className="graph-canvas" onDragOver={onDragOver} onDrop={onDrop}>
        <ReactFlowProvider>
          <GraphCanvas />
        </ReactFlowProvider>
      </div>
      {drawer && <MiningPanel drawer={drawer} />}
      {mineDialog && <MineDialog />}
      <TableStatsDialog />
      <ProfileDialog />
      <EdgeMenuHost />
    </div>
  )
}

function GraphCanvas() {
  const rf = useReactFlow()
  // The view unmounts when another tab shows. Keep its pan and zoom across that, so coming back looks the same.
  const [initialViewport] = useState(() => useGraphStore.getState().viewport)
  useEffect(
    () => () => {
      if (useGraphStore.getState().nodes.length > 0) useGraphStore.getState().setViewport(rf.getViewport())
    },
    [rf],
  )
  const actions = useGraphActions()
  const rawNodes = useGraphStore((s) => s.nodes)
  const columnEdges = useGraphStore((s) => s.columnEdges)
  const focusSchema = useGraphStore((s) => s.focusSchema)
  const filters = useGraphStore((s) => s.filters)
  const hoverId = useGraphStore((s) => s.hoverId)
  const layoutPending = useGraphStore((s) => s.layoutPending)
  const fitPending = useGraphStore((s) => s.fitPending)
  const showConcepts = useGraphStore((s) => s.showConcepts)
  const connected = useUiStore((s) => s.connectedProfile)

  // Collapsed groups and elided chains: the nodes and edges added to the graph, and the nodes it leaves out.
  const view = useCollapseView()
  useGroupTags()
  const flow = useMemo(
    () => deriveFlow({ nodes: view.nodes, edges: view.edges, columnEdges, focusSchema, filters, hoverId, forceHidden: view.hidden }),
    [view, columnEdges, focusSchema, filters, hoverId],
  )
  const boxes = useMemo(() => groupBoxNodes(view, flow.nodes), [view, flow.nodes])

  // The Concepts toggle: for the tables on the graph, their linked concepts, drawn above them. Never stored or laid out.
  const tableIds = useMemo(() => rawNodes.map((n) => n.id).filter((id) => !id.startsWith('ph:')), [rawNodes])
  const conceptData = useConceptsForTables(tableIds, showConcepts && connected !== null)
  const overlay = useMemo(
    () => (showConcepts ? conceptOverlay(flow.nodes, conceptData.data) : { nodes: [], edges: [] }),
    [showConcepts, flow.nodes, conceptData.data],
  )
  // Certification badges (system.certification_status), added when drawing like the concepts. Silent when it cannot be read.
  const certification = useCertification()
  // The grain line, size badge and late dot, and the Σ on edges that change grain: read from the server's cache, drawn, never saved.
  const readable = useMemo(() => rawNodes.filter((n) => !n.data.missing).map((n) => n.id).filter((id) => !id.startsWith('ph:')), [rawNodes])
  const nodeFacts = useNodeFacts(readable)
  // The counts at a node's sides: flow neighbors that are not on the graph. Read table by table, drawn, never saved.
  const neighbors = useGraphStore((s) => s.neighbors)
  useNeighborScan(rawNodes)
  // The fill chosen by Color by (none in type mode, where each node keeps its type color).
  const fills = useNodeColors().colors?.fills ?? null
  const drawnNodes = useMemo<Array<FlowNode | ConceptFlowNode | GroupBoxFlowNode>>(
    () => [...boxes, ...withFills(withNeighborCounts(withNodeFacts(withCertification(flow.nodes, certification.data), nodeFacts.data), neighbors, filters), fills), ...overlay.nodes],
    [boxes, flow.nodes, overlay.nodes, certification.data, nodeFacts.data, neighbors, filters, fills],
  )
  const ends = useCardinality()
  const transforms = useEdgeTransforms()
  const drawnEdges = useMemo(
    () => [...withMergedTransforms(withTransforms(withCardinality(withGrainChanges(flow.edges, nodeFacts.data), ends.data), transforms.data), transforms.data), ...overlay.edges],
    [flow.edges, overlay.edges, nodeFacts.data, ends.data, transforms.data],
  )

  // Layout and fit need real node sizes, so they wait until every visible node has been measured.
  useEffect(() => {
    const ready = flow.nodes.every((n) => n.hidden || n.measured?.width !== undefined)
    if (!ready) return
    const store = useGraphStore.getState()
    if (layoutPending) {
      store.runLayout()
      return
    }
    if (fitPending) {
      store.finishFit()
      // Wait a frame so React Flow has applied the new positions before fitting.
      requestAnimationFrame(() => void rf.fitView({ padding: '30px', duration: 0 }))
    }
  }, [flow.nodes, layoutPending, fitPending, rf])

  // Concept nodes and their edges are drawn, not stored: their changes (size, selection) never reach the graph store.
  const isConcept = (id: string) => id.startsWith('concept:')
  // A collapsed group's node is drawn, not stored, but it can be dragged: its place is kept in the store. A group's box follows its members.
  const idOf = (c: NodeChange<FlowNode | ConceptFlowNode | GroupBoxFlowNode>) => ('id' in c ? c.id : c.item.id)
  const onNodesChange = (changes: NodeChange<FlowNode | ConceptFlowNode | GroupBoxFlowNode>[]) => {
    for (const c of changes) {
      if (c.type === 'position' && c.position && isSummaryId(c.id)) useGraphStore.getState().setGroupPosition(c.id.slice('summary:'.length), c.position)
    }
    useGraphStore
      .getState()
      .applyNodeChanges(changes.filter((c) => !isConcept(idOf(c)) && !isSummaryId(idOf(c)) && !idOf(c).startsWith(BOX_PREFIX)) as NodeChange<FlowNode>[])
  }
  const onEdgesChange = (changes: EdgeChange<FlowEdge>[]) =>
    useGraphStore.getState().applyEdgeChanges(changes.filter((c) => !('id' in c && isConceptEdge(c.id))))

  const onNodeClick: NodeMouseHandler<FlowNode | ConceptFlowNode | GroupBoxFlowNode> = (_, node) => {
    if (node.type === 'groupbox') return
    if (node.type === 'concept') {
      useConceptsStore.getState().select((node as ConceptFlowNode).data.conceptId)
      useUiStore.getState().setView('concepts')
      return
    }
    useGraphStore.getState().setSelection({ kind: 'node', id: node.id })
  }
  const onEdgeClick: EdgeMouseHandler<FlowEdge> = (_, edge) => {
    if (!isConceptEdge(edge.id)) useGraphStore.getState().setSelection({ kind: 'edge', id: edge.id })
  }
  const onEdgeContextMenu = useEdgeContextMenu()
  const onNodeDoubleClick: NodeMouseHandler<FlowNode | ConceptFlowNode | GroupBoxFlowNode> = (_, node) => {
    if (isSummaryId(node.id)) useGraphStore.getState().setGroupCollapsed((node as FlowNode).data.summary!.key, false)
    else if (node.type === 'table') void actions.expand(node.id)
  }
  const onNodeMouseEnter: NodeMouseHandler<FlowNode | ConceptFlowNode | GroupBoxFlowNode> = (_, node) => {
    if (node.type === 'table') useGraphStore.getState().setHover(node.id)
  }
  const onNodeMouseLeave = () => useGraphStore.getState().setHover(null)

  // Drag from a node's green handle (shown on hover) onto another node to store a manual edge.
  const onConnectEnd: OnConnectEnd = (event, state) => {
    const from = state.fromNode?.id
    const to = state.toNode?.id ?? nodeIdAt(event)
    if (from && to && from !== to) void actions.connect(from, to)
  }

  return (
    <ReactFlow<FlowNode | ConceptFlowNode | GroupBoxFlowNode, FlowEdge>
      nodes={drawnNodes}
      edges={drawnEdges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={onNodeClick}
      onEdgeClick={onEdgeClick}
      onEdgeContextMenu={onEdgeContextMenu}
      onNodeDoubleClick={onNodeDoubleClick}
      onNodeMouseEnter={onNodeMouseEnter}
      onNodeMouseLeave={onNodeMouseLeave}
      onConnectEnd={onConnectEnd}
      connectionMode={ConnectionMode.Loose}
      connectionLineStyle={CONNECTION_LINE_STYLE}
      zoomOnDoubleClick={false}
      deleteKeyCode={null}
      defaultViewport={initialViewport ?? undefined}
      // Shift- or Cmd/Ctrl-click adds a node to the selection (Shift-drag on the pane still draws a box).
      multiSelectionKeyCode={MULTI_SELECT_KEYS}
      minZoom={0.05}
    >
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}
