// TanStack Query hooks over api/client.ts.
// Queries that need a server connection are keyed by the connected profile, so a
// reconnect to a different profile never shows the previous profile's cache.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useUiStore } from '../store/uiStore'
import * as api from './client'
import type { QueryBody, QueryStatus } from './types'

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
    onSuccess: () => qc.invalidateQueries({ queryKey: ['warehouses'] }),
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
  const term = q.trim()
  return useQuery({
    queryKey: ['search', profile, term],
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

export function useRelations(name: string | null) {
  const profile = useConnectedProfile()
  return useQuery({
    queryKey: ['relations', profile, name],
    queryFn: () => api.getRelations(name!),
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

export function useCanvases() {
  return useQuery({ queryKey: ['canvases'], queryFn: api.listCanvases })
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
