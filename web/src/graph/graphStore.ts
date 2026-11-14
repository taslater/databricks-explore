// Client state for the relationship graph. Server data is in TanStack Query. This store holds only what the user has built on screen.
import { applyEdgeChanges, applyNodeChanges, type EdgeChange, type NodeChange } from '@xyflow/react'
import { create } from 'zustand'
import type { GraphEdge, RelationsResponse } from '../api/types'
import type { ColumnInfo } from './columns'
import { nameOf, schemaOf } from './format'
import { computeLayout } from './layout'
import { nodeSize, viaMap } from './derive'
import type { DiagramPayload } from './diagram'
import type { EdgeFilters, FlowEdge, FlowNode, Selection } from './types'

export const DEFAULT_STALE_DAYS = 7

export const DEFAULT_FILTERS: EdgeFilters = {
  lineage: true,
  fk: true,
  view_dep: true,
  join_mined: true,
  manual: true,
  sketch: true,
  concept_link: true,
  ontology: true,
  showStale: true,
  showRejected: false,
}

/** The panel open at the bottom of the graph: mining, suggested relationships, usage. */
export type Drawer = 'suggestions' | 'mining' | 'usage' | null

interface GraphState {
  nodes: FlowNode[]
  edges: FlowEdge[]
  /** Column-to-column edges from `level=column` responses. Drawn when both nodes show their columns. */
  columnEdges: FlowEdge[]
  drawer: Drawer
  /** Show columns is on for the whole graph: new nodes show their columns as they arrive. Not part of a saved diagram. */
  columnsOn: boolean
  /** The confirm dialog for a mining run is open. */
  mineDialog: boolean
  /** Draw the concepts linked to the tables on the graph (the Concepts toggle). Not part of a saved diagram. */
  showConcepts: boolean
  focusSchema: string | null
  selection: Selection
  hoverId: string | null
  staleDays: number
  filters: EdgeFilters
  status: { text: string; error: boolean }
  /** Run dagre on the next render where every visible node has been measured. */
  layoutPending: boolean
  /** Fit the view on the next render where every visible node has been measured. */
  fitPending: boolean
  /** UI only, not saved. The pan and zoom when the Graph view was last hidden, restored when it shows again. */
  viewport: { x: number; y: number; zoom: number } | null
  setViewport: (viewport: { x: number; y: number; zoom: number } | null) => void

  applyNodeChanges: (changes: NodeChange<FlowNode>[]) => void
  applyEdgeChanges: (changes: EdgeChange<FlowEdge>[]) => void
  setStatus: (text: string, error?: boolean) => void
  setSelection: (selection: Selection) => void
  setHover: (id: string | null) => void
  setStaleDays: (days: number) => void
  setFilter: (key: keyof EdgeFilters, value: boolean) => void
  /** Changes fields of one edge's info (status, note) after the server accepted the change. */
  updateEdgeInfo: (id: string, patch: Partial<GraphEdge>) => void
  setFocusSchema: (schema: string | null) => void
  setDrawer: (drawer: Drawer) => void
  setColumnsOn: (on: boolean) => void
  setMineDialog: (open: boolean) => void
  setShowConcepts: (show: boolean) => void
  /** Stores a node's columns and shows them. */
  setColumns: (id: string, columns: ColumnInfo[]) => void
  setShowColumns: (id: string, show: boolean) => void
  setAllColumns: (id: string, all: boolean) => void
  /** Adds column edges, or replaces the ones with the same id (fresh status, note, evidence). */
  mergeColumnEdges: (edges: GraphEdge[]) => void
  /** Adds the nodes and edges of one relationships response. Existing nodes and edges stay in place, but an edge already on screen takes the fresh info (status, note, evidence). */
  mergeRelations: (resp: RelationsResponse) => void
  clear: () => void
  requestLayout: () => void
  runLayout: () => void
  finishFit: () => void
  loadDiagram: (payload: DiagramPayload) => void
}

export const useGraphStore = create<GraphState>()((set, get) => ({
  nodes: [],
  edges: [],
  columnEdges: [],
  drawer: null,
  columnsOn: false,
  mineDialog: false,
  showConcepts: false,
  focusSchema: null,
  selection: null,
  hoverId: null,
  staleDays: DEFAULT_STALE_DAYS,
  filters: DEFAULT_FILTERS,
  status: { text: '', error: false },
  layoutPending: false,
  fitPending: false,
  viewport: null,
  setViewport: (viewport) => set({ viewport }),

  applyNodeChanges: (changes) => set({ nodes: applyNodeChanges(changes, get().nodes) }),
  applyEdgeChanges: (changes) => set({ edges: applyEdgeChanges(changes, get().edges) }),
  setStatus: (text, error = false) => set({ status: { text, error } }),
  setSelection: (selection) => set({ selection }),
  setHover: (hoverId) => set({ hoverId }),
  setStaleDays: (staleDays) => set({ staleDays }),
  setFilter: (key, value) => set((s) => ({ filters: { ...s.filters, [key]: value } })),
  updateEdgeInfo: (id, patch) => {
    const apply = (list: FlowEdge[]) =>
      list.map((e) => (e.id === id ? { ...e, data: { ...e.data!, info: { ...e.data!.info, ...patch } } } : e))
    set((s) => ({ edges: apply(s.edges), columnEdges: apply(s.columnEdges) }))
  },
  setDrawer: (drawer) => set({ drawer }),
  setColumnsOn: (columnsOn) => set({ columnsOn }),
  setMineDialog: (mineDialog) => set({ mineDialog }),
  setShowConcepts: (showConcepts) => set({ showConcepts }),
  setColumns: (id, columns) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, columns, showColumns: true } } : n)),
    })),
  setShowColumns: (id, show) =>
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, showColumns: show } } : n)) })),
  setAllColumns: (id, all) =>
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, allColumns: all } } : n)) })),
  mergeColumnEdges: (edges) =>
    set((s) => {
      const fresh = new Map(edges.map((e) => [e.id, e]))
      const kept = s.columnEdges.map((e) =>
        fresh.has(e.id) ? { ...e, data: { ...e.data!, info: fresh.get(e.id)! } } : e,
      )
      const have = new Set(kept.map((e) => e.id))
      for (const e of edges) {
        if (!have.has(e.id)) kept.push({ id: e.id, source: e.source, target: e.target, data: { info: e } })
      }
      return { columnEdges: kept }
    }),
  setFocusSchema: (focusSchema) => set({ focusSchema }),

  mergeRelations: (resp) =>
    set((s) => {
      // The first batch of a fresh graph is the focus object. Later batches are expansions.
      const first = s.nodes.length === 0
      const nodes = [...s.nodes]
      const indexById = new Map(nodes.map((n, i) => [n.id, i]))
      for (const n of resp.nodes) {
        const idx = indexById.get(n.id)
        if (idx !== undefined) {
          if (n.self_ref) {
            nodes[idx] = {
              ...nodes[idx],
              data: { ...nodes[idx].data, selfRef: true, selfRefLastSeen: n.self_ref_last_seen },
            }
          }
          continue
        }
        nodes.push({
          id: n.id,
          type: 'table',
          position: { x: 0, y: 0 },
          data: {
            name: nameOf(n.id),
            schema: schemaOf(n.id),
            kind: n.kind,
            focus: first && !!n.focus,
            selfRef: !!n.self_ref,
            selfRefLastSeen: n.self_ref_last_seen,
          },
        })
        indexById.set(n.id, nodes.length - 1)
      }

      const edgeIds = new Set(s.edges.map((e) => e.id))
      const fresh = new Map(resp.edges.map((e) => [e.id, e]))
      const edges = s.edges.map((e) => (fresh.has(e.id) ? { ...e, data: { ...e.data!, info: fresh.get(e.id)! } } : e))
      for (const e of resp.edges) {
        if (edgeIds.has(e.id) || !indexById.has(e.source) || !indexById.has(e.target)) continue
        edges.push({ id: e.id, source: e.source, target: e.target, data: { info: e } })
        edgeIds.add(e.id)
      }
      return { nodes, edges, layoutPending: true }
    }),

  clear: () =>
    set({ nodes: [], edges: [], columnEdges: [], selection: null, hoverId: null, layoutPending: false, fitPending: false, viewport: null }),

  requestLayout: () => set({ layoutPending: true }),

  runLayout: () =>
    set((s) => {
      const via = viaMap(s.edges)
      const positions = computeLayout(
        s.nodes.map((n) => {
          const size = nodeSize(n, s.focusSchema, via.get(n.id))
          return {
            id: n.id,
            width: size.width,
            height: size.height,
            focus: n.data.focus,
            x: n.position.x,
            y: n.position.y,
          }
        }),
        s.edges.map((e) => ({ source: e.source, target: e.target, kind: e.data!.info.kind })),
      )
      return {
        nodes: s.nodes.map((n) => {
          const p = positions.get(n.id)
          return p ? { ...n, position: p } : n
        }),
        layoutPending: false,
        fitPending: true,
      }
    }),

  finishFit: () => set({ fitPending: false }),

  loadDiagram: (payload) =>
    set({
      nodes: payload.nodes,
      edges: payload.edges,
      columnEdges: [],
      focusSchema: payload.focusSchema,
      selection: null,
      hoverId: null,
      layoutPending: false,
      fitPending: true,
    }),
}))
