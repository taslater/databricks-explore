// Keeps the table lookups for the query windows current. Lookups are debounced, and a newer
// run discards the results of an older one, so a slow response can never overwrite a fresh one.
import { useEffect, useState } from 'react'
import type { CanvasWindow } from '../../api/types'
import { queryWindowMap } from '../../store/canvasStore'
import { fetchQueryTables } from './queryTables'

/** Quiet period after the last SQL or title change before the lookups run. */
export const TABLE_LOOKUP_DEBOUNCE_MS = 500

/** Query window id to the table names its SQL reads. Windows with no entry have no table edges. */
export type QueryReads = Record<string, readonly string[]>

interface LookupJob {
  queries: Array<{ id: string; sql: string }>
  windowsMap: Record<string, string>
}

/**
 * Looks up the tables each query window reads, through POST /api/query/tables.
 *
 * Any change to a query window's SQL, or to a title (which changes how `{{title}}` resolves),
 * starts a new run after the debounce. A failed lookup gives that window no entries. It shows no
 * error and logs nothing. The previous results stay on screen until a newer run finishes.
 */
export function useQueryTables(windows: CanvasWindow[]): QueryReads {
  const queries = windows
    .filter((w) => w.type === 'query')
    .map((w) => ({ id: w.id, sql: w.sql ?? '' }))
  // Serialized so the effect runs only when the query windows, their SQL, or their titles change.
  const key = JSON.stringify({ queries, windowsMap: queryWindowMap(windows) })
  const [reads, setReads] = useState<QueryReads>({})

  useEffect(() => {
    const job = JSON.parse(key) as LookupJob
    let cancelled = false

    const timer = window.setTimeout(() => {
      void Promise.all(
        job.queries.map(async (q): Promise<[string, string[]]> => {
          if (q.sql.trim() === '') return [q.id, []]
          try {
            return [q.id, await fetchQueryTables(q.sql, job.windowsMap)]
          } catch {
            // Draw no edges for this window. Nothing is shown or logged.
            return [q.id, []]
          }
        }),
      ).then((entries) => {
        if (!cancelled) setReads(Object.fromEntries(entries))
      })
    }, TABLE_LOOKUP_DEBOUNCE_MS)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [key])

  return reads
}
