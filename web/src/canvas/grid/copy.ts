// Text formats for copying result rows. Pure functions: no DOM, no AG Grid.
// Values are the exact strings the warehouse returned (null for NULL). Nothing is rounded or reformatted.
import { columnKind, type Cell } from './columns'

export type CopyFormat = 'tsv' | 'csv' | 'markdown' | 'json' | 'sql-in'

export const COPY_FORMAT_LABELS: Record<CopyFormat, string> = {
  tsv: 'TSV',
  csv: 'CSV',
  markdown: 'Markdown',
  json: 'JSON',
  'sql-in': 'SQL IN list',
}

export interface CopyColumn {
  name: string
  /** Warehouse type name, for example LONG or TIMESTAMP. */
  type: string
}

export interface CopyTable {
  columns: CopyColumn[]
  rows: Cell[][]
}

/** A single value as plain text. NULL becomes the empty string. */
export function cellText(v: Cell | undefined): string {
  return v ?? ''
}

/**
 * TSV field, the way spreadsheets expect it: a value with a tab, a line break or a double quote is wrapped
 * in double quotes with its own quotes doubled. NULL and the empty string are both empty.
 */
export function tsvField(v: Cell | undefined): string {
  const t = cellText(v)
  return /[\t\r\n"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}

/**
 * CSV field (RFC 4180): quoted when it holds a comma, a double quote or a line break. NULL is empty and the
 * empty string is `""`, so the two stay apart for readers that tell them apart.
 */
export function csvField(v: Cell | undefined): string {
  if (v === null || v === undefined) return ''
  if (v === '') return '""'
  return /[,"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/** A GitHub-flavored Markdown table cell: pipes escaped, line breaks as <br>, tabs as spaces. */
export function markdownField(v: Cell | undefined): string {
  return cellText(v)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, '<br>')
    .replace(/\t/g, ' ')
}

const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/

/**
 * A value as a JSON token. Numbers keep their exact text (no float round trip) when that text is a valid
 * JSON number; booleans are true/false; NULL is null; everything else is a string.
 */
export function jsonValue(v: Cell | undefined, type: string): string {
  if (v === null || v === undefined) return 'null'
  const kind = columnKind(type)
  if (kind === 'number' && JSON_NUMBER.test(v)) return v
  if (kind === 'boolean' && (v === 'true' || v === 'false')) return v
  return JSON.stringify(v)
}

const PLAIN_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A column name as SQL: bare when it is a plain identifier, otherwise in backticks. */
export function sqlIdentifier(name: string): string {
  return PLAIN_IDENT.test(name) ? name : `\`${name.replace(/`/g, '``')}\``
}

/**
 * A value as a Databricks SQL literal. Numbers and booleans are bare; everything else is a single-quoted
 * string. Databricks reads backslash as an escape and does not take a doubled quote, so both `\` and `'`
 * are backslash-escaped. NULL is `NULL`.
 */
export function sqlLiteral(v: Cell | undefined, type: string): string {
  if (v === null || v === undefined) return 'NULL'
  const kind = columnKind(type)
  if (kind === 'number' && JSON_NUMBER.test(v)) return v
  if (kind === 'boolean' && (v === 'true' || v === 'false')) return v
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** Values of one column, one per line (NULL as an empty line). */
export function columnText(table: CopyTable, col: number): string {
  return table.rows.map((r) => cellText(r[col])).join('\n')
}

/** One row as tab-separated text, no header. */
export function rowText(row: Cell[]): string {
  return row.map(tsvField).join('\t')
}

export interface FormatOptions {
  /** With headers: column names (a header row, JSON keys, or `column IN (...)`). */
  headers: boolean
  /** Index of the column the SQL IN list is built from. Defaults to the first. */
  column?: number
}

/** Rows as text in the chosen format. */
export function formatTable(table: CopyTable, format: CopyFormat, opts: FormatOptions): string {
  const { columns, rows } = table
  const names = columns.map((c) => c.name)
  switch (format) {
    case 'tsv': {
      const lines = rows.map(rowText)
      return (opts.headers ? [names.map(tsvField).join('\t'), ...lines] : lines).join('\n')
    }
    case 'csv': {
      const lines = rows.map((r) => r.map(csvField).join(','))
      return (opts.headers ? [names.map(csvField).join(','), ...lines] : lines).join('\n')
    }
    case 'markdown': {
      const align = columns.map((c) => (columnKind(c.type) === 'number' ? '---:' : '---'))
      const line = (cells: string[]) => `| ${cells.join(' | ')} |`
      const head = opts.headers ? names.map(markdownField) : names.map(() => '')
      return [line(head), line(align), ...rows.map((r) => line(columns.map((_, i) => markdownField(r[i]))))].join('\n')
    }
    case 'json': {
      if (rows.length === 0) return '[]'
      const keys = uniqueNames(names)
      const items = rows.map((r) =>
        opts.headers
          ? `{${columns.map((c, i) => `${JSON.stringify(keys[i])}: ${jsonValue(r[i], c.type)}`).join(', ')}}`
          : `[${columns.map((c, i) => jsonValue(r[i], c.type)).join(', ')}]`,
      )
      return `[\n${items.map((x) => `  ${x}`).join(',\n')}\n]`
    }
    case 'sql-in': {
      const col = opts.column ?? 0
      const type = columns[col]?.type ?? ''
      // NULL never matches IN, and repeated values add nothing, so both are left out.
      const seen = new Set<string>()
      const values: string[] = []
      for (const r of rows) {
        const v = r[col]
        if (v === null || v === undefined || seen.has(v)) continue
        seen.add(v)
        values.push(sqlLiteral(v, type))
      }
      const list = `(${values.join(', ')})`
      return opts.headers ? `${sqlIdentifier(columns[col]?.name ?? '')} IN ${list}` : list
    }
  }
}

/** Names made unique for use as JSON keys: a repeated name gets _2, _3, ... */
function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((n) => {
    const count = (seen.get(n) ?? 0) + 1
    seen.set(n, count)
    return count === 1 ? n : `${n}_${count}`
  })
}
