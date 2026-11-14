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
import { useEffect, useMemo } from 'react'
import { useCertification, useConceptsForTables } from '../api/concepts'
import { withCertification } from '../concepts/certification'
import { useConceptsStore } from '../concepts/conceptsStore'
import { conceptOverlay, isConceptEdge } from '../concepts/overlay'
import { ConceptNode } from './ConceptNode'
import { useGraphActions } from './actions'
import { deriveFlow } from './derive'
import { EDGE_TYPES } from './edges'
import { EDGE_COLORS } from './format'
import { useGraphStore } from './graphStore'
import { GraphToolbar } from './GraphToolbar'
import { MineDialog } from './MineDialog'
import { MiningPanel } from './MiningPanel'
import { TableNode } from './TableNode'
import type { ConceptFlowNode, FlowEdge, FlowNode } from './types'
import { useUiStore } from '../store/uiStore'

// Defined at module scope so React Flow does not rebuild its node and edge types on every render.
const NODE_TYPES = { table: TableNode, concept: ConceptNode }
const CONNECTION_LINE_STYLE = { stroke: EDGE_COLORS.manual, strokeWidth: 2 }

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
  return (
    <div className="graph-view">
      <GraphToolbar showPickerToggle={pickerCollapsed} />
      <div className="graph-canvas">
        <ReactFlowProvider>
          <GraphCanvas />
        </ReactFlowProvider>
      </div>
      {drawer && <MiningPanel drawer={drawer} />}
      {mineDialog && <MineDialog />}
    </div>
  )
}

function GraphCanvas() {
  const rf = useReactFlow()
  const actions = useGraphActions()
  const rawNodes = useGraphStore((s) => s.nodes)
  const rawEdges = useGraphStore((s) => s.edges)
  const columnEdges = useGraphStore((s) => s.columnEdges)
  const focusSchema = useGraphStore((s) => s.focusSchema)
  const filters = useGraphStore((s) => s.filters)
  const staleDays = useGraphStore((s) => s.staleDays)
  const hoverId = useGraphStore((s) => s.hoverId)
  const layoutPending = useGraphStore((s) => s.layoutPending)
  const fitPending = useGraphStore((s) => s.fitPending)
  const showConcepts = useGraphStore((s) => s.showConcepts)
  const connected = useUiStore((s) => s.connectedProfile)

  const flow = useMemo(
    () => deriveFlow({ nodes: rawNodes, edges: rawEdges, columnEdges, focusSchema, filters, staleDays, hoverId }),
    [rawNodes, rawEdges, columnEdges, focusSchema, filters, staleDays, hoverId],
  )

  // The Concepts toggle: for the tables on the graph, their linked concepts, drawn above them. Never stored or laid out.
  const tableIds = useMemo(() => rawNodes.map((n) => n.id).filter((id) => !id.startsWith('ph:')), [rawNodes])
  const conceptData = useConceptsForTables(tableIds, showConcepts && connected !== null)
  const overlay = useMemo(
    () => (showConcepts ? conceptOverlay(flow.nodes, conceptData.data) : { nodes: [], edges: [] }),
    [showConcepts, flow.nodes, conceptData.data],
  )
  // Certification badges (system.certification_status), added when drawing like the concepts. Silent when it cannot be read.
  const certification = useCertification()
  const drawnNodes = useMemo<Array<FlowNode | ConceptFlowNode>>(
    () => [...withCertification(flow.nodes, certification.data), ...overlay.nodes],
    [flow.nodes, overlay.nodes, certification.data],
  )
  const drawnEdges = useMemo(() => [...flow.edges, ...overlay.edges], [flow.edges, overlay.edges])

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
  const onNodesChange = (changes: NodeChange<FlowNode | ConceptFlowNode>[]) =>
    useGraphStore
      .getState()
      .applyNodeChanges(changes.filter((c) => !isConcept('id' in c ? c.id : c.item.id)) as NodeChange<FlowNode>[])
  const onEdgesChange = (changes: EdgeChange<FlowEdge>[]) =>
    useGraphStore.getState().applyEdgeChanges(changes.filter((c) => !('id' in c && isConceptEdge(c.id))))

  const onNodeClick: NodeMouseHandler<FlowNode | ConceptFlowNode> = (_, node) => {
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
  const onNodeDoubleClick: NodeMouseHandler<FlowNode | ConceptFlowNode> = (_, node) => {
    if (node.type !== 'concept') void actions.expand(node.id)
  }
  const onNodeMouseEnter: NodeMouseHandler<FlowNode | ConceptFlowNode> = (_, node) => {
    if (node.type !== 'concept') useGraphStore.getState().setHover(node.id)
  }
  const onNodeMouseLeave = () => useGraphStore.getState().setHover(null)

  // Drag from a node's green handle (shown on hover) onto another node to store a manual edge.
  const onConnectEnd: OnConnectEnd = (event, state) => {
    const from = state.fromNode?.id
    const to = state.toNode?.id ?? nodeIdAt(event)
    if (from && to && from !== to) void actions.connect(from, to)
  }

  return (
    <ReactFlow<FlowNode | ConceptFlowNode, FlowEdge>
      nodes={drawnNodes}
      edges={drawnEdges}
      nodeTypes={NODE_TYPES}
      edgeTypes={EDGE_TYPES}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeClick={onNodeClick}
      onEdgeClick={onEdgeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onNodeMouseEnter={onNodeMouseEnter}
      onNodeMouseLeave={onNodeMouseLeave}
      onConnectEnd={onConnectEnd}
      connectionMode={ConnectionMode.Loose}
      connectionLineStyle={CONNECTION_LINE_STYLE}
      zoomOnDoubleClick={false}
      deleteKeyCode={null}
      minZoom={0.05}
    >
      <Controls showInteractive={false} />
    </ReactFlow>
  )
}
