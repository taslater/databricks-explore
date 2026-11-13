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
import { useGraphActions } from './actions'
import { deriveFlow } from './derive'
import { EDGE_TYPES } from './edges'
import { EDGE_COLORS } from './format'
import { useGraphStore } from './graphStore'
import { GraphToolbar } from './GraphToolbar'
import { TableNode } from './TableNode'
import type { FlowEdge, FlowNode } from './types'
import { useUiStore } from '../store/uiStore'

// Defined at module scope so React Flow does not rebuild its node and edge types on every render.
const NODE_TYPES = { table: TableNode }
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
  return (
    <div className="graph-view">
      <GraphToolbar showPickerToggle={pickerCollapsed} />
      <div className="graph-canvas">
        <ReactFlowProvider>
          <GraphCanvas />
        </ReactFlowProvider>
      </div>
    </div>
  )
}

function GraphCanvas() {
  const rf = useReactFlow()
  const actions = useGraphActions()
  const rawNodes = useGraphStore((s) => s.nodes)
  const rawEdges = useGraphStore((s) => s.edges)
  const focusSchema = useGraphStore((s) => s.focusSchema)
  const filters = useGraphStore((s) => s.filters)
  const staleDays = useGraphStore((s) => s.staleDays)
  const hoverId = useGraphStore((s) => s.hoverId)
  const layoutPending = useGraphStore((s) => s.layoutPending)
  const fitPending = useGraphStore((s) => s.fitPending)

  const flow = useMemo(
    () => deriveFlow({ nodes: rawNodes, edges: rawEdges, focusSchema, filters, staleDays, hoverId }),
    [rawNodes, rawEdges, focusSchema, filters, staleDays, hoverId],
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

  const onNodesChange = (changes: NodeChange<FlowNode>[]) => useGraphStore.getState().applyNodeChanges(changes)
  const onEdgesChange = (changes: EdgeChange<FlowEdge>[]) => useGraphStore.getState().applyEdgeChanges(changes)

  const onNodeClick: NodeMouseHandler<FlowNode> = (_, node) =>
    useGraphStore.getState().setSelection({ kind: 'node', id: node.id })
  const onEdgeClick: EdgeMouseHandler<FlowEdge> = (_, edge) =>
    useGraphStore.getState().setSelection({ kind: 'edge', id: edge.id })
  const onNodeDoubleClick: NodeMouseHandler<FlowNode> = (_, node) => void actions.expand(node.id)
  const onNodeMouseEnter: NodeMouseHandler<FlowNode> = (_, node) => useGraphStore.getState().setHover(node.id)
  const onNodeMouseLeave = () => useGraphStore.getState().setHover(null)

  // Drag from a node's green handle (shown on hover) onto another node to store a manual edge.
  const onConnectEnd: OnConnectEnd = (event, state) => {
    const from = state.fromNode?.id
    const to = state.toNode?.id ?? nodeIdAt(event)
    if (from && to && from !== to) void actions.connect(from, to)
  }

  return (
    <ReactFlow<FlowNode, FlowEdge>
      nodes={flow.nodes}
      edges={flow.edges}
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
