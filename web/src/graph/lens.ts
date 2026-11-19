// Lenses: a preset for one question about the graph. The tables stay the same; a lens sets which edge families show, the column
// level and the layout. Also the fact and dimension roles read off key references (inferred for the layout and Details, never
// stored). graph_lens.py keeps the same rules for agents.
import type { GraphEdge, GraphEdgeKind } from '../api/types'
import { FAMILIES, KINDS_OF, familyOf, type EdgeFamily } from './edgeStyles'
import { lastPart } from './format'
import type { EdgeFilters } from './types'

/** all: the whole graph. flow: where does this come from? model: how do these tables join? */
export type Lens = 'all' | 'flow' | 'model'

/** In the order the switch lists them. */
export const LENSES: readonly Lens[] = ['flow', 'model', 'all']

export const DEFAULT_LENS: Lens = 'all'

export const LENS_LABEL: Record<Lens, string> = { flow: 'Flow', model: 'Model', all: 'All' }

/** The question each lens answers, for the switch's tooltips. */
export const LENS_HINT: Record<Lens, string> = {
  flow: 'Where does this come from, and what happens on the way? Data flows left to right, without columns.',
  model: 'How do these tables join? Key references with crow-foot ends and key columns: facts in a middle row, dimensions above and below.',
  all: 'Everything the graph knows, with every edge family you ask for.',
}

/** The edge families a lens shows. */
export const LENS_FAMILIES: Record<Lens, readonly EdgeFamily[]> = { all: ['flow', 'reference'], flow: ['flow'], model: ['reference'] }

/** The column level a lens sets on every table: none, or the keys level. */
export const LENS_COLUMNS: Record<Lens, 'off' | 'keys'> = { all: 'off', flow: 'off', model: 'keys' }

type PresetFilters = Record<EdgeFamily | GraphEdgeKind, boolean>

/** The edge checkboxes a lens sets (the families it shows, every kind on). Superseded and rejected edges are the person's. */
export function presetFilters(lens: Lens): PresetFilters {
  const out = {} as PresetFilters
  for (const f of FAMILIES) {
    out[f] = LENS_FAMILIES[lens].includes(f)
    for (const k of KINDS_OF[f]) out[k] = true
  }
  return out
}

/** The filters have been changed from the lens's own: the lens shows as modified, with a reset. */
export function isModified(filters: EdgeFilters, lens: Lens): boolean {
  const preset = presetFilters(lens)
  return (Object.keys(preset) as Array<keyof PresetFilters>).some((k) => filters[k] !== preset[k])
}

export function parseLens(v: unknown): Lens {
  return v === 'flow' || v === 'model' ? v : DEFAULT_LENS
}

export type Positions = Record<string, { x: number; y: number }>
export type LensPositions = Partial<Record<Lens, Positions>>

/** Reads `lens_positions` (centers, as saved). Malformed entries are skipped. */
export function parseLensPositions(v: unknown): LensPositions {
  const out: LensPositions = {}
  if (typeof v !== 'object' || v === null) return out
  for (const [lens, positions] of Object.entries(v)) {
    if (!LENSES.includes(lens as Lens) || typeof positions !== 'object' || positions === null) continue
    const kept: Positions = {}
    for (const [id, p] of Object.entries(positions)) {
      const q = p as { x?: unknown; y?: unknown } | null
      if (q && typeof q.x === 'number' && typeof q.y === 'number') kept[id] = { x: q.x, y: q.y }
    }
    if (Object.keys(kept).length > 0) out[lens as Lens] = kept
  }
  return out
}

// ---- roles ---------------------------------------------------------------------------------------------------------------

/** What an edge needs to count as a key reference between two tables. */
export interface RefEdge {
  source: string
  target: string
  kind: string
  status?: string
}

/** (referencing table, referenced table) for each pair the reference edges join: not superseded or rejected, no self reference, one per pair. */
export function referencePairs(edges: readonly RefEdge[], ids?: ReadonlySet<string>): Array<[string, string]> {
  const seen = new Set<string>()
  const out: Array<[string, string]> = []
  for (const e of edges) {
    if (familyOf(e.kind as GraphEdgeKind) !== 'reference' || e.status === 'superseded' || e.status === 'rejected' || e.source === e.target) continue
    if (ids && (!ids.has(e.source) || !ids.has(e.target))) continue
    const key = `${e.source}\n${e.target}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push([e.source, e.target])
  }
  return out
}

/**
 * The row of each table a reference touches: 0 for a fact (nothing references it), one further out for each table it references. A
 * table's row is its longest path from a fact, so a dimension of a dimension is further out than the dimension that references it. A
 * part with no fact (a cycle) starts at its first table.
 */
export function depthsOf(ids: readonly string[], pairs: ReadonlyArray<[string, string]>): Map<string, number> {
  const touched = ids.filter((i) => pairs.some(([s, t]) => s === i || t === i))
  const referenced = new Set(pairs.map(([, t]) => t))
  const parent = new Map(touched.map((i) => [i, i]))
  const find = (i: string): string => {
    let root = i
    while (parent.get(root) !== root) root = parent.get(root)!
    parent.set(i, root)
    return root
  }
  for (const [s, t] of pairs) parent.set(find(s), find(t))
  const roots = touched.filter((i) => !referenced.has(i))
  const covered = new Set(roots.map(find))
  for (const i of touched) {
    if (!covered.has(find(i))) {
      covered.add(find(i))
      roots.push(i)
    }
  }
  const size = new Map<string, number>()
  for (const i of touched) size.set(find(i), (size.get(find(i)) ?? 0) + 1)
  const depth = new Map(roots.map((r) => [r, 0]))
  const fixed = new Set(roots)
  for (let n = 0; n < touched.length; n++) {
    let moved = false
    for (const [s, t] of pairs) {
      const d = depth.get(s)
      if (d === undefined || fixed.has(t) || d + 1 <= (depth.get(t) ?? -1) || d + 1 >= size.get(find(t))!) continue
      depth.set(t, d + 1)
      moved = true
    }
    if (!moved) break
  }
  return new Map(touched.map((i) => [i, depth.get(i) ?? 0]))
}

export interface Role {
  role: 'fact' | 'dimension'
  /** Why, in a sentence for Details. */
  reason: string
  depth: number
}

const names = (tables: string[]) => tables.map(lastPart).join(', ')

/** The role of each table a key reference touches. A fact references others and nothing references it; what it references is a dimension. */
export function rolesOf(ids: readonly string[], edges: readonly RefEdge[]): Map<string, Role> {
  const pairs = referencePairs(edges, new Set(ids))
  const out = new Map<string, Role>()
  for (const [id, depth] of depthsOf(ids, pairs)) {
    const refers = pairs.filter(([s]) => s === id).map(([, t]) => t)
    const by = pairs.filter(([, t]) => t === id).map(([s]) => s)
    out.set(
      id,
      depth === 0
        ? {
            role: 'fact',
            depth,
            reason: `references ${names(refers)}${by.length === 0 ? ' and nothing references it' : `, and ${names(by)} reference${by.length === 1 ? 's' : ''} it back (a cycle, so it starts the picture)`}`,
          }
        : { role: 'dimension', depth, reason: `referenced by ${names(by)}${refers.length > 0 ? `, and references ${names(refers)} in turn (a dimension of a dimension)` : ''}` },
    )
  }
  return out
}

/** The roles of the tables on the graph, from its edges. */
export const graphRoles = (ids: readonly string[], edges: readonly GraphEdge[]): Map<string, Role> => rolesOf(ids, edges)

/** Whether any two of these boxes overlap (a layout kept from before no longer fits the sizes the nodes have now). */
export function anyOverlap(boxes: ReadonlyArray<{ x: number; y: number; width: number; height: number }>): boolean {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]
      const b = boxes[j]
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) return true
    }
  }
  return false
}
