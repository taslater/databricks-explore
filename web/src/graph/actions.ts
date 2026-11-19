// Graph actions that talk to the server: expand a node, open an object, refresh the selected node, connect two tables.
import { useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import * as api from '../api/client'
import { DEFAULT_TABLE_SIZE, useCanvasStore } from '../store/canvasStore'
import { useSketchStore } from '../sketch/sketchStore'
import { useUiStore } from '../store/uiStore'
import type { CanvasConnector, CanvasWindow, GraphEdge } from '../api/types'
import { schemaOf } from './format'
import { useGraphStore } from './graphStore'
import { columnLevel, columnsOf } from './columns'
import { runColumns } from './columnsRun'
import { isPlaceholder } from './format'
import { openSqlInCanvas } from '../ask/canvasAction'
import { JOIN_KEYS_STALE_MS } from '../api/hooks'
import { joinSql, planJoins } from './joinQuery'
import { newTableIds } from './columns'
import { patchIds, toColumnEdges, toRelations } from './relationships'
import { edgeShown } from './derive'
import { makeExpansion } from './expansion'
import { neighborSet } from './neighbors'
import { lineagePath, pathConnectors, planSend, sendSummary, type PathDirection } from './sendSelection'

export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * The server's current version of an edge on screen (status, note, provenance), or undefined when it is gone.
 * An edge restored from a saved diagram carries whatever note it had when saved, or none at all, so the
 * details panel reads this before it lets the user edit. The edge is looked up from either end, because
 * a view dependency only shows up when its view is read.
 */
export async function fetchCurrentEdge(info: GraphEdge): Promise<GraphEdge | undefined> {
  if (info.source_column) {
    // A column edge is only in the column-level response.
    for (const table of [info.source, info.target]) {
      const found = toColumnEdges(await api.getRelationships(table, false, 'column')).find((e) => e.id === info.id)
      if (found) return found
    }
    return undefined
  }
  for (const table of [info.source, info.target]) {
    const found = toRelations(await api.getRelationships(table)).edges.find((e) => e.id === info.id)
    if (found) return found
  }
  return undefined
}

/** Gap between the right edge of the canvas content and a block of cards sent from the graph. */
const SEND_GAP = 40

/** Top-left of a block of cards sent from the graph: right of every window, level with the top of the content. */
export function sendOrigin(windows: ReadonlyArray<Pick<CanvasWindow, 'position' | 'size'>>): { x: number; y: number } {
  if (windows.length === 0) return { x: 0, y: 0 }
  return {
    x: Math.max(...windows.map((w) => w.position.x + w.size.w)) + SEND_GAP,
    y: Math.min(...windows.map((w) => w.position.y)),
  }
}

/** Shared by the graph actions and the picker so they use the same query cache. */
export function useGraphActions() {
  const qc = useQueryClient()

  return useMemo(() => {
    const expansion = makeExpansion(qc, columnsForArrivals)
    /**
     * Loads /api/relationships for one object (derived edges plus stored ones) and merges it into the graph.
     * `refresh` forces a Databricks re-read of the derived part.
     */
    async function expand(name: string, refresh = false) {
      const store = useGraphStore.getState()
      const gone = store.nodes.find((n) => n.id === name)?.data
      if (gone?.missing) {
        // Nothing to read: say so, plainly, without the error styling.
        store.setStatus(`${name} does not exist${gone.missingReason ? ` (${gone.missingReason})` : ''}`)
        return
      }
      store.setStatus(`loading ${name}…`)
      try {
        const profile = useUiStore.getState().connectedProfile
        const resp = toRelations(
          await qc.fetchQuery({
            queryKey: ['relationships', profile, name],
            queryFn: () => api.getRelationships(name, refresh),
            staleTime: 0,
            retry: false,
          }),
        )
        const before = useGraphStore.getState().nodes.map((n) => n.id)
        useGraphStore.getState().mergeRelations(resp)
        useGraphStore.getState().setNeighbors(name, neighborSet(resp, name))
        // Errors stay visible. The legacy UI overwrote them with "loaded".
        if (resp.errors.length) useGraphStore.getState().setStatus(resp.errors.join(' | '), true)
        else useGraphStore.getState().setStatus(`loaded ${name}`)
        // With Show columns on, a node that arrives later shows its columns too.
        const arrived = newTableIds(useGraphStore.getState().columnsOn, before, useGraphStore.getState().nodes)
        if (arrived.length > 0) void showColumnsOf(arrived)
      } catch (e) {
        useGraphStore.getState().setStatus(messageOf(e), true)
      }
    }

    /** Columns for the tables that arrived since `before`, when Show columns is on. */
    function columnsForArrivals(before: string[]) {
      const arrived = newTableIds(useGraphStore.getState().columnsOn, before, useGraphStore.getState().nodes)
      if (arrived.length > 0) void showColumnsOf(arrived)
    }

    /** Starts a new graph centered on one object. */
    function openObject(fullName: string) {
      const g = useGraphStore.getState()
      g.setFocusSchema(schemaOf(fullName))
      g.clear()
      void expand(fullName)
    }

    /**
     * Adds one object to the graph without clearing it, with its connections, and selects it. Its edges to tables
     * already on screen are drawn, so two unrelated objects can sit side by side. The node is pinned: the edge
     * filters never hide it. On an empty graph this is the same as opening the object.
     */
    async function addObject(fullName: string) {
      if (useGraphStore.getState().nodes.length === 0) {
        openObject(fullName)
        return
      }
      const had = useGraphStore.getState().nodes.some((n) => n.id === fullName)
      await expand(fullName)
      const g = useGraphStore.getState()
      if (!g.nodes.some((n) => n.id === fullName)) return
      g.pinNode(fullName)
      g.setSelection({ kind: 'node', id: fullName })
      if (!g.status.error) g.setStatus(had ? `${fullName} is already on the graph; loaded its connections` : `added ${fullName}`)
    }

    function refreshSelected() {
      const sel = useGraphStore.getState().selection
      if (sel?.kind === 'node') void expand(sel.id, true)
    }

    /**
     * Drag from one table node to another: stores a `manual` edge, then re-reads the source table so
     * the edge appears (or comes back, if it had been rejected) and selects it.
     */
    async function connect(source: string, target: string) {
      if (source === target) return
      const store = useGraphStore.getState()
      store.setStatus(`connecting ${source} to ${target}…`)
      try {
        const created = await api.createRelationship({ source: { table: source }, target: { table: target } })
        await expand(source)
        const g = useGraphStore.getState()
        const shown = g.edges.find((e) => patchIds(e.data!.info).includes(created.id))
        if (shown) g.setSelection({ kind: 'edge', id: shown.id })
        g.setStatus(`added a manual edge from ${source} to ${target}`)
      } catch (e) {
        useGraphStore.getState().setStatus(messageOf(e), true)
      }
    }

    /** Waits for React Flow to measure the nodes whose size just changed, then lays out again the parts of the graph they are in (all of it with no ids). */
    function relayoutSoon(ids?: string[]) {
      useGraphStore.getState().requestLayoutSoon(ids)
    }

    /**
     * Shows a node's columns: loads them (tables.get, cached) and the column-level edges for the table
     * (column lineage from one cached warehouse query, FKs, mined and manual column edges).
     * A failure to read column lineage is shown in the status line and the columns still show.
     */
    async function showColumns(id: string) {
      if (isPlaceholder(id)) return
      const store = useGraphStore.getState()
      const node = store.nodes.find((n) => n.id === id)
      if (!node) return
      if (node.data.columns) store.setShowColumns(id, true)
      store.setStatus(`loading columns of ${id}…`)
      try {
        const profile = useUiStore.getState().connectedProfile
        if (!node.data.columns) {
          const obj = await qc.fetchQuery({
            queryKey: ['object', profile, id],
            queryFn: () => api.getObject(id),
            staleTime: 60_000,
            retry: false,
          })
          useGraphStore.getState().setColumns(id, columnsOf(obj.data))
        }
        const resp = await qc.fetchQuery({
          queryKey: ['relationships', profile, id, 'column'],
          queryFn: () => api.getRelationships(id, false, 'column'),
          staleTime: 0,
          retry: false,
        })
        useGraphStore.getState().mergeColumnEdges(toColumnEdges(resp))
        if (resp.errors.length) useGraphStore.getState().setStatus(resp.errors.join(' | '), true)
        else useGraphStore.getState().setStatus(`showing columns of ${id}`)
      } catch (e) {
        useGraphStore.getState().setStatus(messageOf(e), true)
      }
      relayoutSoon([id])
    }

    function hideColumns(id: string) {
      useGraphStore.getState().setShowColumns(id, false)
      relayoutSoon([id])
    }

    /** A node's column level one step on: none, keys, all, none. The level shows on the node's button. */
    function cycleColumns(id: string) {
      const g = useGraphStore.getState()
      const node = g.nodes.find((n) => n.id === id)
      if (!node) return
      const level = columnLevel(node.data)
      if (level === 'none') {
        g.setAllColumns(id, false)
        void showColumns(id)
      } else if (level === 'keys') {
        g.setAllColumns(id, true)
        relayoutSoon([id])
      } else {
        g.setAllColumns(id, false)
        hideColumns(id)
      }
    }

    /** Columns on several nodes, one after another: each can mean a warehouse query. */
    async function showColumnsOf(ids: string[]) {
      for (const id of ids) await showColumns(id)
    }

    /** The keys level on every table node, or columns off for all. The choice stays on for nodes added later. */
    async function setAllColumns(show: boolean, stop?: () => boolean) {
      useGraphStore.getState().setColumnsOn(show)
      await runColumns({
        show,
        ids: () => useGraphStore.getState().nodes.filter((n) => !isPlaceholder(n.id)).map((n) => n.id),
        reset: (id) => useGraphStore.getState().setAllColumns(id, false),
        load: showColumns,
        hide: (id) => useGraphStore.getState().setShowColumns(id, false),
        stop,
      })
      if (!stop?.()) relayoutSoon()
    }

    /** Re-reads everything on screen: table edges for every node, column edges for the ones showing columns. */
    async function refreshGraph() {
      const nodes = useGraphStore.getState().nodes.slice(0, 40)
      for (const n of nodes) await expand(n.id)
      for (const n of nodes) if (n.data.showColumns) await showColumns(n.id)
    }

    /**
     * Brings one stored column edge (a suggestion) into view: both tables, their columns, and selects the edge.
     * Needs the edge's table-level neighbors loaded, which expanding either end does.
     */
    async function showColumnEdge(source: string, target: string, edgeId: string) {
      const g = useGraphStore.getState()
      if (g.nodes.length === 0) g.setFocusSchema(schemaOf(source))
      await expand(source)
      await expand(target)
      await showColumns(source)
      await showColumns(target)
      const after = useGraphStore.getState()
      if (after.columnEdges.some((e) => e.id === edgeId)) after.setSelection({ kind: 'edge', id: edgeId })
    }

    /**
     * Writes a SELECT that joins the given tables along known relationships (through other tables if need be) and
     * adds it to the Canvas as a new query window. When no chain of relationships joins them it says so and writes nothing.
     */
    async function queryTables(ids: string[]) {
      const store = useGraphStore.getState()
      const tables = ids.filter((id) => !isPlaceholder(id) && !id.startsWith('concept:'))
      if (tables.length === 0) {
        store.setStatus('Select at least one table', true)
        return
      }
      store.setStatus('looking for join paths…')
      try {
        const profile = useUiStore.getState().connectedProfile
        const plan = await planJoins(tables, (t) =>
          qc
            .fetchQuery({
              queryKey: ['joinKeys', profile, t],
              queryFn: () => api.getJoinKeys(t),
              staleTime: JOIN_KEYS_STALE_MS,
              retry: false,
            })
            .then((r) => r.joins),
        )
        if (!plan.ok) {
          useGraphStore.getState().setStatus(plan.message, true)
          return
        }
        openSqlInCanvas(joinSql(plan))
        const extra = plan.added.length ? `, adding ${plan.added.map((t) => t.split('.').pop()).join(', ')}` : ''
        useGraphStore.getState().setStatus(`Wrote a query for ${tables.length} table${tables.length === 1 ? '' : 's'}${extra}`)
      } catch (e) {
        useGraphStore.getState().setStatus(messageOf(e), true)
      }
    }

    /**
     * Sends tables to the Canvas as cards laid out left to right by dependency, with a connector for each known
     * relationship among them (foreign keys, mined and manual joins, lineage and view dependencies, labeled as the
     * MCP tool connect_known labels them). A table that already has a card gets none; connectors still reach it.
     * `fallback` is drawn when the server cannot plan the connectors. The Canvas tab need not be open.
     */
    async function sendTables(ids: string[], fallback: CanvasConnector[] = []) {
      const tables = ids.filter((id) => !isPlaceholder(id) && !id.startsWith('concept:'))
      if (tables.length === 0) {
        useGraphStore.getState().setStatus('Select at least one table', true)
        return
      }
      let connectors = fallback
      let proposed = 0
      let warning = ''
      if (tables.length > 1) {
        useGraphStore.getState().setStatus('reading relationships…')
        try {
          const resp = await api.getConnectors(tables)
          connectors = resp.connectors
          proposed = resp.skipped.proposed
        } catch (e) {
          warning = `; could not read the relationships (${messageOf(e)})`
        }
      }
      const canvas = useCanvasStore.getState()
      const have = new Set(canvas.windows.filter((w) => w.type === 'table' && w.table).map((w) => w.table!.toLowerCase()))
      const plan = planSend(tables, have, connectors, sendOrigin([...canvas.windows, ...useSketchStore.getState().nodes]), DEFAULT_TABLE_SIZE)
      const added = canvas.addTableWindowsAt(plan.cards)
      const cardOf = new Map<string, string>()
      for (const w of useCanvasStore.getState().windows) {
        if (w.type === 'table' && w.table && !cardOf.has(w.table.toLowerCase())) cardOf.set(w.table.toLowerCase(), w.id)
      }
      for (const [table, id] of Object.entries(added)) cardOf.set(table.toLowerCase(), id)
      const specs = plan.links.flatMap((c) => {
        const source = cardOf.get(c.source.toLowerCase())
        const target = cardOf.get(c.target.toLowerCase())
        return source && target
          ? [{ source, target, label: c.label || undefined, directed: c.directed, bidir: c.bidir, dashed: c.proposed }]
          : []
      })
      const drawn = useSketchStore.getState().addEdges(specs)
      useGraphStore.getState().setStatus(sendSummary(plan, drawn, { proposed }) + warning, warning !== '')
    }

    /** Sends the chain of lineage and view dependencies the graph shows from one table, downstream or upstream. */
    async function sendPath(id: string, direction: PathDirection) {
      const g = useGraphStore.getState()
      const shown = g.edges.map((e) => e.data!.info).filter((info) => edgeShown(info, g.filters))
      const path = lineagePath(id, direction, shown)
      if (path.tables.length === 1) {
        g.setStatus(
          `No ${direction} lineage from ${id.split('.').pop()} on the graph. Double-click a node to load its neighbors first.`,
          true,
        )
        return
      }
      await sendTables(path.tables, pathConnectors(path.edges))
    }

    return {
      ...expansion,
      sendTables,
      sendPath,
      queryTables,
      expand,
      openObject,
      addObject,
      refreshSelected,
      connect,
      showColumns,
      hideColumns,
      cycleColumns,
      setAllColumns,
      refreshGraph,
      showColumnEdge,
    }
  }, [qc])
}
