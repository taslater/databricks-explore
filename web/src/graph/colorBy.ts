// "Color by": what a node's fill means. One thing at a time: type (the default), schema, catalog, owner, a tag, certification or freshness.
// The value-to-color map is stable: a value hashes to a palette slot, so it keeps its color in every graph.
import type { NodeFacts } from '../api/nodeFacts'
import type { NodeMeta } from '../api/nodeMeta'
import { hashText, NO_VALUE_FILL, nodeFill, OTHER_FILL, PALETTE } from './format'

export type ColorBy = 'type' | 'schema' | 'catalog' | 'owner' | 'certification' | 'freshness' | `tag:${string}`

export const MODES: Array<{ id: Exclude<ColorBy, `tag:${string}`> | 'tag'; label: string }> = [
  { id: 'type', label: 'Type' },
  { id: 'schema', label: 'Schema' },
  { id: 'catalog', label: 'Catalog' },
  { id: 'owner', label: 'Owner' },
  { id: 'tag', label: 'Tag' },
  { id: 'certification', label: 'Certification' },
  { id: 'freshness', label: 'Freshness' },
]

const PLAIN = new Set<string>(['type', 'schema', 'catalog', 'owner', 'certification', 'freshness'])

/** The saved `color_by` of a graph; anything unknown (or missing) is the default, type. */
export function parseColorBy(v: unknown): ColorBy {
  if (typeof v !== 'string') return 'type'
  if (PLAIN.has(v)) return v as ColorBy
  return v.startsWith('tag:') && v.slice(4).trim() !== '' ? (v as ColorBy) : 'type'
}

export const isTagMode = (c: ColorBy): c is `tag:${string}` => c.startsWith('tag:')
export const tagKeyOf = (c: ColorBy): string => (isTagMode(c) ? c.slice(4) : '')

/** The title of the legend and the menu: "schema", "tag domain". */
export const colorByLabel = (c: ColorBy): string => (isTagMode(c) ? `tag ${tagKeyOf(c)}` : c)

/** What the colors need to know about one node. */
export interface ColorInput {
  id: string
  /** `catalog.schema`. */
  schema: string
  missing?: boolean
  certification?: string
  facts?: NodeFacts
}

/** Colors that mean something by themselves (certification, freshness) are fixed rather than hashed. */
const FIXED: Record<string, Record<string, string>> = {
  certification: { certified: PALETTE[3], deprecated: PALETTE[0] },
  freshness: { late: PALETTE[1], 'on time': PALETTE[3] },
}

/** The value of one node for a mode, or null when it has none (it stays white). Never called for type. */
export function valueOf(mode: ColorBy, n: ColorInput, meta?: NodeMeta): string | null {
  if (n.missing || n.id.startsWith('ph:')) return null
  if (mode === 'schema') return n.schema
  if (mode === 'catalog') return n.id.split('.')[0] ?? null
  if (mode === 'owner') return meta?.owner || null
  if (mode === 'certification') return n.certification ?? null
  if (mode === 'freshness') {
    const s = n.facts?.stats
    return s && s.last_write && s.cadence_seconds !== null ? (s.late ? 'late' : 'on time') : null
  }
  if (isTagMode(mode)) {
    const v = meta?.tags?.[tagKeyOf(mode)]
    return v === undefined ? null : v === '' ? '(set)' : v
  }
  return null
}

/**
 * The fill of each value. Up to eight values get a palette slot, the ones on most nodes first (ties by name); the
 * rest are "other". A value starts at the slot its hash names and takes the next free one, going through the values
 * in sorted order, so the same set of values always gets the same colors.
 */
export function valueColors(counts: Map<string, number>): { fills: Map<string, string>; other: string[] } {
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([v]) => v)
  const top = ranked.slice(0, PALETTE.length).sort()
  const taken = new Set<number>()
  const fills = new Map<string, string>()
  for (const v of top) {
    let slot = hashText(v) % PALETTE.length
    while (taken.has(slot)) slot = (slot + 1) % PALETTE.length
    taken.add(slot)
    fills.set(v, PALETTE[slot])
  }
  return { fills, other: ranked.slice(PALETTE.length).sort() }
}

export interface LegendEntry {
  value: string
  fill: string
  count: number
}

export interface NodeColors {
  /** Table node id -> fill, for every node (no value is white). */
  fills: Map<string, string>
  /** The values on screen, sorted, and the "other" bucket. */
  legend: { entries: LegendEntry[]; other: { values: number; count: number } | null }
}

/** The fill of each node and the legend for a mode other than type. */
export function colorNodes(mode: ColorBy, nodes: ColorInput[], meta: Record<string, NodeMeta> | undefined): NodeColors {
  const values = new Map<string, string | null>(nodes.map((n) => [n.id, valueOf(mode, n, meta?.[n.id])]))
  const counts = new Map<string, number>()
  for (const v of values.values()) if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1)
  const fixed = FIXED[mode]
  const { fills: byValue, other } = fixed ? { fills: new Map(Object.entries(fixed)), other: [] as string[] } : valueColors(counts)
  const otherSet = new Set(other)
  const fills = new Map<string, string>()
  for (const [id, v] of values) fills.set(id, v === null ? NO_VALUE_FILL : otherSet.has(v) ? OTHER_FILL : (byValue.get(v) ?? OTHER_FILL))
  const entries = [...counts]
    .filter(([v]) => !otherSet.has(v))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([value, count]) => ({ value, fill: byValue.get(value) ?? OTHER_FILL, count }))
  const otherCount = other.reduce((n, v) => n + (counts.get(v) ?? 0), 0)
  return { fills, legend: { entries, other: other.length > 0 ? { values: other.length, count: otherCount } : null } }
}

/** The type colors: three fills, by what the object is. The legend in type mode lists the ones on screen. */
export const TYPE_GROUPS: Array<{ id: string; label: string; kinds: string[] }> = [
  { id: 'table', label: 'table', kinds: ['table', 'managed', 'external', 'foreign'] },
  { id: 'view', label: 'view / MV', kinds: ['view', 'materialized_view', 'metric_view'] },
  { id: 'streaming', label: 'streaming', kinds: ['streaming_table'] },
]

/** The type fills present among these kinds, with how many nodes each colors. */
export function typeLegend(kinds: string[]): LegendEntry[] {
  const out: LegendEntry[] = []
  for (const g of TYPE_GROUPS) {
    const count = kinds.filter((k) => g.kinds.includes(k)).length
    if (count > 0) out.push({ value: g.label, fill: nodeFill(g.kinds[0]), count })
  }
  const known = new Set(TYPE_GROUPS.flatMap((g) => g.kinds))
  const rest = kinds.filter((k) => !known.has(k)).length
  if (rest > 0) out.push({ value: 'other', fill: nodeFill(''), count: rest })
  return out
}

/** The same nodes, each table with its `fill`. Untouched when there are no fills (type mode). */
export function withFills<N extends { id: string; data: object }>(nodes: N[], fills: Map<string, string> | null): N[] {
  if (!fills) return nodes
  return nodes.map((n) => (fills.has(n.id) ? { ...n, data: { ...n.data, fill: fills.get(n.id) } } : n))
}

/** The distinct tag keys across these tables' tags, sorted, without the `system.` tags that have their own place (certification). */
export function tagKeys(meta: Record<string, NodeMeta> | undefined): string[] {
  const keys = new Set<string>()
  for (const m of Object.values(meta ?? {})) for (const k of Object.keys(m.tags ?? {})) if (!k.startsWith('system.')) keys.add(k)
  return [...keys].sort()
}
