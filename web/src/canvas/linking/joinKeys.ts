// Pure helpers over the join keys the server knows (GET /api/relationships/joins): which are usable, how they rank,
// and how they are described. Shared by the editor's completion and by "Query these tables" on the Graph.
import type { JoinKey } from '../../api/types'

/** A key can be written into SQL when it is not rejected and names at least one column pair. */
export const isUsable = (k: JoinKey): boolean => k.status !== 'rejected' && k.pairs.length > 0

/**
 * 0: a declared foreign key, or a mined join the user accepted. 1: a manual relationship.
 * 2: a join proposed from query history, which only counts runs.
 */
export function tier(k: JoinKey): 0 | 1 | 2 {
  if (k.source === 'fk' || k.status === 'accepted') return k.source === 'manual' ? 1 : 0
  return k.source === 'manual' ? 1 : 2
}

/**
 * Better keys sort first: by tier; in the top tier a declared foreign key before an accepted mined join; then by
 * runs (proposed) or by size (a composite key is the more complete join).
 */
export function compareKeys(a: JoinKey, b: JoinKey): number {
  const ta = tier(a)
  const tb = tier(b)
  if (ta !== tb) return ta - tb
  if (ta === 0 && a.source !== b.source) return a.source === 'fk' ? -1 : 1
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

/** The short source line shown next to a suggested condition: `FK`, `mined: 37 runs`, `manual`. */
export function keyDetail(k: JoinKey): string {
  if (k.source === 'fk') return 'FK'
  if (k.source === 'manual') return 'manual'
  const runs = `mined: ${k.runs ?? 0} run${k.runs === 1 ? '' : 's'}`
  return k.status === 'accepted' ? `${runs}, accepted` : runs
}
