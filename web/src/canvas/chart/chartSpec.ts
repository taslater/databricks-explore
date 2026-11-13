// Pure chart helpers for the query window's Chart tab. No React, no DOM.
// The picker state and column types go in, a Vega-Lite v5 spec comes out.
// Rows are cast here: the API sends every value as a string or null.
import type { QueryColumn } from '../../api/types'

export const VEGA_LITE_SCHEMA = 'https://vega.github.io/schema/vega-lite/v5.json'

export const CHART_MARKS = ['bar', 'line', 'point'] as const
export type ChartMark = (typeof CHART_MARKS)[number]

export type FieldKind = 'quantitative' | 'temporal' | 'nominal'

/** Picker state. `x`, `y`, and `color` hold column keys (see chartColumns). '' means not chosen. */
export interface PickerState {
  mark: ChartMark
  x: string
  y: string
  color: string
}

export const EMPTY_PICKER: PickerState = { mark: 'bar', x: '', y: '', color: '' }

/** A result column with a unique key. The key is the row object key and the Vega field name. */
export interface ChartColumn {
  key: string
  name: string
  kind: FieldKind
}

// Databricks type_name values (manifest), not type_text.
const NUMERIC = new Set([
  'BYTE',
  'TINYINT',
  'SHORT',
  'SMALLINT',
  'INT',
  'INTEGER',
  'LONG',
  'BIGINT',
  'FLOAT',
  'REAL',
  'DOUBLE',
  'DECIMAL',
  'NUMERIC',
])
const TEMPORAL = new Set(['DATE', 'TIMESTAMP', 'TIMESTAMP_NTZ'])

/** Field type for a Databricks column type: numeric is quantitative, DATE/TIMESTAMP temporal, otherwise nominal. */
export function fieldKind(type: string): FieldKind {
  const t = type.trim().toUpperCase()
  if (NUMERIC.has(t)) return 'quantitative'
  if (TEMPORAL.has(t)) return 'temporal'
  return 'nominal'
}

/** Unique keys for the result columns. Duplicate or empty names get a suffix so no value is overwritten. */
export function chartColumns(columns: QueryColumn[]): ChartColumn[] {
  const used = new Set<string>()
  return columns.map((c, i) => {
    const base = c.name !== '' ? c.name : `column_${i + 1}`
    let key = base
    for (let n = 2; used.has(key); n++) key = `${base}_${n}`
    used.add(key)
    return { key, name: c.name !== '' ? c.name : key, kind: fieldKind(c.type) }
  })
}

/** Escapes a key for use as a Vega field name. Backslash, dot, and brackets are access-path syntax. */
export function escapeField(key: string): string {
  return key.replace(/[\\.[\]]/g, (ch) => `\\${ch}`)
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Parses a DATE or TIMESTAMP string to epoch milliseconds, or null.
 * DATE is read as local midnight. A bare ISO date is UTC in JS, which would move axis labels by a day.
 */
export function parseTemporal(raw: string): number | null {
  const t = raw.trim()
  const d = DATE_ONLY.exec(t)
  const ms = d
    ? new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getTime()
    : Date.parse(t.replace(' ', 'T'))
  return Number.isNaN(ms) ? null : ms
}

/** Casts one value from the API (string or null) for its field kind. */
export function castValue(raw: string | null, kind: FieldKind): string | number | null {
  if (raw === null) return null
  if (kind === 'quantitative') {
    const t = raw.trim()
    if (t === '') return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }
  if (kind === 'temporal') return parseTemporal(raw)
  return raw
}

/** Rows as objects keyed by column key, with values cast for each column's kind. */
export function castRows(cols: ChartColumn[], rows: (string | null)[][]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {}
    cols.forEach((c, i) => {
      out[c.key] = castValue(row[i] ?? null, c.kind)
    })
    return out
  })
}

interface Channel {
  field: string
  type: FieldKind
  title: string
}

function channel(col: ChartColumn): Channel {
  return { field: escapeField(col.key), type: col.kind, title: col.name }
}

/**
 * Builds the Vega-Lite spec for the picker. Returns null until x and y are both chosen.
 * The spec has no data. Rows are added at render time (see renderSpec), so the saved
 * canvas file stays small and the chart follows re-runs.
 */
export function buildSpec(picker: PickerState, cols: ChartColumn[]): Record<string, unknown> | null {
  const x = cols.find((c) => c.key === picker.x)
  const y = cols.find((c) => c.key === picker.y)
  if (!x || !y) return null
  const encoding: Record<string, Channel> = { x: channel(x), y: channel(y) }
  const color = cols.find((c) => c.key === picker.color)
  if (color) encoding.color = channel(color)
  return { $schema: VEGA_LITE_SCHEMA, mark: picker.mark, encoding }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function keyForChannel(ch: unknown, cols: ChartColumn[]): string {
  const field = isRecord(ch) && typeof ch.field === 'string' ? ch.field : null
  return cols.find((c) => escapeField(c.key) === field)?.key ?? ''
}

/** Reads picker state back from a spec, so the picker shows what the JSON says. Unknown parts are ignored. */
export function pickerFromSpec(spec: Record<string, unknown> | null, cols: ChartColumn[]): PickerState {
  if (spec === null) return EMPTY_PICKER
  const markName = typeof spec.mark === 'string' ? spec.mark : isRecord(spec.mark) ? spec.mark.type : undefined
  const mark = CHART_MARKS.find((m) => m === markName) ?? 'bar'
  const enc = isRecord(spec.encoding) ? spec.encoding : {}
  return {
    mark,
    x: keyForChannel(enc.x, cols),
    y: keyForChannel(enc.y, cols),
    color: keyForChannel(enc.color, cols),
  }
}

/** Field names the x, y, and color channels read. */
export function specFields(spec: Record<string, unknown>): string[] {
  if (!isRecord(spec.encoding)) return []
  const out: string[] = []
  for (const name of ['x', 'y', 'color']) {
    const ch = spec.encoding[name]
    if (isRecord(ch) && typeof ch.field === 'string') out.push(ch.field)
  }
  return out
}

/** Fields the spec reads that the current result does not have (for example after a re-run changed the columns). */
export function missingFields(spec: Record<string, unknown>, cols: ChartColumn[]): string[] {
  const have = new Set(cols.map((c) => escapeField(c.key)))
  return specFields(spec).filter((f) => !have.has(f))
}

const VEGA_LITE_KEYS = ['mark', 'layer', 'encoding', 'hconcat', 'vconcat', 'concat', 'facet', 'repeat']

/**
 * The spec handed to the renderer: the stored spec plus inline data.values cast from the last run.
 * A spec that already has its own `data` keeps it. Vega-Lite specs fill the chart container unless they set a size.
 */
export function renderSpec(
  spec: Record<string, unknown>,
  cols: ChartColumn[],
  rows: (string | null)[][],
): Record<string, unknown> {
  const sizing = VEGA_LITE_KEYS.some((k) => k in spec) ? { width: 'container', height: 'container' } : {}
  const data = 'data' in spec ? {} : { data: { values: castRows(cols, rows) } }
  return { ...sizing, ...spec, ...data }
}

export type SpecParse = { ok: true; spec: Record<string, unknown> } | { ok: false; error: string }

/** Parses the JSON textarea. The spec must be a JSON object. */
export function parseSpecJson(text: string): SpecParse {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!isRecord(value)) return { ok: false, error: 'The spec must be a JSON object.' }
  return { ok: true, spec: value }
}
