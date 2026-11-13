// Client state for the relationship graph. Server data is in TanStack Query. This store holds only what the user has built on screen.
import { applyEdgeChanges, applyNodeChanges, type EdgeChange, type NodeChange } from '@xyflow/react'
import { create } from 'zustand'
import type { RelationsResponse } from '../api/types'
import { nameOf, schemaOf } from './format'
import { computeLayout } from './layout'
import { nodeSize, viaMap } from './derive'
import type { DiagramPayload } from './diagram'
import type { EdgeFilters, FlowEdge, FlowNode, Selection } from './types'

export const DEFAULT_STALE_DAYS = 7

interface GraphState {
  nodes: FlowNode[]
  edges: FlowEdge[]
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

  applyNodeChanges: (changes: NodeChange<FlowNode>[]) => void
  applyEdgeChanges: (changes: EdgeChange<FlowEdge>[]) => void
  setStatus: (text: string, error?: boolean) => void
  setSelection: (selection: Selection) => void
  setHover: (id: string | null) => void
  setStaleDays: (days: number) => void
  setFilter: (key: keyof EdgeFilters, value: boolean) => void
  setFocusSchema: (schema: string | null) => void
  /** Adds the nodes and edges of one /api/relations response. Existing nodes and edges are kept. */
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
  focusSchema: null,
  selection: null,
  hoverId: null,
  staleDays: DEFAULT_STALE_DAYS,
  filters: { lineage: true, fk: true, view_dep: true, showStale: true },
  status: { text: '', error: false },
  layoutPending: false,
  fitPending: false,

  applyNodeChanges: (changes) => set({ nodes: applyNodeChanges(changes, get().nodes) }),
  applyEdgeChanges: (changes) => set({ edges: applyEdgeChanges(changes, get().edges) }),
  setStatus: (text, error = false) => set({ status: { text, error } }),
  setSelection: (selection) => set({ selection }),
  setHover: (hoverId) => set({ hoverId }),
  setStaleDays: (staleDays) => set({ staleDays }),
  setFilter: (key, value) => set((s) => ({ filters: { ...s.filters, [key]: value } })),
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
      const edges = [...s.edges]
      for (const e of resp.edges) {
        if (edgeIds.has(e.id) || !indexById.has(e.source) || !indexById.has(e.target)) continue
        edges.push({ id: e.id, source: e.source, target: e.target, data: { info: e } })
        edgeIds.add(e.id)
      }
      return { nodes, edges, layoutPending: true }
    }),

  clear: () =>
    set({ nodes: [], edges: [], selection: null, hoverId: null, layoutPending: false, fitPending: false }),

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
      focusSchema: payload.focusSchema,
      selection: null,
      hoverId: null,
      layoutPending: false,
      fitPending: true,
    }),
}))
