// Table constraints from Unity Catalog, as one readable line each. Pure: no React, no fetch.

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const record = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/**
 * One line for one constraint of `tables.get`:
 * `Primary key: order_id, line_no`, `Foreign key fk_x: order_id → demo.sales.orders.order_id` (a composite one reads
 * `Foreign key fk_x: (a, b) → demo.sales.orders (x, y)`), and `Constraint name` for one that only has a name.
 * A shape it does not know is shown as JSON, so nothing is hidden.
 */
export function formatConstraint(constraint: unknown): string {
  const c = record(constraint)
  const pk = record(c?.primary_key_constraint)
  if (pk) return `Primary key: ${strings(pk.child_columns).join(', ')}`
  const fk = record(c?.foreign_key_constraint)
  if (fk) {
    const child = strings(fk.child_columns)
    const parent = strings(fk.parent_columns)
    const table = text(fk.parent_table)
    const name = text(fk.name)
    const ends =
      child.length === 1 && parent.length === 1
        ? `${child[0]} → ${table}.${parent[0]}`
        : `(${child.join(', ')}) → ${table} (${parent.join(', ')})`
    return `Foreign key${name ? ` ${name}` : ''}: ${ends}`
  }
  const named = record(c?.named_table_constraint)
  if (named && text(named.name)) return `Constraint ${text(named.name)}`
  return JSON.stringify(constraint)
}

/** The lines for every constraint of a table, in the order Unity Catalog lists them. */
export const formatConstraints = (constraints: readonly unknown[] | undefined): string[] =>
  (constraints ?? []).map(formatConstraint)
