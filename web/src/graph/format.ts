// Display helpers ported from static/app.js. Pure functions, no React.

export const EDGE_COLORS: Record<string, string> = {
  lineage: '#2b6cb0',
  fk: '#c05621',
  view_dep: '#6b46c1',
  join_mined: '#2c7a7b',
  manual: '#2f855a',
  sketch: '#b83280',
  concept_link: '#b7791f',
  ontology: '#4a5568',
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

/** A table that does not exist yet is `ph:<uuid>`. */
export const isPlaceholder = (fullName: string): boolean => fullName.startsWith('ph:')

/** Full name "cat.sch.tbl" -> "cat.sch". A placeholder has no schema. */
export const schemaOf = (fullName: string): string =>
  isPlaceholder(fullName) ? 'placeholder' : fullName.split('.').slice(0, 2).join('.')

/** Full name "cat.sch.tbl" -> "tbl". A placeholder shows the start of its uuid. */
export const nameOf = (fullName: string): string =>
  isPlaceholder(fullName) ? `new ${fullName.slice(3, 11)}` : (fullName.split('.')[2] ?? fullName)

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

/** A lineage or provenance time for display: `2026-10-26 14:02`. No `T`, no seconds or fraction, no zone. Unparseable text passes through. */
export function fmtTime(s: string | null | undefined): string {
  if (!s) return 'unknown'
  return /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s) ? s.slice(0, 16).replace('T', ' ') : s
}

export function fmtAge(s: string | null | undefined, now: number = Date.now()): string {
  const d = ageDays(s, now)
  return d === null || !s ? 'unknown' : `${fmtTime(s)} (${d}d ago)`
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
