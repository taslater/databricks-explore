// Pure helpers behind the grid's right-click and double-click actions: WHERE text, filter models, the value
// viewer's text and the value-counts query. No DOM, no AG Grid.
import type { Cell, ColumnKind } from './columns'
import { sqlIdentifier, sqlLiteral } from './copy'

/** `WHERE col = 'value'`, or `WHERE col IS NULL`. The column is in backticks unless it is a plain identifier. */
export function whereEquals(name: string, type: string, value: Cell | undefined): string {
  const col = sqlIdentifier(name)
  return value === null || value === undefined ? `WHERE ${col} IS NULL` : `WHERE ${col} = ${sqlLiteral(value, type)}`
}

/**
 * The value pretty-printed as JSON when it is an object or an array in JSON text (`{...}` or `[...]`).
 * Null for anything else, including text that only looks like JSON.
 */
export function prettyJson(raw: Cell | undefined): string | null {
  if (raw === null || raw === undefined) return null
  const t = raw.trim()
  if (!(t.startsWith('{') && t.endsWith('}')) && !(t.startsWith('[') && t.endsWith(']'))) return null
  try {
    return JSON.stringify(JSON.parse(t), null, 2)
  } catch {
    return null
  }
}

/** The text the value viewer shows: pretty JSON when it parses, otherwise the value as is. NULL shows as `NULL`. */
export function viewerText(raw: Cell | undefined): string {
  if (raw === null || raw === undefined) return 'NULL'
  return prettyJson(raw) ?? raw
}

/** The text the viewer's Copy button copies: the shown text, except NULL copies as an empty string. */
export function viewerCopyText(raw: Cell | undefined): string {
  return raw === null || raw === undefined ? '' : (prettyJson(raw) ?? raw)
}

export type ValueFilterMode = 'equals' | 'notEqual'

/**
 * An AG Grid column filter model that keeps (`equals`) or drops (`notEqual`) the rows holding this value.
 * NULL uses the blank filters. Dates and timestamps filter by calendar day, because that is what the date
 * filter compares. Null when the value cannot be expressed (a number column holding text).
 */
export function valueFilterModel(raw: Cell | undefined, kind: ColumnKind, mode: ValueFilterMode): Record<string, unknown> | null {
  const blank = mode === 'equals' ? 'blank' : 'notBlank'
  if (raw === null || raw === undefined) {
    const filterType = kind === 'number' ? 'number' : kind === 'date' || kind === 'timestamp' ? 'date' : 'text'
    return { filterType, type: blank }
  }
  if (kind === 'number') {
    const n = Number(raw)
    return Number.isNaN(n) || raw.trim() === '' ? null : { filterType: 'number', type: mode, filter: n }
  }
  if (kind === 'date' || kind === 'timestamp') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(raw)
    return m ? { filterType: 'date', type: mode, dateFrom: `${m[1]} 00:00:00`, dateTo: null } : null
  }
  return { filterType: 'text', type: mode, filter: raw }
}

/**
 * `SELECT col, count(*) AS n FROM (<sql>) GROUP BY col ORDER BY n DESC`. Trailing semicolons come off, and the
 * inner statement sits on its own lines so a trailing `--` comment cannot swallow the closing bracket.
 */
export function valueCountsSql(sql: string, column: string): string {
  const inner = sql.trim().replace(/(\s*;)+\s*$/, '')
  const col = sqlIdentifier(column)
  return `SELECT ${col}, count(*) AS n\nFROM (\n${inner}\n)\nGROUP BY ${col}\nORDER BY n DESC`
}
