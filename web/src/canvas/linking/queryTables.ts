// Client for POST /api/query/tables (contracts/api.md section 3). Reads only the SQL text;
// no Databricks call happens on the server for this route.
// Kept outside src/api/ on purpose: it mirrors the request helper in api/client.ts without changing it.

export interface QueryTablesResponse {
  tables: string[]
}

/**
 * Fully qualified table names that `sql` reads, with `{{title}}` references expanded from `windows`
 * when given. Rejects on any non-2xx response. Callers treat a rejection as "no table edges".
 */
export async function fetchQueryTables(sql: string, windows: Record<string, string>): Promise<string[]> {
  const res = await fetch('/api/query/tables', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, windows }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as Partial<QueryTablesResponse> | null
  const tables = data?.tables
  if (!Array.isArray(tables)) return []
  return tables.filter((t): t is string => typeof t === 'string')
}
