// Profiling a relationship: the statement it would run, and running it (contracts/api.md section 4, "Relationship profile").
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useUiStore } from '../store/uiStore'
import { ApiError } from './client'
import type { Cardinality, RelationshipProfile } from './types'

/** The edge as the server wants it. */
export interface ProfileEdge {
  id: string
  kind: string
  source: string
  target: string
}

export interface ProfilePlan {
  statements: Array<ProfileEdge & { pairs: Array<[string, string]>; sql: string; rows: Record<string, number | null> }>
  skipped: Array<{ id: string; reason: string }>
  warehouse_id: string | null
}

export interface ProfileRun {
  profiles: Record<string, RelationshipProfile>
  errors: Record<string, string>
  skipped: ProfilePlan['skipped']
  cardinality: Record<string, Cardinality>
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

export const getProfilePlan = (edges: ProfileEdge[]) => post<ProfilePlan>('/api/relationships/profile/plan', { edges })
export const runProfile = (edges: ProfileEdge[]) => post<ProfileRun>('/api/relationships/profile/run', { edges })

/** The statements a profile would run, for the confirm dialog. */
export function useProfilePlan(edges: ProfileEdge[]) {
  const profile = useUiStore((s) => s.connectedProfile)
  const key = edges.map((e) => e.id).sort()
  return useQuery({
    queryKey: ['profile-plan', profile, key],
    queryFn: () => getProfilePlan(edges),
    enabled: profile !== null && edges.length > 0,
    retry: false,
  })
}

/** Runs the statements on the warehouse, then makes every edge read its ends again. */
export function useRunProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: runProfile,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['cardinality'] }),
  })
}
