// Concepts: types, fetch functions and TanStack Query hooks for the glossary (contracts/api.md section 6).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useUiStore } from '../store/uiStore'
import { ApiError } from './client'
import type { Endpoint, ImportResult, Provenance, Relationship, RelationshipsExport } from './types'

export type ConceptStatus = 'draft' | 'reviewed' | 'certified'
export const CONCEPT_STATUSES: readonly ConceptStatus[] = ['draft', 'reviewed', 'certified']

export type ConceptOrigin = 'manual' | 'uc_tag' | 'ontology'

/** What a link to a table or a column says. */
export const TABLE_RELATIONS = ['defines', 'measures', 'identifies', 'describes'] as const
/** What a link to another concept says. */
export const CONCEPT_RELATIONS = ['is_a', 'part_of', 'related_to'] as const

export interface Concept {
  id: string
  name: string
  definition: string
  synonyms: string[]
  domain: string | null
  status: ConceptStatus
  tags: string[]
  provenance: Provenance & { origin: ConceptOrigin }
  created_at: string
  updated_at: string
}

export interface ConceptSummary extends Concept {
  link_count: number
}

export interface ConceptList {
  concepts: ConceptSummary[]
  domains: string[]
}

/** A concept with the links that start at it and the concept links that point at it. */
export interface ConceptDetail extends Concept {
  links: Relationship[]
  incoming: Relationship[]
}

export interface ConceptFilters {
  q: string
  domain: string
  status: '' | ConceptStatus
}

export interface ConceptCreate {
  name: string
  definition?: string
  synonyms?: string[]
  domain?: string | null
  status?: ConceptStatus
  tags?: string[]
}

export type ConceptPatch = Partial<ConceptCreate>

export interface LinkCreate {
  target: Endpoint
  relation: string
  note?: string
}

export interface Candidate {
  kind: 'table' | 'column'
  table: string
  column: string | null
  field: 'name' | 'comment'
  matched: string
  text: string
  score: number
  linked: boolean
}

export interface CandidatesResponse {
  terms: string[]
  hits: Candidate[]
  searched: { tables: number; tables_with_columns: number; columns: number }
  truncated: boolean
}

export interface ConceptsForTables {
  concepts: Concept[]
  links: Relationship[]
}

export interface TagPlan {
  queries: Array<{ name: string; sql: string }>
  row_cap: number
  warehouse_id: string | null
}

export interface TagRunEntry {
  id: string
  name: string
  links_added: number
  links_removed: number
  links: number
}

export interface TagRunResult {
  created: TagRunEntry[]
  updated: TagRunEntry[]
  skipped: Array<{ name: string; reason: string }>
  rows: number
  truncated: boolean
}

// ---- fetch functions ------------------------------------------------------

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  const res = await fetch(path, init)
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
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

const enc = encodeURIComponent

export function conceptsQuery(f: ConceptFilters): string {
  const sp = new URLSearchParams()
  if (f.q.trim()) sp.set('q', f.q.trim())
  if (f.domain) sp.set('domain', f.domain)
  if (f.status) sp.set('status', f.status)
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export const listConcepts = (f: ConceptFilters) => call<ConceptList>('GET', `/api/concepts${conceptsQuery(f)}`)
export const getConcept = (id: string) => call<ConceptDetail>('GET', `/api/concepts/${enc(id)}`)
export const createConcept = (body: ConceptCreate) => call<ConceptDetail>('POST', '/api/concepts', body)
export const patchConcept = (id: string, body: ConceptPatch) =>
  call<ConceptDetail>('PATCH', `/api/concepts/${enc(id)}`, body)
export const deleteConcept = (id: string) =>
  call<{ deleted: string; links_removed: number }>('DELETE', `/api/concepts/${enc(id)}`)
export const addConceptLink = (id: string, body: LinkCreate) =>
  call<Relationship>('POST', `/api/concepts/${enc(id)}/links`, body)
export const removeConceptLink = (id: string, edgeId: string) =>
  call<{ deleted: string }>('DELETE', `/api/concepts/${enc(id)}/links/${enc(edgeId)}`)
export const getCandidates = (id: string) => call<CandidatesResponse>('GET', `/api/concepts/${enc(id)}/candidates`)
export const getConceptsForTables = (tables: string[]) =>
  call<ConceptsForTables>('GET', `/api/concepts/for-tables?${tables.map((t) => `table=${enc(t)}`).join('&')}`)
export const getTagPlan = () => call<TagPlan>('GET', '/api/concepts/suggest/plan')
export const runTagSuggestions = () => call<TagRunResult>('POST', '/api/concepts/suggest/run', {})
export const exportConcepts = () => call<RelationshipsExport>('GET', '/api/concepts/export')
export const importConceptsFile = (file: unknown) => call<ImportResult>('POST', '/api/relationships/import', file)

// ---- hooks ----------------------------------------------------------------

function useProfile(): string | null {
  return useUiStore((s) => s.connectedProfile)
}

export function useConcepts(filters: ConceptFilters) {
  const profile = useProfile()
  return useQuery({
    queryKey: ['concepts', profile, 'list', filters],
    queryFn: () => listConcepts(filters),
    enabled: profile !== null,
  })
}

export function useConcept(id: string | null) {
  const profile = useProfile()
  return useQuery({
    queryKey: ['concepts', profile, 'one', id],
    queryFn: () => getConcept(id!),
    enabled: profile !== null && id !== null,
  })
}

/** Everything under ['concepts'] is stale after any change, so mutations invalidate the lot. */
function useChanged() {
  const qc = useQueryClient()
  return () => qc.invalidateQueries({ queryKey: ['concepts'] })
}

export function useCreateConcept() {
  const changed = useChanged()
  return useMutation({ mutationFn: createConcept, onSuccess: changed })
}

export function usePatchConcept() {
  const changed = useChanged()
  return useMutation({ mutationFn: (v: { id: string; body: ConceptPatch }) => patchConcept(v.id, v.body), onSuccess: changed })
}

export function useDeleteConcept() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: deleteConcept,
    onSuccess: (_, id) => {
      // Drop what was read for this concept first, so nothing re-fetches a concept that is gone (a 404).
      qc.removeQueries({ queryKey: ['concepts'], predicate: (q) => q.queryKey.includes(id) })
      return qc.invalidateQueries({ queryKey: ['concepts'] })
    },
  })
}

export function useAddLink() {
  const changed = useChanged()
  return useMutation({ mutationFn: (v: { id: string; body: LinkCreate }) => addConceptLink(v.id, v.body), onSuccess: changed })
}

export function useRemoveLink() {
  const changed = useChanged()
  return useMutation({ mutationFn: (v: { id: string; edgeId: string }) => removeConceptLink(v.id, v.edgeId), onSuccess: changed })
}

/** Searches the local cache only. Runs when `enabled` turns true (the Find candidates button). */
export function useCandidates(id: string | null, enabled: boolean) {
  const profile = useProfile()
  return useQuery({
    queryKey: ['concepts', profile, 'candidates', id],
    queryFn: () => getCandidates(id!),
    enabled: enabled && profile !== null && id !== null,
    staleTime: 0,
    retry: false,
  })
}

/** The concepts linked to these tables, for the graph. */
export function useConceptsForTables(tables: string[], enabled: boolean) {
  const profile = useProfile()
  const key = [...tables].sort()
  return useQuery({
    queryKey: ['concepts', profile, 'for-tables', key],
    queryFn: () => getConceptsForTables(key),
    enabled: enabled && profile !== null && key.length > 0,
  })
}

/** The SQL a tag suggestion would run, for the confirm dialog. Runs nothing. */
export function useTagPlan(enabled: boolean) {
  const profile = useProfile()
  return useQuery({
    queryKey: ['concepts', profile, 'tag-plan'],
    queryFn: getTagPlan,
    enabled: enabled && profile !== null,
    staleTime: 0,
    retry: false,
  })
}

export function useRunTagSuggestions() {
  const changed = useChanged()
  return useMutation({ mutationFn: runTagSuggestions, onSuccess: changed })
}

export function useImportConcepts() {
  const changed = useChanged()
  return useMutation({ mutationFn: importConceptsFile, onSuccess: changed })
}
