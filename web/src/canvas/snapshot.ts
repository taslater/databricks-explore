// Saved results: the snapshot a query window keeps in the canvas file. Pure helpers, no React and no fetch.
// The caps and the hash match the server's (canvases.result_snapshot, sqltools.sql_hash), and the snapshot shape is
// `result` in contracts/canvas.schema.json.
import type { CanvasWindow, QueryResult, ResultSnapshot } from '../api/types'
import { splitStatements } from './editor/statements'

export const MAX_RESULT_ROWS = 500
export const MAX_RESULT_BYTES = 256 * 1024

const encoder = new TextEncoder()
const byteLength = (value: unknown) => encoder.encode(JSON.stringify(value)).length

/**
 * The snapshot of a finished statement. Keeps at most MAX_RESULT_ROWS rows and about MAX_RESULT_BYTES of JSON
 * (rows are dropped from the end until it fits). `row_count` is how many rows the run returned, and `truncated` is
 * true when the run was cut at its row limit or fewer rows were kept than it returned.
 */
export function buildSnapshot(result: QueryResult, sqlHash: string, ranAt: Date = new Date()): ResultSnapshot {
  const columns = result.columns.map((c) => ({
    name: c.name,
    type: c.type ?? '',
    ...(c.type_text ? { type_text: c.type_text } : {}),
  }))
  const total = result.row_count ?? result.rows.length
  let size = byteLength(columns)
  let kept = 0
  for (const row of result.rows.slice(0, MAX_RESULT_ROWS)) {
    size += byteLength(row) + 1
    if (size > MAX_RESULT_BYTES) break
    kept++
  }
  return {
    columns,
    rows: result.rows.slice(0, kept),
    row_count: total,
    truncated: result.truncated === true || kept < total,
    ran_at: ranAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    sql_hash: sqlHash,
  }
}

/** The snapshot as a query result, so the grid and the chart can show it like a live one. */
export function snapshotResult(snap: ResultSnapshot): QueryResult {
  return {
    statement_id: `saved:${snap.ran_at}:${snap.sql_hash}`,
    columns: snap.columns,
    rows: snap.rows,
    row_count: snap.rows.length,
    truncated: snap.truncated,
    ms: null,
  }
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", and the date after two weeks. */
export function relativeTime(ranAt: string, now: number = Date.now()): string {
  const then = Date.parse(ranAt)
  if (Number.isNaN(then)) return 'an unknown time ago'
  const s = Math.max(0, Math.round((now - then) / 1000))
  if (s < 45) return 'just now'
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`
  if (s < 90 * 60) return unit(Math.max(1, Math.round(s / 60)), 'minute')
  if (s < 36 * 3600) return unit(Math.round(s / 3600), 'hour')
  if (s < 14 * 86400) return unit(Math.round(s / 86400), 'day')
  return `on ${ranAt.slice(0, 10)}`
}

/** The statements of a window's SQL, as a run of all of it would send them. */
export function statementsOf(sql: string): string[] {
  return splitStatements(sql).map((s) => s.text)
}

/** Same reference syntax as the server: text between double braces, trimmed. */
const REF_PATTERN = /\{\{([^{}]*)\}\}/g

/**
 * The windows `sql` reaches through `{{title}}` references, as a title to SQL map, followed transitively. These are
 * the only windows whose edits change what `sql` expands to. Unknown titles are left out, and cycles end.
 */
export function referencedWindows(sql: string, windows: CanvasWindow[]): Record<string, string> {
  const byTitle = new Map<string, CanvasWindow>()
  for (const w of windows) if (w.type === 'query' && !byTitle.has(w.title)) byTitle.set(w.title, w)
  const out: Record<string, string> = {}
  const todo = [sql]
  while (todo.length > 0) {
    const text = todo.pop() as string
    for (const m of text.matchAll(REF_PATTERN)) {
      const title = m[1].trim()
      const w = byTitle.get(title)
      if (w === undefined || title in out) continue
      out[title] = w.sql ?? ''
      todo.push(w.sql ?? '')
    }
  }
  return out
}

export type Freshness = 'fresh' | 'stale' | 'unknown'

/**
 * Whether a saved result still belongs to its window. `hashes` are the hashes of the window's current statements
 * (null for one that cannot be expanded), or undefined while they are not known yet. The result is fresh when any
 * statement hashes to the one it was saved with, because a run can be of one statement among several.
 */
export function freshness(snap: ResultSnapshot, hashes: readonly (string | null)[] | undefined): Freshness {
  if (hashes === undefined) return 'unknown'
  return hashes.includes(snap.sql_hash) ? 'fresh' : 'stale'
}

/** One line under the tabs about a saved result. */
export function snapshotLine(snap: ResultSnapshot, state: Freshness, now: number = Date.now()): string {
  const rows =
    snap.truncated && snap.rows.length < snap.row_count
      ? `first ${snap.rows.length} of ${snap.row_count} rows`
      : `${snap.rows.length} ${snap.rows.length === 1 ? 'row' : 'rows'}`
  const head = `Result from ${relativeTime(snap.ran_at, now)}, ${rows}`
  return state === 'stale' ? `${head}. The SQL has changed since. Run to refresh.` : `${head} · Run to refresh`
}

/** Statement ids whose result has been saved to its window already, so a window that mounts again does not save twice. */
const saved = new Set<string>()

/** True the first time it is called for a statement id. */
export function firstSave(statementId: string): boolean {
  if (saved.has(statementId)) return false
  saved.add(statementId)
  return true
}
