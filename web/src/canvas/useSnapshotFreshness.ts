import { useEffect, useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import * as api from '../api/client'
import type { CanvasWindow } from '../api/types'
import { useCanvasStore } from '../store/canvasStore'
import { freshness, referencedWindows, statementsOf, type Freshness } from './snapshot'

/** The value, once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms)
    return () => window.clearTimeout(timer)
  }, [value, ms])
  return settled
}

/**
 * Whether a query window's saved result still matches its SQL. The server hashes each statement of the window after
 * expanding {{title}} references (the page cannot), so this asks it, a moment after the last edit of the window or of
 * a window it reaches. Unknown while the answer is not in (and when there is no saved result).
 */
export function useSnapshotFreshness(win: CanvasWindow): Freshness {
  const snap = win.result
  const sql = win.sql ?? ''
  // Only the windows this one reaches matter, so typing in an unrelated window asks nothing.
  const reached = useCanvasStore((s) => JSON.stringify(referencedWindows(sql, s.windows)))
  const request = useMemo(() => JSON.stringify({ statements: statementsOf(sql), windows: JSON.parse(reached) }), [sql, reached])
  const settled = useSettled(request, 400)
  const hashes = useQuery({
    queryKey: ['sql-hashes', settled],
    queryFn: () => api.queryHashes(JSON.parse(settled)),
    enabled: snap !== undefined,
    staleTime: Infinity, // a pure function of the request
    placeholderData: keepPreviousData,
    retry: false,
  })
  if (snap === undefined) return 'unknown'
  return freshness(snap, hashes.data?.hashes)
}
