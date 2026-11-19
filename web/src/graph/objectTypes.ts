// Object type groups for the picker's type filter: which group a Unity Catalog type belongs to, and the counts shown.

export type TypeGroup = 'table' | 'view' | 'materialized_view' | 'metric_view' | 'function'

/** The groups in the order the chips show them. `title` is the full name, `label` fits a chip. */
export const TYPE_GROUPS: { id: TypeGroup; label: string; title: string }[] = [
  { id: 'table', label: 'Tables', title: 'Tables: managed, external, foreign and streaming' },
  { id: 'view', label: 'Views', title: 'Views' },
  { id: 'materialized_view', label: 'Mat. views', title: 'Materialized views' },
  { id: 'metric_view', label: 'Metric views', title: 'Metric views' },
  { id: 'function', label: 'Functions', title: 'Functions' },
]

const IDS = new Set<string>(TYPE_GROUPS.map((g) => g.id))

/** The group of a `table_type` (MANAGED, VIEW, METRIC_VIEW, ...) or of "FUNCTION". Anything else, or no type, counts as a table. */
export function typeGroup(type: string | null | undefined): TypeGroup {
  const t = (type ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
  if (t === 'function') return 'function'
  if (t === 'metric_view') return 'metric_view'
  if (t === 'materialized_view') return 'materialized_view'
  if (t.includes('view')) return 'view'
  return 'table'
}

export const isFunction = (type: string | null | undefined): boolean => typeGroup(type) === 'function'

/** True when an object of this type passes the filter. An empty selection passes everything. */
export function passesTypes(type: string | null | undefined, selected: readonly TypeGroup[]): boolean {
  return selected.length === 0 || selected.includes(typeGroup(type))
}

/** The groups that occur in a list of types. */
export function presentGroups(types: Iterable<string | null | undefined>): Set<TypeGroup> {
  const out = new Set<TypeGroup>()
  for (const t of types) out.add(typeGroup(t))
  return out
}

/** "12" when nothing is filtered out, else "12 of 80". */
export function countText(shown: number, total: number): string {
  return shown === total ? `${total}` : `${shown} of ${total}`
}

/** Reads the saved selection (a JSON array), dropping anything that is not a group. */
export function parseTypes(raw: string | null): TypeGroup[] {
  try {
    const v: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? TYPE_GROUPS.map((g) => g.id).filter((id) => v.includes(id) && IDS.has(id)) : []
  } catch {
    return []
  }
}

/** The selection with `group` switched on or off, in chip order. */
export function toggleType(selected: readonly TypeGroup[], group: TypeGroup): TypeGroup[] {
  const next = selected.includes(group) ? selected.filter((g) => g !== group) : [...selected, group]
  return TYPE_GROUPS.map((g) => g.id).filter((id) => next.includes(id))
}
