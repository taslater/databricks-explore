// Starting and ending a column trace: read the path, add the tables it needs, load their columns; and put the graph back.
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import * as api from '../api/client'
import { getColumnTrace, traceKey, type TraceDirection, type TraceRequest } from '../api/columnTrace'
import { useUiStore } from '../store/uiStore'
import { columnsOf } from './columns'
import { makeExpansion } from './expansion'
import { cancelLayouts, useGraphStore } from './graphStore'
import { useTraceStore } from './traceStore'
import { withoutTrace } from './traceDraw'

/** Hops followed on each side of the traced column. */
export const TRACE_DEPTH = 4

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Starts a trace of one column of a table on the graph, ending any trace before it. */
export function makeTraceActions(qc: QueryClient) {
  const { relationsFor } = makeExpansion(qc, () => {})
  const graph = () => useGraphStore.getState()
  const current = (request: TraceRequest) => useTraceStore.getState().request === request

  /** Ends the trace: its tables come off, the others go back where they stood, and nothing is laid out again. */
  function stop() {
    const t = useTraceStore.getState()
    if (!t.request) return
    cancelLayouts()
    // The positions were the lens's they were taken in: after a switch of lens they would put the tables where another lens had them.
    useGraphStore.setState((s) => ({ ...withoutTrace(s, t.added, t.lens === null || t.lens === s.lens ? t.positions : {}), layoutPending: false, layoutScope: null }))
    t.reset()
    graph().setStatus('trace cleared')
  }

  /** Adds a table the trace reaches, with its edges to the tables already there. Returns whether it is on the graph now. */
  async function addTable(name: string): Promise<boolean> {
    const resp = await relationsFor(name)
    graph().mergeRelations({ nodes: resp.nodes.filter((n) => n.id.toLowerCase() === name.toLowerCase()), edges: resp.edges, errors: [] })
    const id = graph().nodes.find((n) => n.id.toLowerCase() === name.toLowerCase())?.id
    if (id) graph().pinNode(id)
    return id !== undefined
  }

  async function start(table: string, column: string, direction: TraceDirection) {
    stop()
    const request: TraceRequest = { table, column, direction, depth: TRACE_DEPTH }
    useTraceStore.getState().begin(request, Object.fromEntries(graph().nodes.map((n) => [n.id, n.position])), graph().lens)
    graph().setStatus(`tracing ${column} of ${table}…`)
    try {
      const profile = useUiStore.getState().connectedProfile
      const data = await qc.fetchQuery({ queryKey: traceKey(profile, request), queryFn: () => getColumnTrace(request), staleTime: 0, retry: false })
      if (!current(request)) return
      const have = new Set(graph().nodes.map((n) => n.id.toLowerCase()))
      const added: string[] = []
      for (const name of data.tables) {
        if (have.has(name.toLowerCase())) continue
        try {
          if (await addTable(name)) added.push(graph().nodes.find((n) => n.id.toLowerCase() === name.toLowerCase())!.id)
        } catch {
          // a table that cannot be read stays off; its hops are not drawn
        }
        if (!current(request)) return
        useTraceStore.getState().setAdded(added)
      }
      const columns: Record<string, ReturnType<typeof columnsOf>> = {}
      await Promise.all(
        graph().nodes
          .filter((n) => !n.data.columns && data.tables.some((t) => t.toLowerCase() === n.id.toLowerCase()))
          .map(async (n) => {
            try {
              const obj = await qc.fetchQuery({ queryKey: ['object', profile, n.id], queryFn: () => api.getObject(n.id), staleTime: 60_000, retry: false })
              columns[n.id] = columnsOf(obj.data)
            } catch {
              // its column rows are left out
            }
          }),
      )
      if (!current(request)) return
      useTraceStore.getState().setColumns(columns)
      const on = new Set(data.tables.map((t) => t.toLowerCase()))
      graph().requestLayoutSoon(graph().nodes.filter((n) => on.has(n.id.toLowerCase())).map((n) => n.id))
      const hops = data.hops.length
      graph().setStatus(
        hops === 0 ? `no column lineage found for ${column} of ${table}` : `traced ${column}: ${hops} hop${hops === 1 ? '' : 's'} over ${data.tables.length} tables${added.length ? `, ${added.length} added` : ''}`,
        hops === 0 && data.errors.length > 0,
      )
    } catch (e) {
      if (!current(request)) return
      stop()
      graph().setStatus(messageOf(e), true)
    }
  }

  return { start, stop }
}

export function useTraceActions() {
  const qc = useQueryClient()
  return useMemo(() => makeTraceActions(qc), [qc])
}
