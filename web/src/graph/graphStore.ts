// Client state for the relationship graph. Server data is in TanStack Query. This store holds only what the user has built on screen.
import { applyEdgeChanges, applyNodeChanges, type EdgeChange, type NodeChange } from '@xyflow/react'
import { create } from 'zustand'
import type { GraphEdge, GraphEdgeKind, GraphNode, RelationsResponse } from '../api/types'
import type { ColumnInfo } from './columns'
import { nameOf, schemaOf } from './format'
import { computeLayout, computeScopedLayout } from './layout'
import { layoutInput } from './layoutInput'
import type { NeighborSet } from './neighbors'
import type { ColorBy } from './colorBy'
import { collapseGraph, DEFAULT_GROUPING, groupingSignature, type GroupBy, type Grouping } from './collapse'
import type { DiagramPayload } from './diagram'
import { DEFAULT_LENS, LENS_COLUMNS, presetFilters, type Lens, type LensPositions } from './lens'
import { familyOf } from './edgeStyles'
import type { DiagramRevision } from '../api/diagrams'
import type { EdgeFilters, FlowEdge, FlowNode, Selection } from './types'

export const DEFAULT_FILTERS: EdgeFilters = {
  flow: true,
  reference: true,
  meaning: false,
  lineage: true,
  fk: true,
  view_dep: true,
  join_mined: true,
  manual: true,
  sketch: true,
  concept_link: true,
  ontology: true,
  showSuperseded: false,
  showRejected: false,
}

/** The saved graph the page is showing: its stored name, the revision it was loaded or saved at, and what the page held then (see diagramSync.ts). */
export interface OpenDiagram {
  name: string
  revision: number
  signature: string
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
  /** What a node's fill means (the Color by menu). Saved with the graph as `color_by`. */
  colorBy: ColorBy
  focusSchema: string | null
  selection: Selection
  hoverId: string | null
  filters: EdgeFilters
  status: { text: string; error: boolean }
  /** Lay the graph out on the next render where every visible node has been measured. */
  layoutPending: boolean
  /** When set, the next layout only redoes the parts of the graph holding these nodes (a node's column level changed). */
  layoutScope: string[] | null
  /** The next layout starts over, ignoring where the nodes are now (the Re-layout button). Otherwise nodes already placed keep their order. */
  layoutFresh: boolean
  /** Fit the view on the next render where every visible node has been measured. */
  fitPending: boolean
  /** The question the graph answers: Flow, Model or All. A preset for the edge filters, the column level and the layout. Saved with the graph as `lens`. */
  lens: Lens
  /** The top-left positions of the tables in each lens that is not showing, kept so switching back puts them where they were. Saved with the graph as `lens_positions`. */
  lensPositions: LensPositions
  /** The column level the lens just switched to wants on every table; the lens switch carries it out and clears it. Never saved. */
  columnsRequest: 'off' | 'keys' | null
  /** Layout requests are ignored while a lens switch loads columns, so the positions it brought back stay. Never saved. */
  lensHold: boolean
  /** Shows another lens: its edge filters, its column level and its own positions (laid out when it has none for these tables). */
  setLens: (lens: Lens) => void
  /** Puts the edge filters back to the lens's own. */
  resetLens: () => void
  /** The lens switch has set the column level it was asked for. */
  finishLensColumns: () => void
  /** How the nodes are grouped, which groups are collapsed, and whether chains of pass-through views are drawn as one edge. Saved with the graph as `grouping`. */
  grouping: Grouping
  /** Where each collapsed group's node sits (by group key). Never saved. */
  groupPositions: Record<string, { x: number; y: number }>
  /** The tag value of each table, while the graph is grouped by a tag. Read by useGroupTags, never saved. */
  groupTags: Record<string, string>
  setGroupBy: (by: GroupBy) => void
  /** Collapses or expands one group (or, with undefined, goes back to the default rule), then lays the graph out again. */
  setGroupCollapsed: (key: string, collapsed: boolean | undefined) => void
  /** Sets every named group at once. */
  setGroupsCollapsed: (keys: string[], collapsed: boolean) => void
  setChains: (on: boolean) => void
  /** Draws a chain of pass-through views in full. */
  showChain: (id: string) => void
  setGroupPosition: (key: string, position: { x: number; y: number }) => void
  setGroupTags: (tags: Record<string, string>) => void
  /** Flow neighbors read for each table (neighbors.ts), for the counts at a node's sides. Never saved. */
  neighbors: Record<string, NeighborSet>
  /** The tables each expansion added, by `<table>|<up or down>`, so it can be collapsed. Never saved. */
  expansions: Record<string, string[]>
  setNeighbors: (id: string, set: NeighborSet) => void
  recordExpansion: (key: string, ids: string[]) => void
  /** A table's own facts from its relationships response (kind, self-reference, files), for a node that was added as a neighbor. No layout. */
  applyNodeFacts: (node: GraphNode) => void
  /** Takes tables off the graph, with the edges that touch them. */
  removeNodes: (ids: string[]) => void
  /** The saved graph on screen, for live sync with agents. Null for a graph built here and never saved or loaded. */
  openDiagram: OpenDiagram | null
  /** Someone else saved the open graph while the page held unsaved changes: the page asks (Reload or Keep mine). */
  diagramChanged: DiagramRevision | null
  /** A save is in flight: a poll must not take its write for someone else's. */
  diagramSaving: boolean
  setOpenDiagram: (open: OpenDiagram | null) => void
  setDiagramChanged: (remote: DiagramRevision | null) => void
  setDiagramSaving: (saving: boolean) => void
  /** UI only, not saved. The pan and zoom when the Graph view was last hidden, restored when it shows again. */
  viewport: { x: number; y: number; zoom: number } | null
  setViewport: (viewport: { x: number; y: number; zoom: number } | null) => void

  applyNodeChanges: (changes: NodeChange<FlowNode>[]) => void
  applyEdgeChanges: (changes: EdgeChange<FlowEdge>[]) => void
  setStatus: (text: string, error?: boolean) => void
  setSelection: (selection: Selection) => void
  setHover: (id: string | null) => void
  setFilter: (key: keyof EdgeFilters, value: boolean) => void
  /** Changes fields of one edge's info (status, note) after the server accepted the change. */
  updateEdgeInfo: (id: string, patch: Partial<GraphEdge>) => void
  setFocusSchema: (schema: string | null) => void
  setDrawer: (drawer: Drawer) => void
  setColumnsOn: (on: boolean) => void
  setMineDialog: (open: boolean) => void
  setShowConcepts: (show: boolean) => void
  setColorBy: (colorBy: ColorBy) => void
  /** Stores a node's columns and shows them. */
  setColumns: (id: string, columns: ColumnInfo[]) => void
  setShowColumns: (id: string, show: boolean) => void
  /** Marks a node as added on purpose, so the edge filters never hide it. */
  pinNode: (id: string) => void
  setAllColumns: (id: string, all: boolean) => void
  /** Adds column edges, or replaces the ones with the same id (fresh status, note, evidence). */
  mergeColumnEdges: (edges: GraphEdge[]) => void
  /** Adds the nodes and edges of one relationships response. Existing nodes and edges stay in place, but an edge already on screen takes the fresh info (status, note, evidence). */
  mergeRelations: (resp: RelationsResponse) => void
  clear: () => void
  requestLayout: (scope?: string[]) => void
  /** requestLayout after React Flow has measured the nodes whose size just changed. */
  requestLayoutSoon: (scope?: string[]) => void
  runLayout: () => Promise<void>
  finishFit: () => void
  loadDiagram: (payload: DiagramPayload) => void
}

/** What a change to the grouping asks for: the graph laid out again from scratch, since nodes came or went. */
const RELAYOUT = { layoutPending: true, layoutFresh: true, layoutScope: null } as const

/** The nodes an earlier layout (or a saved diagram) positioned: the next layout keeps their order. */
const placedIds = new Set<string>()
let layoutRunning = false
/** Bumped when the graph changes under a layout that is running (lens switch, diagram loaded or cleared, trace cleared): that layout's result is dropped. */
let layoutEpoch = 0
const soonTimers = new Set<ReturnType<typeof setTimeout>>()

/** Drops the layout that is running and the ones waiting on a timer, for a change that puts the nodes where they should stand. */
export function cancelLayouts(): void {
  layoutEpoch++
  dropSoonLayouts()
}

/** Drops the layouts waiting on a timer (a lens switch that keeps its positions does not want the ones its column change queued). */
export function dropSoonLayouts(): void {
  for (const t of soonTimers) clearTimeout(t)
  soonTimers.clear()
}

export const useGraphStore = create<GraphState>()((set, get) => ({
  nodes: [],
  edges: [],
  columnEdges: [],
  drawer: null,
  columnsOn: false,
  mineDialog: false,
  showConcepts: false,
  colorBy: 'type',
  focusSchema: null,
  selection: null,
  hoverId: null,
  filters: DEFAULT_FILTERS,
  status: { text: '', error: false },
  layoutPending: false,
  layoutScope: null,
  layoutFresh: false,
  fitPending: false,
  viewport: null,
  neighbors: {},
  expansions: {},
  grouping: DEFAULT_GROUPING,
  groupPositions: {},
  groupTags: {},
  lens: DEFAULT_LENS,
  lensPositions: {},
  columnsRequest: null,
  lensHold: false,
  setLens: (lens) => {
    const s = get()
    if (lens === s.lens) return
    layoutEpoch++ // a layout in flight was for the other lens
    // The positions of the lens that was showing wait; the new lens takes back its own, for the tables that have one.
    const waiting: LensPositions = { ...s.lensPositions, [s.lens]: Object.fromEntries(s.nodes.map((n) => [n.id, { ...n.position }])) }
    const saved = waiting[lens] ?? {}
    delete waiting[lens]
    const known = s.nodes.filter((n) => saved[n.id]).map((n) => n.id)
    const missing = s.nodes.filter((n) => !saved[n.id]).map((n) => n.id)
    for (const id of known) placedIds.add(id)
    set({
      lens,
      lensPositions: waiting,
      filters: { ...s.filters, ...presetFilters(lens) },
      nodes: s.nodes.map((n) => (saved[n.id] ? { ...n, position: { ...saved[n.id] } } : n)),
      columnsRequest: LENS_COLUMNS[lens],
      lensHold: known.length > 0 && missing.length === 0,
      fitPending: true,
      layoutPending: known.length === 0 || missing.length > 0,
      // Tables the lens has no place for: the Model lens lays everything out again, the others only the parts those tables are in.
      layoutFresh: known.length === 0 || (lens === 'model' && missing.length > 0),
      layoutScope: known.length > 0 && lens !== 'model' && missing.length > 0 ? missing : null,
    })
  },
  resetLens: () => set((s) => ({ filters: { ...s.filters, ...presetFilters(s.lens) } })),
  finishLensColumns: () => set({ columnsRequest: null, lensHold: false }),
  setGroupBy: (by) => set((s) => ({ grouping: { ...s.grouping, by, overrides: {} }, ...RELAYOUT })),
  setGroupCollapsed: (key, collapsed) =>
    set((s) => {
      const overrides = { ...s.grouping.overrides }
      if (collapsed === undefined) delete overrides[key]
      else overrides[key] = collapsed
      return { grouping: { ...s.grouping, overrides }, ...RELAYOUT }
    }),
  setGroupsCollapsed: (keys, collapsed) =>
    set((s) => ({ grouping: { ...s.grouping, overrides: { ...s.grouping.overrides, ...Object.fromEntries(keys.map((k) => [k, collapsed])) } }, ...RELAYOUT })),
  setChains: (chains) => set((s) => ({ grouping: { ...s.grouping, chains, shownChains: [] }, ...RELAYOUT })),
  showChain: (id) => set((s) => ({ grouping: { ...s.grouping, shownChains: [...new Set([...s.grouping.shownChains, id])] }, selection: null, ...RELAYOUT })),
  setGroupPosition: (key, position) => set((s) => ({ groupPositions: { ...s.groupPositions, [key]: position } })),
  setGroupTags: (groupTags) => set({ groupTags, ...(get().grouping.by.startsWith('tag:') ? RELAYOUT : {}) }),
  setNeighbors: (id, found) => set({ neighbors: { ...get().neighbors, [id]: found } }),
  recordExpansion: (key, ids) => set({ expansions: { ...get().expansions, [key]: [...new Set([...(get().expansions[key] ?? []), ...ids])] } }),
  applyNodeFacts: (fact) =>
    set((s) => ({
      nodes: s.nodes.map((n) =>
        n.id !== fact.id
          ? n
          : {
              ...n,
              data: {
                ...n.data,
                kind: fact.kind,
                ...(fact.self_ref ? { selfRef: true, selfRefLastSeen: fact.self_ref_last_seen, selfRefFks: fact.self_ref_fks } : {}),
                ...(fact.files ? { files: fact.files } : {}),
              },
            },
      ),
    })),
  removeNodes: (ids) =>
    set((s) => {
      const gone = new Set(ids)
      const touches = (e: FlowEdge) => gone.has(e.source) || gone.has(e.target)
      return {
        nodes: s.nodes.filter((n) => !gone.has(n.id)),
        edges: s.edges.filter((e) => !touches(e)),
        columnEdges: s.columnEdges.filter((e) => !touches(e)),
        selection: s.selection?.kind === 'node' && gone.has(s.selection.id) ? null : s.selection,
        layoutPending: true,
      }
    }),
  setViewport: (viewport) => set({ viewport }),
  openDiagram: null,
  diagramChanged: null,
  diagramSaving: false,
  setOpenDiagram: (openDiagram) => set({ openDiagram, diagramChanged: null }),
  setDiagramChanged: (diagramChanged) => set({ diagramChanged }),
  setDiagramSaving: (diagramSaving) => set({ diagramSaving }),

  applyNodeChanges: (changes) => set({ nodes: applyNodeChanges(changes, get().nodes) }),
  applyEdgeChanges: (changes) => set({ edges: applyEdgeChanges(changes, get().edges) }),
  setStatus: (text, error = false) => set({ status: { text, error } }),
  setSelection: (selection) => set({ selection }),
  setHover: (hoverId) => set({ hoverId }),
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
  setColorBy: (colorBy) => set({ colorBy }),
  setColumns: (id, columns) =>
    set((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, columns, showColumns: true } } : n)),
    })),
  setShowColumns: (id, show) =>
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, showColumns: show } } : n)) })),
  pinNode: (id) =>
    set((s) => ({ nodes: s.nodes.map((n) => (n.id === id && !n.data.pinned ? { ...n, data: { ...n.data, pinned: true } } : n)) })),
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
          // The object's own response knows its kind. A neighbor's was a guess, however well it was resolved.
          if (n.focus) nodes[idx] = { ...nodes[idx], data: { ...nodes[idx].data, kind: n.kind } }
          if (n.missing) {
            nodes[idx] = {
              ...nodes[idx],
              data: { ...nodes[idx].data, missing: true, missingReason: n.missing_reason, renamedTo: n.renamed_to },
            }
          }
          if (n.self_ref) {
            nodes[idx] = {
              ...nodes[idx],
              data: { ...nodes[idx].data, selfRef: true, selfRefLastSeen: n.self_ref_last_seen, selfRefFks: n.self_ref_fks },
            }
          }
          if (n.files) nodes[idx] = { ...nodes[idx], data: { ...nodes[idx].data, files: n.files } }
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
            selfRefFks: n.self_ref_fks,
            files: n.files,
            ...(n.missing ? { missing: true, missingReason: n.missing_reason, renamedTo: n.renamed_to } : null),
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
      return { nodes, edges, layoutPending: true, layoutScope: null }
    }),

  clear: () => {
    placedIds.clear()
    cancelLayouts()
    set({
      nodes: [],
      edges: [],
      columnEdges: [],
      selection: null,
      hoverId: null,
      layoutPending: false,
      fitPending: false,
      viewport: null,
      neighbors: {},
      expansions: {},
      grouping: DEFAULT_GROUPING,
      groupPositions: {},
      groupTags: {},
      lens: DEFAULT_LENS,
      lensPositions: {},
      columnsRequest: null,
      lensHold: false,
      ...(get().lens !== DEFAULT_LENS ? { filters: { ...get().filters, ...presetFilters(DEFAULT_LENS) } } : {}),
      openDiagram: null,
      diagramChanged: null,
    })
  },

  requestLayout: (scope) =>
    set((s) =>
      s.lensHold
        ? {}
        : {
            layoutPending: true,
            layoutFresh: s.layoutFresh || !scope,
            layoutScope: scope && (!s.layoutPending || s.layoutScope) ? [...(s.layoutScope ?? []), ...scope] : null,
          },
    ),
  requestLayoutSoon: (scope) => {
    const timer = setTimeout(() => {
      soonTimers.delete(timer)
      useGraphStore.getState().requestLayout(scope)
    }, 250)
    soonTimers.add(timer)
  },

  runLayout: async () => {
    // One layout at a time: a call made while one runs is dropped, and the request it carried stays pending.
    if (layoutRunning) return
    layoutRunning = true
    try {
      const s = get()
      const epoch = layoutEpoch
      const fresh = s.layoutFresh
      const { nodes: laid, links } = layoutInput(s, fresh ? new Set() : placedIds)
      const stamp = (g: typeof s) => g.nodes.map((n) => n.id).join('|') + '#' + groupingSignature(g.grouping) + g.grouping.shownChains.join()
      const scope = s.layoutScope
      // A level change only moves the parts of the graph it touches, and leaves the view where it is, unless they would then overlap.
      // The Model lens lays out only the tables a reference edge shows, by its own rules (graph/modelLayout.ts).
      const model = s.lens === 'model' ? ({ lens: 'model' } as const) : undefined
      const layNodes = model ? laid.filter((n) => !n.hidden) : laid
      const layLinks = model ? links.filter((l) => !l.hidden && familyOf(l.kind as GraphEdgeKind) === 'reference') : links
      const scoped = scope ? await computeScopedLayout(layNodes, layLinks, scope, model) : null
      const positions = scoped ?? (await computeLayout(layNodes, layLinks, model))
      if (epoch !== layoutEpoch) {
        // The graph changed under this layout (see cancelLayouts): its positions are for something else. A request made since stays pending,
        // and the new node array wakes the page's effect that runs it.
        if (get().layoutPending) set((now) => ({ nodes: [...now.nodes] }))
        return
      }
      for (const id of positions.keys()) placedIds.add(id)
      set((now) => {
        // Nodes added or a new scope requested while this ran: the positions still apply, and another layout follows.
        const settled = stamp(now) === stamp(s) && now.layoutScope === scope
        return {
          layoutScope: settled ? null : now.layoutScope,
          fitPending: !scoped,
          layoutFresh: settled ? false : now.layoutFresh,
          groupPositions: { ...now.groupPositions, ...Object.fromEntries([...positions].filter(([id]) => id.startsWith('summary:')).map(([id, p]) => [id.slice('summary:'.length), p])) },
          nodes: now.nodes.map((n) => {
            const p = positions.get(n.id)
            return p ? { ...n, position: p } : n
          }),
          layoutPending: !settled,
        }
      })
    } finally {
      layoutRunning = false
    }
  },

  finishFit: () => set({ fitPending: false }),

  loadDiagram: (payload) => {
    placedIds.clear()
    cancelLayouts()
    for (const n of payload.nodes) placedIds.add(n.id)
    // A graph saved in a lens opens in it: the lens's filters, and its column level once the lens switch has set it. Positions kept from before stay.
    const lens = payload.lens ?? DEFAULT_LENS
    const lensChanged = lens !== get().lens
    const columnsRequest = lens === DEFAULT_LENS && !lensChanged ? null : LENS_COLUMNS[lens]
    set({
      lens,
      lensPositions: payload.lensPositions ?? {},
      ...(lens !== DEFAULT_LENS || lensChanged ? { filters: { ...get().filters, ...presetFilters(lens) } } : {}),
      columnsRequest,
      lensHold: columnsRequest !== null,
      nodes: payload.nodes,
      edges: payload.edges,
      columnEdges: [],
      expansions: {},
      focusSchema: payload.focusSchema,
      colorBy: payload.colorBy ?? 'type',
      grouping: payload.grouping ?? DEFAULT_GROUPING,
      groupPositions: {},
      selection: null,
      hoverId: null,
      layoutPending: false,
      fitPending: true,
    })
    // A collapsed group has no saved place: lay the graph out so its node gets one.
    const { grouping, nodes, edges, filters } = get()
    if (collapseGraph({ nodes, edges, filters, grouping, groupTags: {} }).groups.some((g) => g.collapsed)) set({ layoutPending: true, layoutFresh: true })
  },
}))
