// One column's path through column lineage (contracts/api.md section 4, "Column trace").
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useUiStore } from '../store/uiStore'
import { ApiError } from './client'

export type TraceDirection = 'upstream' | 'downstream' | 'both'

/** What a hop does with its source column: same (`=`), rename (`→`), cast, func (`ƒ`), agg (`Σ sum`) or case. */
export type HopClass = 'same' | 'rename' | 'cast' | 'func' | 'agg' | 'case'

export interface TraceEnd {
  table: string
  column: string
}

export interface TraceHop {
  /** The id of the column lineage edge: `lineage:<table>#<column>-><table>#<column>`. */
  id: string
  source: TraceEnd
  target: TraceEnd
  /** Hops from the traced column, and the side it is on. */
  hop: number
  side: 'up' | 'down'
  last_seen: string | null
  class: HopClass | null
  /** The class as drawn: `=`, `→`, `cast`, `ƒ`, `Σ sum`, `case`. Null when the SQL behind the target is not known. */
  label: string | null
  /** The expression that makes the target column, for the classes that have one. */
  expr: string | null
  /** Why there is no class: unread (a table's writing statement was never read), no_sql, redacted, metric_view, unreadable, unparsed or not_select. */
  note: string | null
}

export interface TraceReader {
  table: string
  kind: 'job' | 'notebook' | 'pipeline' | 'dashboard' | 'query'
  id: string
  url: string | null
  last_seen: string | null
}

export interface ColumnTrace {
  table: string
  column: string
  direction: TraceDirection
  depth: number
  nodes: Array<TraceEnd & { hop: number; side: 'start' | 'up' | 'down' }>
  hops: TraceHop[]
  /** The tables reached, the traced one first. */
  tables: string[]
  readers: TraceReader[]
  /** Tables whose writing statement was never read, so the hops into them have no class. */
  unread: string[]
  truncated: boolean
  errors: string[]
}

export interface TraceRequest {
  table: string
  column: string
  direction: TraceDirection
  depth: number
}

export async function getColumnTrace(req: TraceRequest): Promise<ColumnTrace> {
  const q = new URLSearchParams({ table: req.table, column: req.column, direction: req.direction, depth: String(req.depth) })
  const res = await fetch(`/api/column-trace?${q}`)
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(res.status, body && typeof body.error === 'string' ? body.error : `HTTP ${res.status}`)
  return body as ColumnTrace
}

export const traceKey = (profile: string | null, req: TraceRequest) => ['column-trace', profile, req.table, req.column, req.direction, req.depth]

/** The trace being drawn. It is read again when a statement is read (the hops then have their classes). */
export function useColumnTraceData(req: TraceRequest | null) {
  const profile = useUiStore((s) => s.connectedProfile)
  return useQuery({
    queryKey: req ? traceKey(profile, req) : ['column-trace', profile, null],
    queryFn: () => getColumnTrace(req!),
    enabled: profile !== null && req !== null,
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: false,
  })
}
