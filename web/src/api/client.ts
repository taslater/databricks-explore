// Typed fetch functions, one per endpoint in contracts/api.md.
// Paths are relative: Vite proxies /api in dev, and Flask serves both in prod.
import type {
  AsyncSubmitResponse,
  CancelResponse,
  Cached,
  Catalog,
  CanvasDoc,
  ConnectResponse,
  DiagramBody,
  DiagramFile,
  EdgeDetailsResponse,
  ImportResult,
  ObjectSummary,
  ProfilesResponse,
  QueryBody,
  QueryResult,
  QueryStatus,
  Relationship,
  RelationshipCreate,
  RelationshipPatch,
  RelationshipsExport,
  RelationshipsResponse,
  RelationsResponse,
  SavedResponse,
  Schema,
  SearchResponse,
  SessionResponse,
  TableInfo,
  Warehouse,
} from './types'

/** Any non-2xx response. `message` is the body's `error` field when present. */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type Params = Record<string, string | number | boolean | null | undefined>

function qs(params: Params): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === false) continue
    sp.set(k, v === true ? '1' : String(v))
  }
  const s = sp.toString()
  return s ? `?${s}` : ''
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(path, init)
  const text = await res.text()
  let data: unknown = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = null
    }
  }
  if (!res.ok) {
    const err =
      data !== null && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `HTTP ${res.status}`
    throw new ApiError(res.status, err)
  }
  return data as T
}

const get = <T>(path: string) => request<T>('GET', path)
const post = <T>(path: string, body: unknown) => request<T>('POST', path, body)
const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body)
const del = <T>(path: string) => request<T>('DELETE', path)
const enc = encodeURIComponent

// ---- Connection -----------------------------------------------------------

export const getProfiles = () => get<ProfilesResponse>('/api/profiles')

/**
 * Can open a browser for CLI login and block up to 3 minutes.
 * Pass interactive=false to never open a browser (used when restoring on page load).
 */
export const connect = (profile: string, interactive = true) =>
  post<ConnectResponse>('/api/connect', { profile, interactive })

export const getSession = () => get<SessionResponse>('/api/session')

export const getWarehouses = () => get<Warehouse[]>('/api/warehouses')

export const setWarehouse = (id: string | null) =>
  post<{ warehouse_id: string | null }>('/api/warehouse', { id })

// ---- Unity Catalog metadata ----------------------------------------------

export const getCatalogs = (refresh = false) =>
  get<Cached<Catalog[]>>(`/api/catalogs${qs({ refresh })}`)

export const getSchemas = (catalog: string, refresh = false) =>
  get<Cached<Schema[]>>(`/api/schemas${qs({ catalog, refresh })}`)

export const getObjects = (catalog: string, schema: string, refresh = false) =>
  get<Cached<ObjectSummary[]>>(`/api/objects${qs({ catalog, schema, refresh })}`)

export const search = (q: string) => get<SearchResponse>(`/api/search${qs({ q })}`)

export const getObject = (name: string, refresh = false) =>
  get<Cached<TableInfo>>(`/api/object${qs({ name, refresh })}`)

export const getRelations = (name: string, refresh = false) =>
  get<RelationsResponse>(`/api/relations${qs({ name, refresh })}`)

export const getEdge = (src: string, tgt: string) =>
  get<EdgeDetailsResponse>(`/api/edge${qs({ src, tgt })}`)

// ---- Diagrams -------------------------------------------------------------

export const listDiagrams = () => get<string[]>('/api/diagrams')

export const getDiagram = (name: string) => get<DiagramFile>(`/api/diagrams/${enc(name)}`)

export const saveDiagram = (body: DiagramBody) => post<SavedResponse>('/api/diagrams', body)

// ---- Query (A1) -----------------------------------------------------------

export const runQuery = (body: QueryBody) => post<QueryResult>('/api/query', body)

export const submitQueryAsync = (body: QueryBody) =>
  post<AsyncSubmitResponse>('/api/query/async', body)

export const getQueryStatus = (id: string) => get<QueryStatus>(`/api/query/${enc(id)}`)

export const cancelQuery = (id: string) => del<CancelResponse>(`/api/query/${enc(id)}`)

// ---- Canvases (A2) --------------------------------------------------------

export const listCanvases = () => get<string[]>('/api/canvases')

export const getCanvas = (name: string) => get<CanvasDoc>(`/api/canvases/${enc(name)}`)

/** The server validates with pydantic models that mirror canvas.schema.json. Failures are 400 with an `error` message. */
export const saveCanvas = (doc: CanvasDoc) => post<SavedResponse>('/api/canvases', doc)

// ---- Relationships --------------------------------------------------------

/** Derived and stored edges for one table. `level` is 'table' (rolled up, the default) or 'column'. */
export const getRelationships = (table: string, refresh = false, level: 'table' | 'column' = 'table') =>
  get<RelationshipsResponse>(`/api/relationships${qs({ table, refresh, level: level === 'table' ? null : level })}`)

/** Creates a `manual` edge. 201 when new, 200 when the same edge existed (it is re-accepted). */
export const createRelationship = (body: RelationshipCreate) => post<Relationship>('/api/relationships', body)

/** `id` is a stored edge id or a derived edge id (a derived edge takes only a note). */
export const patchRelationship = (id: string, body: RelationshipPatch) =>
  patch<Relationship>(`/api/relationships/${enc(id)}`, body)

export const deleteRelationship = (id: string) => del<{ deleted: string }>(`/api/relationships/${enc(id)}`)

export const exportRelationships = () => get<RelationshipsExport>('/api/relationships/export')

export const importRelationships = (file: RelationshipsExport) =>
  post<ImportResult>('/api/relationships/import', file)
