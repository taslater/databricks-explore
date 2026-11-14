// TanStack Query hooks over api/client.ts.
// Queries that need a server connection are keyed by the connected profile, so a
// reconnect to a different profile never shows the previous profile's cache.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useUiStore } from '../store/uiStore'
import * as api from './client'
import type { QueryBody, QueryStatus } from './types'

/** Join keys change only when a run finishes or an edge is reviewed, and both invalidate them. */
export const JOIN_KEYS_STALE_MS = 30_000

function useConnectedProfile(): string | null {
  return useUiStore((s) => s.connectedProfile)
}

// ---- Connection -----------------------------------------------------------

export function useProfiles() {
  return useQuery({ queryKey: ['profiles'], queryFn: api.getProfiles })
}

export function useConnect() {
  return useMutation({
    mutationFn: (profile: string) => api.connect(profile),
    onSuccess: (res) => {
      useUiStore.getState().setConnectedProfile(res.profile)
    },
  })
}

export function useWarehouses() {
  const profile = useConnectedProfile()
  return useQuery({
    queryKey: ['warehouses', profile],
    queryFn: api.getWarehouses,
    enabled: profile !== null,
  })
}

export function useSetWarehouse() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string | null) => api.setWarehouse(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['warehouses'] })
    },
  })
}

// ---- Unity Catalog metadata ----------------------------------------------

export function useCatalogs() {
  const profile = useConnectedProfile()
  return useQuery({
    queryKey: ['catalogs', profile],
    queryFn: () => api.getCatalogs(),
    enabled: profile !== null,
  })
}

/** Forces a remote re-fetch (`?refresh=1`) and writes the result into the catalogs cache. */
export function useRefreshCatalogs() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.getCatalogs(true),
    onSuccess: (res) => {
      const profile = useUiStore.getState().connectedProfile
      qc.setQueryData(['catalogs', profile], res)
    },
  })
}

export function useSchemas(catalog: string | null) {
  const profile = useConnectedProfile()
  return useQuery({
    queryKey: ['schemas', profile, catalog],
    queryFn: () => api.getSchemas(catalog!),
    enabled: profile !== null && catalog !== null,
  })
}

export function useObjects(catalog: string | null, schema: string | null) {
  const profile = useConnectedProfile()
  return useQuery({
    queryKey: ['objects', profile, catalog, schema],
    queryFn: () => api.getObjects(catalog!, schema!),
    enabled: profile !== null && catalog !== null && schema !== null,
  })
}

export function useSearch(q: string) {
  const profile = useConnectedProfile()
  const warehouseId = useUiStore((s) => s.warehouseId)
  const term = q.trim()
  return useQuery({
    queryKey: ['search', profile, warehouseId, term], // with a warehouse the search covers everything, without it the cache
    queryFn: () => api.search(term),
    enabled: profile !== null && term.length > 0,
  })
}

export function useObject(name: string | null) {
  const profile = useConnectedProfile()
  return useQuery({
    queryKey: ['object', profile, name],
    queryFn: () => api.getObject(name!),
    enabled: profile !== null && name !== null,
  })
}

export function useEdge(src: string | null, tgt: string | null) {
  const profile = useConnectedProfile()
  return useQuery({
    queryKey: ['edge', profile, src, tgt],
    queryFn: () => api.getEdge(src!, tgt!),
    enabled: profile !== null && src !== null && tgt !== null,
  })
}

// ---- Diagrams -------------------------------------------------------------

export function useDiagrams() {
  return useQuery({ queryKey: ['diagrams'], queryFn: api.listDiagrams })
}

export function useDiagram(name: string | null) {
  return useQuery({
    queryKey: ['diagram', name],
    queryFn: () => api.getDiagram(name!),
    enabled: name !== null,
  })
}

export function useSaveDiagram() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.saveDiagram,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['diagrams'] }),
  })
}

// ---- Query (A1) -----------------------------------------------------------

export function useRunQuery() {
  return useMutation({ mutationFn: (body: QueryBody) => api.runQuery(body) })
}

export function useSubmitQueryAsync() {
  return useMutation({ mutationFn: (body: QueryBody) => api.submitQueryAsync(body) })
}

const ACTIVE_STATES = new Set(['PENDING', 'RUNNING'])

/** Polls every second while the statement is PENDING or RUNNING. */
export function useQueryStatus(statementId: string | null) {
  const profile = useConnectedProfile()
  return useQuery<QueryStatus>({
    queryKey: ['query', profile, statementId],
    queryFn: () => api.getQueryStatus(statementId!),
    enabled: profile !== null && statementId !== null,
    refetchInterval: (q) => (q.state.data && ACTIVE_STATES.has(q.state.data.state) ? 1000 : false),
  })
}

export function useCancelQuery() {
  return useMutation({ mutationFn: (id: string) => api.cancelQuery(id) })
}

// ---- Canvases (A2) --------------------------------------------------------

/** How often the saved-canvases list asks the server again while the page is showing, so a canvas an agent made appears. */
export const CANVAS_LIST_POLL_MS = 5000

/**
 * The saved canvases. With `live`, the list also refetches on window focus and every few seconds while the page is
 * visible, because an agent can create canvases through the MCP server without this page doing anything.
 */
export function useCanvases(live = false) {
  return useQuery({
    queryKey: ['canvases'],
    queryFn: api.listCanvases,
    ...(live ? { refetchOnWindowFocus: 'always' as const, refetchInterval: CANVAS_LIST_POLL_MS } : {}),
  })
}

export function useCanvas(name: string | null) {
  return useQuery({
    queryKey: ['canvas', name],
    queryFn: () => api.getCanvas(name!),
    enabled: name !== null,
  })
}

export function useSaveCanvas() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.saveCanvas,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['canvases'] }),
  })
}

// ---- Query-history mining -------------------------------------------------

/** The plan for the confirm dialog: window and SQL. Only fetched while `enabled`. */
export function useMiningPlan(windowDays: number, full: boolean, enabled: boolean) {
  const profile = useConnectedProfile()
  return useQuery({
    queryKey: ['mining-plan', profile, windowDays, full],
    queryFn: () => api.getMiningPlan(windowDays, full),
    enabled: enabled && profile !== null && Number.isInteger(windowDays) && windowDays >= 1 && windowDays <= 365,
    staleTime: 0,
    retry: false,
  })
}

/** Polls while a run is going, so progress moves. */
export function useMiningStatus() {
  const profile = useConnectedProfile()
  return useQuery({
    queryKey: ['mining-status', profile],
    queryFn: api.getMiningStatus,
    enabled: profile !== null,
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 700 : false),
  })
}

export function useStartMining() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { windowDays: number; full: boolean }) => api.startMining(v.windowDays, v.full),
    onSuccess: (status) => {
      const profile = useUiStore.getState().connectedProfile
      qc.setQueryData(['mining-status', profile], status)
      void qc.invalidateQueries({ queryKey: ['mining-status'] })
    },
  })
}

export function useUsage(enabled = true) {
  const profile = useConnectedProfile()
  return useQuery({
    queryKey: ['usage', profile],
    queryFn: () => api.getUsage(10),
    enabled: enabled && profile !== null,
  })
}

export function useSuggestions(status: 'proposed' | 'accepted' | 'rejected', enabled = true) {
  const profile = useConnectedProfile()
  return useQuery({
    queryKey: ['suggestions', profile, status],
    queryFn: () => api.getSuggestions(status),
    enabled: enabled && profile !== null,
  })
}

export function useBulkReview() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.bulkReview,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['joinKeys'] })
      return qc.invalidateQueries({ queryKey: ['suggestions'] })
    },
  })
}

/** The join keys known for one table (see getJoinKeys). Shares the cache the editor's completion fills. */
export function useJoinKeys(table: string | null) {
  const profile = useConnectedProfile()
  return useQuery({
    queryKey: ['joinKeys', profile, table],
    queryFn: () => api.getJoinKeys(table!),
    enabled: profile !== null && table !== null,
    staleTime: JOIN_KEYS_STALE_MS,
  })
}
