// Response and request shapes for the Flask API. Source of truth: contracts/api.md.
// Keep in sync with that file; do not invent fields here.

/** Cached endpoints wrap their payload like this. */
export interface Cached<T> {
  fetched_at: string
  data: T
}

// ---- Connection -----------------------------------------------------------

export interface Profile {
  name: string
  host: string
  auth_type: string
}

export interface ProfilesResponse {
  profiles: Profile[]
  config: string
}

export interface ConnectResponse {
  profile: string
  user: string | null
  host: string
  workspace_id: string | null
}

/** What the server is connected to. Both null when it has no connection. */
export interface SessionResponse {
  profile: string | null
  warehouse_id: string | null
}

export interface Warehouse {
  id: string
  name: string
  state: string | null
}

// ---- Unity Catalog metadata ----------------------------------------------

export interface Catalog {
  name: string
  type: string | null
  comment: string | null
}

export interface Schema {
  name: string
  comment: string | null
}

export interface ObjectSummary {
  name: string
  full_name: string
  type: string | null
  comment: string | null
}

export type SearchSource = string // "information_schema" or a "cached schemas only ..." message

export interface SearchResult {
  full_name: string
  name: string
  type: string | null
}

export interface SearchResponse {
  source: SearchSource
  data: SearchResult[]
}

/** Databricks TableInfo as_dict(). Only these fields are guaranteed; the rest passes through. */
export interface TableInfo {
  table_type?: string | null
  table_constraints?: unknown[]
  view_dependencies?: unknown
  columns?: Array<{ name?: string; type_name?: string | null; [key: string]: unknown }>
  [key: string]: unknown
}

// ---- Relationship graph ---------------------------------------------------

export type GraphNodeKind = string // lowercased table_type, default "table"

export interface GraphNode {
  id: string
  label: string
  kind: GraphNodeKind
  focus?: boolean
  self_ref?: boolean
  self_ref_last_seen?: string
}

export type GraphEdgeKind = 'fk' | 'view_dep' | 'lineage'

export interface GraphEdge {
  id: string
  source: string
  target: string
  kind: GraphEdgeKind
  // fk
  constraint?: string
  child_columns?: string[]
  parent_columns?: string[]
  label?: string
  // lineage
  bidir?: boolean
  last_seen?: string
  last_seen_by_dir?: Record<string, string>
}

export interface RelationsResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
  errors: string[]
}

export type ProducerKind = 'job' | 'notebook' | 'pipeline' | 'dashboard' | 'query' | 'file'

export interface Producer {
  kind: ProducerKind
  id: string
  url: string | null
  workspace_id: string
  other_workspace: boolean
  last_seen: string
  raw: Record<string, unknown>
}

export interface EdgeFlow {
  source: string
  target: string
  last_seen: string
  producers: Producer[]
}

export interface EdgeDetailsResponse {
  flows: EdgeFlow[]
}

// ---- Diagrams -------------------------------------------------------------

export interface DiagramFile {
  name: string
  saved_at: string
  [key: string]: unknown
}

export interface DiagramBody {
  name: string
  [key: string]: unknown
}

// ---- Query (new, A1) ------------------------------------------------------

export interface QueryBody {
  sql: string
  params?: Record<string, string | number | boolean>
  max_rows?: number
  windows?: Record<string, string>
}

export interface QueryColumn {
  name: string
  type: string
}

export interface QueryResult {
  statement_id: string
  columns: QueryColumn[]
  /** Values are strings or null (Databricks JSON_ARRAY). Not converted by the client. */
  rows: (string | null)[][]
  row_count: number
  truncated: boolean | null
  ms: number | null
}

export type StatementState = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'CLOSED'

export interface QueryStatus extends QueryResult {
  state: StatementState
  error: string | null
}

export interface AsyncSubmitResponse {
  statement_id: string
}

export interface CancelResponse {
  statement_id: string
  cancel_requested: boolean
}

// ---- Canvas (new, A2) -----------------------------------------------------

export interface CanvasPoint {
  x: number
  y: number
}

export interface CanvasWindow {
  id: string
  type: 'query' | 'chart' | 'note' | 'table'
  title: string
  position: CanvasPoint
  size: { w: number; h: number }
  sql?: string
  chart?: { vega_lite: Record<string, unknown> }
  text?: string
  table?: string
  collapsed?: boolean
  /** Query windows only. Percent of the window body the SQL editor takes. Absent means the default split. */
  editor_split?: number
}

export interface CanvasDoc {
  version: 1
  name: string
  profile: string
  warehouse_id?: string | null
  viewport?: { x: number; y: number; zoom: number }
  windows: CanvasWindow[]
  links?: Array<{ from: string; to: string }>
}

export interface SavedResponse {
  saved: string
}
