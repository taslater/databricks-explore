// Graph actions that talk to the server: expand a node, open an object, refresh the selected node, connect two tables.
import { useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import * as api from '../api/client'
import { useCanvasStore } from '../store/canvasStore'
import { useUiStore } from '../store/uiStore'
import type { CanvasWindow } from '../api/types'
import { schemaOf } from './format'
import { useGraphStore } from './graphStore'
import { patchIds, toRelations } from './relationships'

export function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
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
        useGraphStore.getState().mergeRelations(resp)
        // Errors stay visible. The legacy UI overwrote them with "loaded".
        if (resp.errors.length) useGraphStore.getState().setStatus(resp.errors.join(' | '), true)
        else useGraphStore.getState().setStatus(`loaded ${name}`)
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

    return { expand, openObject, refreshSelected, connect }
  }, [qc])
}
