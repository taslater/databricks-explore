// SQL autocomplete tree (catalog > schema > table > columns) built only from data
// already in the TanStack Query cache, so the editor never triggers remote calls.
// Tables come from `objects` entries; columns appear only for tables whose `object`
// details were already fetched (the picker or graph loads them).
import { useMemo, useEffect, useState } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { SQLNamespace } from '@codemirror/lang-sql'
import type { Catalog, Cached, ObjectSummary, Schema, TableInfo } from '../api/types'
import { useUiStore } from '../store/uiStore'

type Tree = Record<string, Record<string, Record<string, string[]>>>

/** Cache heads whose entries feed the tree. */
const CACHE_HEADS = new Set<unknown>(['catalogs', 'schemas', 'objects', 'object'])

export function buildSqlNamespace(qc: QueryClient, profile: string | null): SQLNamespace {
  const tree: Tree = {}
  if (profile === null) return tree
  // Cached catalogs and schemas appear with empty children until their tables are cached.
  const cachedCatalogs = qc.getQueryData<Cached<Catalog[]>>(['catalogs', profile])
  for (const c of cachedCatalogs?.data ?? []) tree[c.name] ??= {}
  const cachedSchemas = qc.getQueriesData<Cached<Schema[]>>({ queryKey: ['schemas', profile] })
  for (const [key, cached] of cachedSchemas) {
    // Keys are ['schemas', profile, catalog].
    const catalog = String(key[2])
    if (!cached) continue
    tree[catalog] ??= {}
    for (const s of cached.data) tree[catalog][s.name] ??= {}
  }
  const cachedObjects = qc.getQueriesData<Cached<ObjectSummary[]>>({ queryKey: ['objects', profile] })
  for (const [key, cached] of cachedObjects) {
    // Keys are ['objects', profile, catalog, schema].
    const catalog = String(key[2])
    const schema = String(key[3])
    if (!cached) continue
    for (const obj of cached.data) {
      const details = qc.getQueryData<Cached<TableInfo>>(['object', profile, obj.full_name])
      const columns = (details?.data.columns ?? [])
        .map((c) => c.name)
        .filter((n): n is string => typeof n === 'string')
      tree[catalog] ??= {}
      tree[catalog][schema] ??= {}
      tree[catalog][schema][obj.name] = columns
    }
  }
  return tree
}

/** Re-computes the tree when a catalogs, schemas, objects, or object cache entry is filled in. */
export function useSqlNamespace(): SQLNamespace {
  const qc = useQueryClient()
  const profile = useUiStore((s) => s.connectedProfile)
  const [version, setVersion] = useState(0)

  useEffect(
    () =>
      qc.getQueryCache().subscribe((event) => {
        const head = event.query.queryKey[0]
        if (CACHE_HEADS.has(head) && event.type === 'updated' && event.action.type === 'success') {
          setVersion((v) => v + 1)
        }
      }),
    [qc],
  )

  // `version` is the trigger; the cache itself is read inside buildSqlNamespace.
  return useMemo(() => buildSqlNamespace(qc, profile), [qc, profile, version])
}
