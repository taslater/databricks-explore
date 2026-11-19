// Pure SQL generation for "Script as": quoting names, explicit-column SELECTs and the other one-line statements.

/** Words that need backticks when used as a name. Not every Databricks keyword, only the ones that break a plain name. */
const RESERVED = new Set(
  (
    'all alter and anti any array as at between by case cast check column constraint create cross cube current ' +
    'current_date current_timestamp current_user default delete describe distinct drop else end escape except exists ' +
    'false fetch filter for foreign from full function grant group grouping having in inner insert intersect into ' +
    'is join lateral left like limit minus natural no not null of offset on only or order outer over partition ' +
    'primary range references revoke right rollup row rows select semi set show some table tablesample then to ' +
    'trailing true truncate union unique unknown update using values when where window with'
  ).split(' '),
)

const PLAIN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A name as it is written in SQL: bare when it is a plain identifier that is not a reserved word, else in backticks. */
export function quoteIdent(name: string): string {
  if (PLAIN.test(name) && !RESERVED.has(name.toLowerCase())) return name
  return `\`${name.replace(/`/g, '``')}\``
}

/** `catalog.schema.table` with each part quoted only when it needs it. Parts are split on dots. */
export function quoteFullName(fullName: string): string {
  return fullName.split('.').map(quoteIdent).join('.')
}

/** The kinds of object the menu tells apart. */
export type ObjectKind = 'table' | 'view' | 'metric_view' | 'materialized_view' | 'streaming_table'

/** The kind from a Unity Catalog `table_type` (MANAGED, EXTERNAL, VIEW, MATERIALIZED_VIEW, ...). Unknown means table. */
export function objectKind(tableType: string | null | undefined): ObjectKind {
  const t = (tableType ?? '').toLowerCase()
  if (t === 'metric_view') return 'metric_view'
  if (t === 'materialized_view') return 'materialized_view'
  if (t === 'streaming_table') return 'streaming_table'
  if (t.includes('view')) return 'view'
  return 'table'
}

/** Views have no Delta log, so DESCRIBE DETAIL and DESCRIBE HISTORY do not apply to them. */
export function hasDeltaLog(kind: ObjectKind): boolean {
  return kind === 'table' || kind === 'materialized_view' || kind === 'streaming_table'
}

/** SELECT with one column per line (`*` when no columns are known) and a LIMIT. */
export function selectSql(fullName: string, columns: readonly string[], limit = 10): string {
  const list = columns.length ? columns.map((c) => `  ${quoteIdent(c)}`).join(',\n') : '  *'
  return `SELECT\n${list}\nFROM ${quoteFullName(fullName)}\nLIMIT ${limit}`
}

/** `SELECT COUNT(*) FROM name`. */
export function countSql(fullName: string): string {
  return `SELECT COUNT(*) AS row_count\nFROM ${quoteFullName(fullName)}`
}

/** DESCRIBE DETAIL, for tables backed by a Delta log. */
export function describeDetailSql(fullName: string): string {
  return `DESCRIBE DETAIL ${quoteFullName(fullName)}`
}

/** DESCRIBE HISTORY, for tables backed by a Delta log. */
export function describeHistorySql(fullName: string): string {
  return `DESCRIBE HISTORY ${quoteFullName(fullName)}`
}

/** DESCRIBE FUNCTION EXTENDED: the signature, body and owner of a user-defined function. */
export function describeFunctionSql(fullName: string): string {
  return `DESCRIBE FUNCTION EXTENDED ${quoteFullName(fullName)}`
}

/** SHOW CREATE TABLE; Databricks accepts it for views too. */
export function showCreateSql(fullName: string): string {
  return `SHOW CREATE TABLE ${quoteFullName(fullName)}`
}

/** A comma-separated column list for pasting, quoted where needed. */
export function columnList(columns: readonly string[]): string {
  return columns.map(quoteIdent).join(', ')
}

/** Column names from a `tables.get` payload's `columns`, in table order, skipping entries with no name. */
export function columnNames(columns: ReadonlyArray<{ name?: unknown }> | undefined): string[] {
  const out: string[] = []
  for (const c of columns ?? []) if (typeof c.name === 'string' && c.name) out.push(c.name)
  return out
}
