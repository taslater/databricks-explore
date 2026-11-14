// The sketch store: sketch nodes, connectors, selection, the active tool, undo history and the clipboard.
// `createSketchStore()` makes an independent store, so a second host (the Graph tab, later) gets its own.
// The Canvas uses the shared instance `useSketchStore`. Everything the host owns (query windows, notes,
// table cards) is reached through the `SketchHost` set with `setHost`, never imported from here.
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import {
  align as alignItems,
  copyClip,
  defaultEdge,
  distribute as distributeItems,
  GRID,
  newSketchNode,
  nextId,
  pasteClip,
  reorder as reorderItems,
  reverseEdge,
  snapPoint,
  snapSize,
  toItems,
  toolToNode,
  type AlignMode,
  type Clip,
  type DistributeAxis,
  type OrderOp,
} from './model'
import * as history from './history'
import type {
  Geometry,
  PlaceholderSpec,
  Point,
  ShapeKind,
  Side,
  Size,
  SketchEdge,
  SketchHost,
  SketchNode,
  SketchType,
  Tool,
} from './types'
import { EMPTY_HOST } from './types'

export type EdgeStyle = Pick<SketchEdge, 'line' | 'arrow_start' | 'arrow_end' | 'dashed' | 'color'>

export interface ConnectionLike {
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

export interface SketchState {
  nodes: SketchNode[]
  edges: SketchEdge[]
  /** Ids of the selected nodes, sketch and host alike. */
  selectedIds: string[]
  selectedEdgeIds: string[]
  tool: Tool
  /** The node whose label is being edited inline, or null. */
  editingId: string | null
  /** The connector whose label is being edited inline, or null. */
  editingEdgeId: string | null
  snap: boolean
  host: SketchHost
  history: history.History
  clipboard: Clip | null
  pasteCount: number
  /** Style the next connector starts with: whatever the user last chose. */
  edgeStyle: EdgeStyle

  setHost: (host: SketchHost) => void
  /** Replaces the sketch content (used by Open and New). Clears selection and history. */
  load: (nodes: SketchNode[], edges: SketchEdge[]) => void
  setTool: (tool: Tool) => void
  setSnap: (snap: boolean) => void
  select: (ids: string[], edgeIds?: string[]) => void
  selectAll: () => void
  setEditing: (id: string | null) => void
  setEditingEdge: (id: string | null) => void

  /** Records the current state as an undo step. Same-key calls in quick succession make one step. */
  checkpoint: (key?: string) => void
  undo: () => void
  redo: () => void

  /** Adds a node, selects it and returns its id. `size` overrides the default size (a drawn rectangle). */
  addNode: (type: SketchType, position: Point, opts?: { shape?: ShapeKind; size?: Size }) => string
  /** Places the node for a placing tool, or returns null for a tool that places nothing. */
  placeTool: (tool: Tool, position: Point, size?: Size) => string | null
  updateNode: (id: string, patch: Partial<SketchNode>, key?: string) => void
  /** Changes every selected sketch node. Locked ones are skipped unless the patch only changes `locked`. */
  updateSelected: (patch: Partial<SketchNode>, key?: string) => void
  setLabel: (id: string, label: string) => void
  updatePlaceholder: (id: string, update: (spec: PlaceholderSpec) => PlaceholderSpec, key?: string) => void
  /** Moves sketch and host nodes. Does not record history: call checkpoint when the gesture starts. */
  moveItems: (positions: Record<string, Point>) => void
  resizeNode: (id: string, position: Point, size: Size) => void
  /** Records a placeholder's measured height so alignment and export know it. No history. */
  syncHeight: (id: string, h: number) => void

  connect: (conn: ConnectionLike) => string | null
  updateEdge: (id: string, patch: Partial<SketchEdge>, key?: string) => void
  reverseEdge: (id: string) => void
  /** Records that a connector was saved to the relationship store (or no longer is). Not an undo step. */
  markRelationship: (id: string, relationship: SketchEdge['relationship']) => void
  reconnect: (id: string, conn: ConnectionLike) => void
  setEdgeLabel: (id: string, label: string) => void
  /** Removes connectors whose ends are no longer on the canvas. No history. */
  prune: (hostIds: Iterable<string>) => void

  removeSelection: () => void
  copySelection: () => void
  paste: () => void
  duplicate: () => void
  nudge: (dx: number, dy: number) => void
  align: (mode: AlignMode) => void
  distribute: (axis: DistributeAxis) => void
  reorder: (op: OrderOp) => void
  toggleLock: () => void
}

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    // Storage can be unavailable. The choice still applies for this session.
  }
}

export const DEFAULT_EDGE_STYLE: EdgeStyle = { line: 'step', arrow_start: false, arrow_end: true, dashed: false }

const STYLE_KEYS: (keyof EdgeStyle)[] = ['line', 'arrow_start', 'arrow_end', 'dashed', 'color']

function sideOf(h: string | null | undefined): Side | undefined {
  return h === 't' || h === 'r' || h === 'b' || h === 'l' ? h : undefined
}

export function createSketchStore(): UseBoundStore<StoreApi<SketchState>> {
  return create<SketchState>()((set, get) => {
    function snapshot(): history.Snapshot {
      const { nodes, edges, host } = get()
      const hostGeo: history.Snapshot['host'] = {}
      for (const h of host.nodes()) {
        hostGeo[h.id] = { position: { ...h.position }, size: { ...h.size }, z: h.z, locked: h.locked }
      }
      return { nodes, edges, host: hostGeo }
    }

    function restore(snap: history.Snapshot) {
      const { host, selectedIds, selectedEdgeIds } = get()
      const patches: Record<string, Partial<Geometry> & { locked?: boolean }> = {}
      for (const h of host.nodes()) {
        const g = snap.host[h.id]
        if (g) patches[h.id] = { position: g.position, size: g.size, z: g.z, locked: g.locked }
      }
      host.patch(patches)
      const have = new Set([...snap.nodes.map((n) => n.id), ...host.nodes().map((h) => h.id)])
      const edgeIds = new Set(snap.edges.map((e) => e.id))
      set({
        nodes: snap.nodes,
        edges: snap.edges,
        selectedIds: selectedIds.filter((i) => have.has(i)),
        selectedEdgeIds: selectedEdgeIds.filter((i) => edgeIds.has(i)),
        editingId: null,
        editingEdgeId: null,
      })
    }

    function checkpoint(key?: string) {
      set({ history: history.push(get().history, snapshot(), key ?? null) })
    }

    function allIds(): string[] {
      return [...get().nodes.map((n) => n.id), ...get().host.nodes().map((h) => h.id)]
    }

    function mapNode(id: string, fn: (n: SketchNode) => SketchNode): SketchNode[] {
      return get().nodes.map((n) => (n.id === id ? fn(n) : n))
    }

    /** Applies positions to sketch nodes and to host nodes. */
    function applyPositions(positions: Record<string, Point>) {
      const { nodes, host } = get()
      const own = new Set(nodes.map((n) => n.id))
      const hostPatches: Record<string, Partial<Geometry>> = {}
      for (const [id, p] of Object.entries(positions)) {
        if (!own.has(id)) hostPatches[id] = { position: { x: p.x, y: p.y } }
      }
      set({ nodes: nodes.map((n) => (positions[n.id] ? { ...n, position: { x: positions[n.id].x, y: positions[n.id].y } } : n)) })
      if (Object.keys(hostPatches).length > 0) host.patch(hostPatches)
    }

    function applyZ(z: Record<string, number>) {
      const { nodes, host } = get()
      const own = new Set(nodes.map((n) => n.id))
      const hostPatches: Record<string, Partial<Geometry>> = {}
      for (const [id, v] of Object.entries(z)) if (!own.has(id)) hostPatches[id] = { z: v }
      set({ nodes: nodes.map((n) => (n.id in z ? { ...n, z: z[n.id] } : n)) })
      if (Object.keys(hostPatches).length > 0) host.patch(hostPatches)
    }

    return {
      nodes: [],
      edges: [],
      selectedIds: [],
      selectedEdgeIds: [],
      tool: 'select',
      editingId: null,
      editingEdgeId: null,
      snap: readFlag('sketchSnap', true),
      host: EMPTY_HOST,
      history: history.EMPTY_HISTORY,
      clipboard: null,
      pasteCount: 0,
      edgeStyle: DEFAULT_EDGE_STYLE,

      setHost: (host) => set({ host }),

      load: (nodes, edges) =>
        set({
          nodes,
          edges,
          selectedIds: [],
          selectedEdgeIds: [],
          editingId: null,
          editingEdgeId: null,
          history: history.EMPTY_HISTORY,
          tool: 'select',
        }),

      setTool: (tool) => set({ tool, editingId: null, editingEdgeId: null }),

      setSnap: (snap) => {
        writeFlag('sketchSnap', snap)
        set({ snap })
      },

      select: (ids, edgeIds = []) => set({ selectedIds: ids, selectedEdgeIds: edgeIds }),

      selectAll: () => set({ selectedIds: allIds(), selectedEdgeIds: get().edges.map((e) => e.id) }),

      setEditing: (editingId) => set({ editingId, editingEdgeId: null }),
      setEditingEdge: (editingEdgeId) => set({ editingEdgeId, editingId: null }),

      checkpoint,

      undo: () => {
        const r = history.undo(get().history, snapshot())
        if (!r) return
        restore(r.snapshot)
        set({ history: r.history })
      },

      redo: () => {
        const r = history.redo(get().history, snapshot())
        if (!r) return
        restore(r.snapshot)
        set({ history: r.history })
      },

      addNode: (type, position, opts = {}) => {
        checkpoint()
        const id = nextId('s', allIds())
        const { snap, nodes } = get()
        // A drawn size is snapped with its corner. A click places the default size centered on the click.
        const size = opts.size ? (snap ? snapSize(opts.size) : opts.size) : undefined
        const at = snap ? snapPoint(position) : position
        const node = newSketchNode(id, type, at, { shape: opts.shape, size })
        set({
          nodes: [...nodes, node],
          selectedIds: [id],
          selectedEdgeIds: [],
          tool: 'select',
          editingId: type === 'text' ? id : null,
        })
        return id
      },

      placeTool: (tool, position, size) => {
        const spec = toolToNode(tool)
        if (!spec) return null
        return get().addNode(spec.type, position, { shape: spec.shape, size })
      },

      updateNode: (id, patch, key) => {
        checkpoint(key ?? `node:${id}:${Object.keys(patch).join(',')}`)
        set({ nodes: mapNode(id, (n) => ({ ...n, ...patch })) })
      },

      updateSelected: (patch, key) => {
        const { selectedIds, nodes } = get()
        const onlyLock = Object.keys(patch).every((k) => k === 'locked')
        const targets = new Set(
          nodes.filter((n) => selectedIds.includes(n.id) && (onlyLock || !n.locked)).map((n) => n.id),
        )
        if (targets.size === 0) return
        checkpoint(key ?? `sel:${Object.keys(patch).join(',')}`)
        set({ nodes: nodes.map((n) => (targets.has(n.id) ? { ...n, ...patch } : n)) })
      },

      setLabel: (id, label) => {
        const node = get().nodes.find((n) => n.id === id)
        if (!node || (node.label ?? '') === label) return
        checkpoint(`label:${id}`)
        set({ nodes: mapNode(id, (n) => ({ ...n, label })) })
      },

      updatePlaceholder: (id, update, key) => {
        const node = get().nodes.find((n) => n.id === id)
        if (!node?.placeholder) return
        checkpoint(key ?? `ph:${id}`)
        set({ nodes: mapNode(id, (n) => ({ ...n, placeholder: update(n.placeholder as PlaceholderSpec) })) })
      },

      moveItems: (positions) => applyPositions(positions),

      resizeNode: (id, position, size) => {
        const { snap } = get()
        const p = snap ? snapPoint(position) : position
        const s = snap ? snapSize(size) : size
        set({ nodes: mapNode(id, (n) => ({ ...n, position: { x: p.x, y: p.y }, size: { w: s.w, h: s.h } })) })
      },

      syncHeight: (id, h) => {
        const node = get().nodes.find((n) => n.id === id)
        if (!node || Math.abs(node.size.h - h) < 1) return
        set({ nodes: mapNode(id, (n) => ({ ...n, size: { w: n.size.w, h } })) })
      },

      connect: (conn) => {
        if (conn.source === conn.target) return null
        const ids = new Set(allIds())
        if (!ids.has(conn.source) || !ids.has(conn.target)) return null
        checkpoint()
        const id = nextId('c', get().edges.map((e) => e.id))
        const edge = defaultEdge(id, conn.source, conn.target, sideOf(conn.sourceHandle), sideOf(conn.targetHandle), get().edgeStyle)
        set({ edges: [...get().edges, edge], selectedIds: [], selectedEdgeIds: [id], tool: 'select' })
        return id
      },

      updateEdge: (id, patch, key) => {
        checkpoint(key ?? `edge:${id}:${Object.keys(patch).join(',')}`)
        const edgeStyle = { ...get().edgeStyle }
        for (const k of STYLE_KEYS) {
          if (k in patch) (edgeStyle as Record<string, unknown>)[k] = patch[k]
        }
        set({ edges: get().edges.map((e) => (e.id === id ? { ...e, ...patch } : e)), edgeStyle })
      },

      markRelationship: (id, relationship) => {
        set({
          edges: get().edges.map((e) => {
            if (e.id !== id) return e
            const next = { ...e }
            if (relationship && Object.keys(relationship).length > 0) next.relationship = relationship
            else delete next.relationship
            return next
          }),
        })
      },

      reverseEdge: (id) => {
        checkpoint()
        set({ edges: get().edges.map((e) => (e.id === id ? reverseEdge(e) : e)) })
      },

      reconnect: (id, conn) => {
        const edge = get().edges.find((e) => e.id === id)
        if (!edge || conn.source === conn.target) return
        checkpoint()
        const next: SketchEdge = { ...edge, source: conn.source, target: conn.target }
        delete next.source_handle
        delete next.target_handle
        const sh = sideOf(conn.sourceHandle)
        const th = sideOf(conn.targetHandle)
        if (sh) next.source_handle = sh
        if (th) next.target_handle = th
        // Columns belong to the tables at the ends. Keep a side's column only while its table is unchanged.
        if (edge.relationship) {
          const r = { ...edge.relationship }
          if (conn.source !== edge.source) delete r.source_column
          if (conn.target !== edge.target) delete r.target_column
          next.relationship = r
        }
        set({ edges: get().edges.map((e) => (e.id === id ? next : e)) })
      },

      setEdgeLabel: (id, label) => {
        const edge = get().edges.find((e) => e.id === id)
        if (!edge || (edge.label ?? '') === label) return
        checkpoint(`elabel:${id}`)
        const next = { ...edge }
        if (label === '') delete next.label
        else next.label = label
        set({ edges: get().edges.map((e) => (e.id === id ? next : e)) })
      },

      prune: (hostIds) => {
        const have = new Set([...get().nodes.map((n) => n.id), ...hostIds])
        const kept = get().edges.filter((e) => have.has(e.source) && have.has(e.target))
        if (kept.length !== get().edges.length) set({ edges: kept })
      },

      removeSelection: () => {
        const { nodes, edges, selectedIds, selectedEdgeIds, host } = get()
        const dead = new Set(nodes.filter((n) => selectedIds.includes(n.id) && !n.locked).map((n) => n.id))
        const hostDead = host.nodes().filter((h) => selectedIds.includes(h.id) && h.removable && !h.locked).map((h) => h.id)
        for (const id of hostDead) dead.add(id)
        const deadEdges = new Set(selectedEdgeIds)
        if (dead.size === 0 && deadEdges.size === 0) return
        checkpoint()
        if (hostDead.length > 0) host.remove?.(hostDead)
        set({
          nodes: nodes.filter((n) => !dead.has(n.id)),
          edges: edges.filter((e) => !deadEdges.has(e.id) && !dead.has(e.source) && !dead.has(e.target)),
          selectedIds: selectedIds.filter((i) => !dead.has(i)),
          selectedEdgeIds: [],
          editingId: null,
          editingEdgeId: null,
        })
      },

      copySelection: () => {
        const { nodes, edges, selectedIds } = get()
        const clip = copyClip(nodes, edges, new Set(selectedIds))
        if (clip.nodes.length === 0) return
        set({ clipboard: clip, pasteCount: 0 })
      },

      paste: () => {
        const { clipboard, pasteCount, nodes, edges } = get()
        if (!clipboard || clipboard.nodes.length === 0) return
        checkpoint()
        const step = GRID * (pasteCount + 1)
        const made = pasteClip(clipboard, { x: step, y: step }, allIds(), edges.map((e) => e.id))
        set({
          nodes: [...nodes, ...made.nodes],
          edges: [...edges, ...made.edges],
          selectedIds: made.nodes.map((n) => n.id),
          selectedEdgeIds: [],
          pasteCount: pasteCount + 1,
        })
      },

      duplicate: () => {
        const { nodes, edges, selectedIds } = get()
        const clip = copyClip(nodes, edges, new Set(selectedIds))
        if (clip.nodes.length === 0) return
        checkpoint()
        const made = pasteClip(clip, { x: GRID, y: GRID }, allIds(), edges.map((e) => e.id))
        set({
          nodes: [...nodes, ...made.nodes],
          edges: [...edges, ...made.edges],
          selectedIds: made.nodes.map((n) => n.id),
          selectedEdgeIds: [],
        })
      },

      nudge: (dx, dy) => {
        const { selectedIds, nodes, host } = get()
        const items = toItems(nodes, host.nodes()).filter((i) => selectedIds.includes(i.id) && !i.locked)
        if (items.length === 0) return
        checkpoint('nudge')
        applyPositions(Object.fromEntries(items.map((i) => [i.id, { x: i.position.x + dx, y: i.position.y + dy }])))
      },

      align: (mode) => {
        const { selectedIds, nodes, host } = get()
        const moves = alignItems(toItems(nodes, host.nodes()), new Set(selectedIds), mode)
        if (Object.keys(moves).length === 0) return
        checkpoint()
        applyPositions(moves)
      },

      distribute: (axis) => {
        const { selectedIds, nodes, host } = get()
        const moves = distributeItems(toItems(nodes, host.nodes()), new Set(selectedIds), axis)
        if (Object.keys(moves).length === 0) return
        checkpoint()
        applyPositions(moves)
      },

      reorder: (op) => {
        const { selectedIds, nodes, host } = get()
        const z = reorderItems(toItems(nodes, host.nodes()), new Set(selectedIds), op)
        if (Object.keys(z).length === 0) return
        checkpoint()
        applyZ(z)
      },

      toggleLock: () => {
        const { selectedIds, nodes, host } = get()
        const items = toItems(nodes, host.nodes()).filter((i) => selectedIds.includes(i.id))
        if (items.length === 0) return
        const lock = !items.every((i) => i.locked)
        checkpoint()
        const own = new Set(nodes.map((n) => n.id))
        const hostPatches: Record<string, { locked?: boolean }> = {}
        for (const i of items) if (!own.has(i.id)) hostPatches[i.id] = { locked: lock }
        set({ nodes: nodes.map((n) => (selectedIds.includes(n.id) ? { ...n, locked: lock } : n)) })
        if (Object.keys(hostPatches).length > 0) host.patch(hostPatches)
      },
    }
  })
}

/** The store the Canvas uses. */
export const useSketchStore = createSketchStore()
