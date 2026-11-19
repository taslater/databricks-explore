// What Color by needs besides the name: each table's owner, and the tags read before (contracts/api.md, "Color by").
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useUiStore } from '../store/uiStore'
import { ApiError } from './client'

export interface NodeMeta {
  owner: string | null
  /** The table's own tags, or null when its tags were never read (not the same as read and none: `{}`). */
  tags: Record<string, string> | null
  tags_fetched_at: string | null
}

export type MetaByTable = Record<string, NodeMeta>

export interface TagsPlan {
  statements: Array<{ table: string; sql: string }>
  warehouse_id: string | null
}

export interface TagsRead {
  meta: MetaByTable
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

export const getNodeMeta = (tables: string[]) => post<{ meta: MetaByTable }>('/api/node-meta', { tables }).then((r) => r.meta)
export const getTagsPlan = (tables: string[]) => post<TagsPlan>('/api/node-tags/plan', { tables })
export const readTags = (tables: string[]) => post<TagsRead>('/api/node-tags/read', { tables })

/** The owner and the cached tags of these tables. Reads the server's cache and tables.get, never the warehouse. Silent when it cannot be read. */
export function useNodeMeta(tables: string[], enabled = true) {
  const profile = useUiStore((s) => s.connectedProfile)
  const key = [...tables].sort()
  return useQuery({
    queryKey: ['node-meta', profile, key],
    queryFn: () => getNodeMeta(key),
    enabled: enabled && profile !== null && key.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
    retry: false,
  })
}

/** The statements a tag read would run, for the confirm dialog. */
export function useTagsPlan(tables: string[], enabled: boolean) {
  const profile = useUiStore((s) => s.connectedProfile)
  return useQuery({
    queryKey: ['node-tags-plan', profile, [...tables].sort()],
    queryFn: () => getTagsPlan(tables),
    enabled: enabled && profile !== null && tables.length > 0,
    retry: false,
  })
}

/** Runs the read on the warehouse, then makes every node read the cache again. */
export function useReadTags() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: readTags,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['node-meta'] }),
  })
}
