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

/** Derived from Unity Catalog at read time: `fk`, `lineage`, `view_dep`. The rest are stored. */
export type RelationshipKind =
  | 'fk'
  | 'lineage'
  | 'view_dep'
  | 'join_mined'
  | 'manual'
  | 'sketch'
  | 'concept_link'
  | 'ontology'

export type GraphEdgeKind = RelationshipKind

export type RelationshipStatus = 'derived' | 'proposed' | 'accepted' | 'rejected'

/** What the graph draws and saves for one edge. The first group is the legacy shape, the second comes from /api/relationships. */
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
  // relationship store. Absent on edges from a diagram saved by an older version: those are derived edges.
  directed?: boolean
  status?: RelationshipStatus
  note?: string
  provenance?: Provenance
  evidence?: Evidence
  /** Ids to send to PATCH /api/relationships/<id>: the underlying stored edges, or the derived edge ids. */
  patch_ids?: string[]
  /** Column-level edges only (`level=column`): the columns joined or fed. `source` and `target` stay table names. */
  source_column?: string
  target_column?: string
}

export interface RelationsResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
  errors: string[]
}

// ---- Relationship store (GET /api/relationships and friends) --------------

export interface Endpoint {
  table: string
  column?: string | null
}

export interface Provenance {
  origin: string
  source_ref?: string | null
  fetched_at?: string | null
}

export interface Evidence {
  runs?: number | null
  users?: number | null
  first_seen?: string | null
  last_seen?: string | null
  sample_refs: string[]
}

export interface ColumnPair {
  source: string | null
  target: string | null
}

/** One edge as the server returns it. At table level (the default) it is rolled up and has `columns` and `members`. */
export interface Relationship {
  id: string
  kind: RelationshipKind
  source: Endpoint
  target: Endpoint
  directed: boolean
  provenance: Provenance
  evidence: Evidence | null
  status: RelationshipStatus
  note: string
  created_at: string
  updated_at: string
  columns?: ColumnPair[]
  members?: string[]
}

export interface RelationshipsResponse {
  table: string
  level: 'table' | 'column'
  nodes: GraphNode[]
  edges: Relationship[]
  errors: string[]
}

export interface RelationshipCreate {
  source: Endpoint
  target: Endpoint
  directed?: boolean
  note?: string
}

export interface RelationshipPatch {
  status?: Exclude<RelationshipStatus, 'derived'>
  note?: string
}

export interface RelationshipsExport {
  version: 1
  exported_at?: string
  edges: Relationship[]
  overlays: Array<{ kind: RelationshipKind; source: Endpoint; target: Endpoint; note: string; updated_at?: string }>
}

export interface ImportResult {
  imported: number
  created: number
  updated: number
  overlays: number
}

// ---- Query-history mining and suggestions (contracts/api.md section 5) ----

export interface MiningQuery {
  name: 'query_history' | 'table_lineage'
  sql: string
  params: Record<string, string>
}

export interface MiningPlan {
  since: string
  until: string
  window_days: number
  incremental: boolean
  cursor: string | null
  row_cap: number
  warehouse_id: string | null
  queries: MiningQuery[]
}

export interface MiningResult {
  statements: number
  parsed: number
  with_joins: number
  unparsed: number
  redacted_skipped: number
  no_lineage: number
  pairs: number
  skipped_fk: number
  fk_unreadable_tables: number
  invalid: number
  created: number
  updated: number
  capped: boolean
  since: string
  until: string
  finished_at: string
}

export type MiningState = 'idle' | 'running' | 'succeeded' | 'failed' | 'blocked'
export type MiningPhase = 'history' | 'lineage' | 'extract' | 'foreign_keys' | 'save'

export interface MiningStatus {
  state: MiningState
  phase: MiningPhase | null
  progress: { done: number; total: number }
  started_at: string | null
  finished_at: string | null
  plan: { since: string; until: string; window_days: number; incremental: boolean; row_cap: number } | null
  result: MiningResult | null
  error: string | null
  reason: 'redacted' | null
  last_run: MiningResult | null
}

export interface UsageTable {
  table: string
  runs: number
  users: number
}

export interface UsagePair {
  tables: [string, string]
  runs: number
  users: number
}

export interface UsageSummary {
  window: { since: string; until: string } | null
  statements: number
  tables: UsageTable[]
  pairs: UsagePair[]
}

export type StoredStatus = Exclude<RelationshipStatus, 'derived'>

export interface SuggestionsResponse {
  edges: Relationship[]
  counts: Record<StoredStatus, number>
}

export interface BulkStatusBody {
  ids: string[]
  status: StoredStatus
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
  /** The warehouse's SQL type text, e.g. `decimal(38,10)`. Absent on old results. */
  type_text?: string | null
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
