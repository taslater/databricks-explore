// Graph actions that talk to the server: expand a node, open an object, refresh the selected node, connect two tables.
import { useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import * as api from '../api/client'
import { useCanvasStore } from '../store/canvasStore'
import { useUiStore } from '../store/uiStore'
import type { CanvasWindow, GraphEdge } from '../api/types'
import { schemaOf } from './format'
import { useGraphStore } from './graphStore'
import { columnsOf } from './columns'
import { isPlaceholder } from './format'
import { openSqlInCanvas } from '../ask/canvasAction'
import { JOIN_KEYS_STALE_MS } from '../api/hooks'
import { joinSql, planJoins } from './joinQuery'
import { newTableIds } from './columns'
import { patchIds, toColumnEdges, toRelations } from './relationships'

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

/** Gap between the right edge of the canvas and a card sent from the graph. */
const SEND_GAP = 40

/**
 * Adds a table card for `fullName` to the canvas store. The canvas tab does not need to be open:
 * the store is shared, and the card is there when the Canvas tab is shown. The card goes to the
 * right of the existing windows. A table that already has a card is not added twice.
 * Returns a status line for the graph toolbar.
 */
export function sendToCanvas(fullName: string): string {
  const canvas = useCanvasStore.getState()
  if (canvas.windows.some((w) => w.type === 'table' && w.table === fullName)) {
    return `${fullName} is already on the canvas`
  }
  canvas.addTableWindow(rightOf(canvas.windows), fullName)
  return `Added ${fullName} to the canvas`
}

/** Top-left point to the right of every window, or the origin when the canvas is empty. */
function rightOf(windows: CanvasWindow[]): { x: number; y: number } {
  if (windows.length === 0) return { x: 0, y: 0 }
  const right = Math.max(...windows.map((w) => w.position.x + w.size.w))
  return { x: right + SEND_GAP, y: 0 }
}

/** Shared by the graph actions and the picker so they use the same query cache. */
export function useGraphActions() {
  const qc = useQueryClient()

  return useMemo(() => {
    /**
     * Loads /api/relationships for one object (derived edges plus stored ones) and merges it into the graph.
     * `refresh` forces a Databricks re-read of the derived part.
     */
    async function expand(name: string, refresh = false) {
      const store = useGraphStore.getState()
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

    /** Starts a new graph centered on one object. */
    function openObject(fullName: string) {
      const g = useGraphStore.getState()
      g.setFocusSchema(schemaOf(fullName))
      g.clear()
      void expand(fullName)
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

    /** Waits for React Flow to measure the nodes whose size just changed, then lays the graph out again. */
    function relayoutSoon() {
      setTimeout(() => useGraphStore.getState().requestLayout(), 250)
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
      relayoutSoon()
    }

    function hideColumns(id: string) {
      useGraphStore.getState().setShowColumns(id, false)
      relayoutSoon()
    }

    function toggleColumns(id: string) {
      const node = useGraphStore.getState().nodes.find((n) => n.id === id)
      if (node?.data.showColumns) hideColumns(id)
      else void showColumns(id)
    }

    /** Columns on several nodes, one after another: each can mean a warehouse query. */
    async function showColumnsOf(ids: string[]) {
      for (const id of ids) await showColumns(id)
    }

    /** Columns on every table node, or off for all. The choice stays on for nodes added later. */
    async function setAllColumns(show: boolean) {
      useGraphStore.getState().setColumnsOn(show)
      const ids = useGraphStore.getState().nodes.filter((n) => !isPlaceholder(n.id)).map((n) => n.id)
      for (const id of ids) {
        if (show) await showColumns(id)
        else useGraphStore.getState().setShowColumns(id, false)
      }
      relayoutSoon()
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

    return {
      queryTables,
      expand,
      openObject,
      refreshSelected,
      connect,
      showColumns,
      hideColumns,
      toggleColumns,
      setAllColumns,
      refreshGraph,
      showColumnEdge,
    }
  }, [qc])
}
