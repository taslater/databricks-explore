// What a flow edge does with its source: aggregate, join, union, dedupe, filter (contracts/api.md section 4, "Edge transforms").
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useUiStore } from '../store/uiStore'
import { post } from './nodeFacts'

/** The marks an edge can carry, in priority order. At most two are drawn. */
export type TransformGlyph = 'aggregate' | 'join' | 'union' | 'dedupe' | 'filter'

export interface EdgeTransform {
  /** The source is the FROM of its query. */
  driving: boolean
  /** Joined in: the join type (inner, left, right, full, cross) and the key columns, with the column they meet when known. */
  joined: { type: string; keys: Array<{ column: string; other: string | null }> } | null
  union: { branches: number } | null
  /** WHERE and QUALIFY predicates on this source, and semi or anti joins (EXISTS, IN, LEFT SEMI JOIN), as shortened SQL. */
  filters: Array<{ kind: 'where' | 'qualify' | 'semi' | 'anti'; sql: string }>
  aggregate: { keys: string[]; functions: string[]; having: string | null } | null
  dedupe: { keys: string[] } | null
  distinct: boolean
  window: boolean
  pivot: boolean
  merge: { keys: string[]; actions: string[] } | null
  glyphs: TransformGlyph[]
  /** select (a view), create, insert or merge. */
  statement: string
}

/** Why an edge has no transform: the SQL was never read (unread), a notebook or pipeline wrote it (no_sql), the text is hidden (redacted), it does not parse (unparsed), it does not name the source (not_read), or it is YAML (metric_view). */
export type TransformNote = 'unread' | 'no_sql' | 'redacted' | 'unparsed' | 'not_read' | 'metric_view' | 'unreadable'

export interface EdgeTransformAnswer {
  transform: EdgeTransform | null
  note: TransformNote | null
  error: string | null
}

/** The SQL behind a table, and where it came from. */
export interface TransformOrigin {
  kind: 'view' | 'statement' | null
  sql?: string
  note: TransformNote | null
  statement?: { id: string; type: string | null; run_by: string | null; at: string | null; redacted: boolean }
  writer?: { type: string | null; id: string | null } | null
  read_at?: string
}

export interface TransformsAnswer {
  edges: Record<string, EdgeTransformAnswer>
  origins: Record<string, TransformOrigin>
}

export interface StatementPlan {
  statements: Array<{ table: string; sql: string }>
  skipped: Array<{ table: string; reason: string }>
  warehouse_id: string | null
}

export interface StatementRead {
  read: string[]
  skipped: StatementPlan['skipped']
  errors: Record<string, string>
}

export type TransformCandidate = { id: string; source: string; target: string }

export const getEdgeTransforms = (edges: TransformCandidate[]) => post<TransformsAnswer>('/api/edge-transforms', { edges })
export const getStatementPlan = (tables: string[]) => post<StatementPlan>('/api/edge-transforms/plan', { tables })
export const readStatements = (tables: string[]) => post<StatementRead>('/api/edge-transforms/read', { tables })

/** The transforms of these flow edges, read from the server's cache of definitions and statements. Never the warehouse. Silent when it cannot be read. */
export function useEdgeTransformsFor(wanted: TransformCandidate[]) {
  const profile = useUiStore((s) => s.connectedProfile)
  const key = wanted.map((e) => `${e.id}|${e.source}|${e.target}`).sort()
  return useQuery({
    queryKey: ['edge-transforms', profile, key],
    queryFn: () => getEdgeTransforms(wanted),
    enabled: profile !== null && wanted.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  })
}

/** The statements a read would run, for the confirm step. */
export function useStatementPlan(tables: string[], enabled: boolean) {
  const profile = useUiStore((s) => s.connectedProfile)
  return useQuery({
    queryKey: ['edge-transforms-plan', profile, [...tables].sort()],
    queryFn: () => getStatementPlan(tables),
    enabled: enabled && profile !== null && tables.length > 0,
    retry: false,
  })
}

/** Runs the read on the warehouse, then makes every edge read its transform again. */
export function useReadStatements() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: readStatements,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['edge-transforms'] }),
  })
}
