// Display helpers ported from static/app.js. Pure functions, no React.

/** One color per edge family (see edgeStyles.ts): flow is the strongest, meaning the lightest. */
export const FAMILY_COLORS = { flow: '#2d3748', reference: '#2c7a7b', meaning: '#a0aec0' } as const

export const EDGE_COLORS: Record<string, string> = {
  lineage: FAMILY_COLORS.flow,
  view_dep: FAMILY_COLORS.flow,
  fk: FAMILY_COLORS.reference,
  join_mined: FAMILY_COLORS.reference,
  manual: FAMILY_COLORS.reference,
  sketch: FAMILY_COLORS.meaning,
  concept_link: FAMILY_COLORS.meaning,
  ontology: FAMILY_COLORS.meaning,
  superseded: '#bbb',
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

/** Light fills for "Color by", dark text stays readable on each. A value takes its slot from a hash of its text (valueColors in colorBy.ts). */
export const PALETTE = ['#f9d5d3', '#fde7c4', '#fbf3b9', '#d4edc9', '#c9eee6', '#cfe3fa', '#e0d6f5', '#f6d3ec'] as const
/** Values beyond the eight palette slots. */
export const OTHER_FILL = '#d9dde1'
/** A node with no value for what the graph is colored by. */
export const NO_VALUE_FILL = '#ffffff'

/** A small stable hash of a string (FNV-1a), the same in every graph and every session. */
export function hashText(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "26 Nov 16:38" (local time, with no-break spaces so it never wraps mid-date) for a stored timestamp; the raw text when it is not a date. */
export function shortStamp(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${d.getDate()}\xa0${MONTHS[d.getMonth()]}\xa0${pad(d.getHours())}:${pad(d.getMinutes())}`
}
