// Display helpers ported from static/app.js. Pure functions, no React.

export const EDGE_COLORS: Record<string, string> = {
  lineage: '#2b6cb0',
  fk: '#c05621',
  view_dep: '#6b46c1',
  stale: '#bbb',
}

const NODE_FILL: Record<string, string> = {
  table: '#e3eaf2',
  managed: '#e3eaf2',
  external: '#e3eaf2',
  view: '#ece4f7',
  materialized_view: '#ece4f7',
  metric_view: '#ece4f7',
  streaming_table: '#e1f3e6',
}

export const nodeFill = (kind: string): string => NODE_FILL[kind] ?? '#eee'

/** Full name "cat.sch.tbl" -> "cat.sch". */
export const schemaOf = (fullName: string): string => fullName.split('.').slice(0, 2).join('.')

/** Full name "cat.sch.tbl" -> "tbl". */
export const nameOf = (fullName: string): string => fullName.split('.')[2] ?? fullName

/** Last dotted part, used for the breadcrumbs in the details panel. */
export const lastPart = (fullName: string): string => fullName.split('.').pop() ?? fullName

/**
 * Parses lineage timestamps. Databricks sends "2026-10-26 14:02:52.0" (UTC, no zone).
 * ISO strings with a zone are also accepted, because some endpoints return that form.
 */
export function parseTs(s: string | null | undefined): number {
  if (!s) return NaN
  const iso = /[TZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(' ', 'T')}Z`
  return Date.parse(iso)
}

export function ageDays(s: string | null | undefined, now: number = Date.now()): number | null {
  const t = parseTs(s)
  return Number.isNaN(t) ? null : Math.floor((now - t) / 86400000)
}

export function fmtAge(s: string | null | undefined, now: number = Date.now()): string {
  const d = ageDays(s, now)
  return d === null || !s ? 'unknown' : `${s.slice(0, 16)} (${d}d ago)`
}

const SHORT_TYPE_REPLACEMENTS: Array<[string, string]> = [
  ['materialized_view', 'mv'],
  ['streaming_table', 'streaming'],
  ['managed_catalog', ''],
  ['managed', ''],
]

/** Compact type tag shown next to names in the picker. Same replacements as the legacy list. */
export function shortType(t: string | null | undefined): string {
  let s = (t ?? '').toLowerCase()
  for (const [from, to] of SHORT_TYPE_REPLACEMENTS) s = s.replace(from, to)
  return s
}
