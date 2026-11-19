// Card facts: the grain of each table, and its size and freshness (contracts/api.md section 4, "Node facts").
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useUiStore } from '../store/uiStore'
import { ApiError } from './client'

/** What one row stands for, and where that comes from. */
export interface Grain {
  /** The card line: `per order_id × line_no`, `per 5 columns`, `per k (latest)` or `distinct rows`. */
  label: string
  columns: string[]
  basis: 'primary_key' | 'group_by' | 'dedupe' | 'distinct'
  /** Plain words for Details: "declared primary key pk_orders", "GROUP BY in the definition". */
  source: string
}

/** One table's size and freshness as DESCRIBE DETAIL and DESCRIBE HISTORY last said it. */
export interface TableStats {
  fetched_at: string | null
  bytes: number | null
  files: number | null
  /** Known only when the latest write replaced the table and nothing changed it since. */
  rows: number | null
  clustering: string[]
  partitioning: string[]
  last_write: { at: string; operation: string; rows: number | null; job: string | null; notebook: string | null; user: string | null } | null
  cadence_seconds: number | null
  late: boolean
  /** Rows written by each of the last 20 writes, oldest first. */
  writes: Array<{ at: string; rows: number | null }>
  history_error: string | null
}

export interface NodeFacts {
  grain: Grain | null
  stats: TableStats | null
}

export type FactsByTable = Record<string, NodeFacts>

export interface StatsPlan {
  statements: Array<{ table: string; name: 'detail' | 'history'; sql: string }>
  skipped: Array<{ table: string; reason: string }>
  warehouse_id: string | null
}

export interface StatsRead {
  facts: FactsByTable
  skipped: StatsPlan['skipped']
  errors: Record<string, string>
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    const err = data !== null && typeof data === 'object' && 'error' in data && typeof data.error === 'string' ? data.error : `HTTP ${res.status}`
    throw new ApiError(res.status, err)
  }
  return data as T
}

export const getNodeFacts = (tables: string[]) => post<{ facts: FactsByTable }>('/api/node-facts', { tables }).then((r) => r.facts)
export const getStatsPlan = (tables: string[]) => post<StatsPlan>('/api/table-stats/plan', { tables })
export const readTableStats = (tables: string[]) => post<StatsRead>('/api/table-stats/read', { tables })

/** The grain and cached size of these tables. Reads the server's cache and tables.get, never the warehouse. Silent when it cannot be read. */
export function useNodeFacts(tables: string[], enabled = true) {
  const profile = useUiStore((s) => s.connectedProfile)
  const key = [...tables].sort()
  return useQuery({
    queryKey: ['node-facts', profile, key],
    queryFn: () => getNodeFacts(key),
    enabled: enabled && profile !== null && key.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  })
}

/** The statements a read would run, for the confirm dialog. */
export function useStatsPlan(tables: string[]) {
  const profile = useUiStore((s) => s.connectedProfile)
  return useQuery({
    queryKey: ['table-stats-plan', profile, [...tables].sort()],
    queryFn: () => getStatsPlan(tables),
    enabled: profile !== null && tables.length > 0,
    retry: false,
  })
}

/** Runs the read on the warehouse, then makes every card read the cache again. */
export function useReadTableStats() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: readTableStats,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['node-facts'] }),
  })
}
