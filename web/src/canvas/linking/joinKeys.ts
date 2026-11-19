// Pure helpers over the join keys the server knows (GET /api/relationships/joins): which are usable, how they rank,
// and how they are described. Shared by the editor's completion and by "Query these tables" on the Graph.
import type { JoinKey } from '../../api/types'

/** A key can be written into SQL when it is not rejected and names at least one column pair. */
export const isUsable = (k: JoinKey): boolean => k.status !== 'rejected' && k.pairs.length > 0

/** A view's SQL joins on this key, whether or not anything else knows it. A deliberate join, not a guess. */
export const isViewDefined = (k: JoinKey): boolean => k.source === 'view' || (k.views?.length ?? 0) > 0

/**
 * 0: a declared foreign key, a join a view defines, or a mined join the user accepted. 1: a manual relationship.
 * 2: a join proposed from query history, which only counts runs.
 */
export function tier(k: JoinKey): 0 | 1 | 2 {
  if (k.source === 'fk' || k.status === 'accepted' || isViewDefined(k)) return k.source === 'manual' ? 1 : 0
  return k.source === 'manual' ? 1 : 2
}

const topRank = (k: JoinKey): number => (k.source === 'fk' ? 0 : isViewDefined(k) ? 1 : 2)

/**
 * Better keys sort first: by tier; in the top tier a declared foreign key, then a view-defined join, then an accepted
 * mined join; then by runs (proposed) or by size (a composite key is the more complete join).
 */
export function compareKeys(a: JoinKey, b: JoinKey): number {
  const ta = tier(a)
  const tb = tier(b)
  if (ta !== tb) return ta - tb
  if (ta === 0 && topRank(a) !== topRank(b)) return topRank(a) - topRank(b)
  const runs = (b.runs ?? 0) - (a.runs ?? 0)
  const size = b.pairs.length - a.pairs.length
  return ta === 2 ? runs || size : size || runs
}

const identity = (k: JoinKey): string =>
  k.pairs
    .map((p) => `${p.here}\u0000${p.there}`)
    .sort()
    .join('\u0001')

/** The same pairs, seen from the other table. */
export const flipKey = (k: JoinKey): JoinKey => ({ ...k, pairs: k.pairs.map((p) => ({ here: p.there, there: p.here })) })

/** Usable keys, best first. A key that appears twice (from both tables' routes) is kept once, in its better form. */
export function rankKeys(keys: readonly JoinKey[]): JoinKey[] {
  const best = new Map<string, JoinKey>()
  for (const k of keys) {
    if (!isUsable(k)) continue
    const id = identity(k)
    const old = best.get(id)
    if (!old || compareKeys(k, old) < 0) best.set(id, k)
  }
  return [...best.values()].sort(compareKeys)
}

const lastPart = (t: string) => t.split('.').pop() ?? t

/** The views of a key, by short name: `orders_enriched` or `a, b`. */
export const viewNames = (k: JoinKey): string => (k.views ?? []).map(lastPart).join(', ')

/** The short source line shown next to a suggested condition: `FK`, `view: v`, `mined: 37 runs, also in view v`, `manual`. */
export function keyDetail(k: JoinKey): string {
  if (k.source === 'fk') return 'FK'
  if (k.source === 'manual') return 'manual'
  if (k.source === 'view') return `view: ${viewNames(k)}`
  const runs = `mined: ${k.runs ?? 0} run${k.runs === 1 ? '' : 's'}`
  const text = k.status === 'accepted' ? `${runs}, accepted` : runs
  return isViewDefined(k) ? `${text}, also in view ${viewNames(k)}` : text
}
