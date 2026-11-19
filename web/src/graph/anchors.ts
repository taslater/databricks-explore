// Which sides of a Graph node carry edges in both directions (see shared/anchors.ts), read from the handles edges use.
import { splitSides, type AnchorEnd } from '../shared/anchors'

const TABLE_HANDLE = /^(src|tgt)-([lrtb])$/
const COLUMN_HANDLE = /^([st])-([lr]):(.*)$/

/** The end an edge makes at one handle of its node, or null for an unknown handle. A source handle is outgoing, a target handle incoming. */
export function endAt(node: string, handle: string | null | undefined): AnchorEnd | null {
  if (!handle) return null
  const t = TABLE_HANDLE.exec(handle)
  if (t) return { node, key: t[2], role: t[1] === 'src' ? 'out' : 'in' }
  const c = COLUMN_HANDLE.exec(handle)
  if (c) return { node, key: `${c[2]}:${c[3]}`, role: c[1] === 's' ? 'out' : 'in' }
  return null
}

/** Per node, the side keys to split: a side (`r`) for a table handle, `side:column` (`r:order_id`) for a column row. Hidden edges count for nothing. */
export function graphSplits(
  edges: ReadonlyArray<{ source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null; hidden?: boolean }>,
): Map<string, string[]> {
  const ends: AnchorEnd[] = []
  for (const e of edges) {
    if (e.hidden) continue
    for (const end of [endAt(e.source, e.sourceHandle), endAt(e.target, e.targetHandle)]) if (end) ends.push(end)
  }
  return splitSides(ends)
}
