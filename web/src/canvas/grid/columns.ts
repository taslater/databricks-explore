// Column typing for the results grid: what kind each warehouse type is, how to show, sort and filter it.
// Values stay exactly as the warehouse returned them (strings). Nothing here rounds or converts time zones.
import type { ColDef } from 'ag-grid-community'
import type { QueryColumn } from '../../api/types'
import { ColumnLabel } from './ColumnLabel'

export type Cell = string | null
export type Row = Record<string, Cell>
export type ColumnKind = 'number' | 'date' | 'timestamp' | 'boolean' | 'text'

const NUMERIC_TYPES = new Set(['BYTE', 'SHORT', 'INT', 'LONG', 'FLOAT', 'DOUBLE', 'DECIMAL'])

/** The kind of a column from its Databricks type name (`columns[].type`). Unknown types are text. */
export function columnKind(type: string | undefined): ColumnKind {
  const t = (type ?? '').toUpperCase()
  if (NUMERIC_TYPES.has(t)) return 'number'
  if (t === 'DATE') return 'date'
  if (t.startsWith('TIMESTAMP')) return 'timestamp'
  if (t === 'BOOLEAN') return 'boolean'
  return 'text'
}

const TS = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/

/**
 * Timestamp for display: no `T`, and no fraction when it is all zeros.
 * The zone suffix (Z or an offset) is kept and nothing is converted. Other text passes through.
 */
export function formatTimestamp(raw: string): string {
  const m = TS.exec(raw)
  if (!m) return raw
  const fraction = m[3] !== undefined && !/^0+$/.test(m[3]) ? `.${m[3]}` : ''
  return `${m[1]} ${m[2]}${fraction}${m[4]}`
}

/** Text shown in a cell for a raw value of the given kind. NULL shows as `NULL`; an empty string stays empty. */
export function displayValue(raw: Cell | undefined, kind: ColumnKind): string {
  if (raw === null || raw === undefined) return 'NULL'
  return kind === 'timestamp' ? formatTimestamp(raw) : raw
}

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/

/** Exact comparison of two plain decimal strings (no float rounding). Null when either is not one. */
function compareDecimalStrings(a: string, b: string): number | null {
  const x = DECIMAL.exec(a)
  const y = DECIMAL.exec(b)
  if (!x || !y) return null
  const int = (m: RegExpExecArray) => m[2].replace(/^0+(?=\d)/, '')
  const frac = (m: RegExpExecArray) => (m[3] ?? '').replace(/0+$/, '')
  const isZero = (m: RegExpExecArray) => int(m) === '0' && frac(m) === ''
  const sign = (m: RegExpExecArray) => (isZero(m) ? 0 : m[1] === '-' ? -1 : 1)
  const sa = sign(x)
  const sb = sign(y)
  if (sa !== sb) return sa < sb ? -1 : 1
  if (sa === 0) return 0
  const ia = int(x)
  const ib = int(y)
  let mag = 0
  if (ia.length !== ib.length) mag = ia.length < ib.length ? -1 : 1
  else if (ia !== ib) mag = ia < ib ? -1 : 1
  else {
    const fa = frac(x)
    const fb = frac(y)
    const n = Math.max(fa.length, fb.length)
    const pa = fa.padEnd(n, '0')
    const pb = fb.padEnd(n, '0')
    mag = pa === pb ? 0 : pa < pb ? -1 : 1
  }
  return mag * sa
}

/** Sort order for numeric text: exact for plain decimals, numeric otherwise, NULL lowest. */
export function compareNumeric(a: Cell | undefined, b: Cell | undefined): number {
  const an = a === null || a === undefined
  const bn = b === null || b === undefined
  if (an || bn) return an && bn ? 0 : an ? -1 : 1
  const exact = compareDecimalStrings(a, b)
  if (exact !== null) return exact
  const x = Number(a)
  const y = Number(b)
  if (Number.isNaN(x) || Number.isNaN(y)) return a < b ? -1 : a > b ? 1 : 0
  return x === y ? 0 : x < y ? -1 : 1
}

/** Sort order for dates and timestamps: ISO text sorts chronologically. NULL lowest. */
export function compareText(a: Cell | undefined, b: Cell | undefined): number {
  const an = a === null || a === undefined
  const bn = b === null || b === undefined
  if (an || bn) return an && bn ? 0 : an ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** The number a cell filters as. Null for NULL and for text that is not a number. */
export function filterNumber(raw: Cell | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === '') return null
  const n = Number(raw)
  return Number.isNaN(n) ? null : n
}

/**
 * Comparator for the date filter: the cell's calendar date against the picked day (local midnight).
 * Only the date part of the text is read, so no time zone conversion happens. Returns -1/0/1 as AG Grid expects
 * (cell before / same day as / after the picked day), and -1 for NULL.
 */
export function dateFilterComparator(filterDate: Date, raw: Cell | undefined): number {
  const m = raw ? /^(\d{4})-(\d{2})-(\d{2})/.exec(raw) : null
  if (!m) return -1
  const cell = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (cell < filterDate) return -1
  return cell > filterDate ? 1 : 0
}

/** CSS classes for a cell: dim italic NULL, right-aligned tabular numbers. */
export function cellClasses(raw: Cell | undefined, kind: ColumnKind): string[] {
  const out: string[] = []
  if (raw === null || raw === undefined) out.push('qw-null')
  if (kind === 'number') out.push('qw-num')
  return out
}

/** Widest an autosized column gets, in pixels. The user can still drag it wider. */
export const MAX_AUTO_WIDTH = 360

/** Narrowest a column goes: wide enough for its header name plus the sort and filter icons (an estimate, no DOM). */
export function headerMinWidth(name: string): number {
  return Math.min(MAX_AUTO_WIDTH, Math.max(80, Math.ceil(name.length * 8) + 64))
}

/** Column definitions for a result: positional fields `c0, c1, ...`, so names containing dots are not read as paths. */
export function buildColumnDefs(columns: QueryColumn[]): ColDef<Row>[] {
  return columns.map((c, i): ColDef<Row> => {
    const field = `c${i}`
    const kind = columnKind(c.type)
    const base: ColDef<Row> = {
      field,
      headerName: c.name,
      minWidth: headerMinWidth(c.name),
      headerTooltip: `${c.name}: ${c.type}`,
      headerComponentParams: {
        innerHeaderComponent: ColumnLabel,
        innerHeaderComponentParams: { typeText: c.type?.toLowerCase() ?? '' },
      },
      valueFormatter: (p) => displayValue(p.value, kind),
      cellClass: (p) => cellClasses(p.value, kind),
    }
    if (kind === 'number') {
      return {
        ...base,
        headerClass: 'ag-right-aligned-header',
        comparator: compareNumeric,
        filter: 'agNumberColumnFilter',
        filterValueGetter: (p) => filterNumber(p.data?.[field]),
      }
    }
    if (kind === 'date' || kind === 'timestamp') {
      return {
        ...base,
        comparator: compareText,
        filter: 'agDateColumnFilter',
        filterParams: { comparator: dateFilterComparator },
      }
    }
    return { ...base, comparator: compareText }
  })
}
