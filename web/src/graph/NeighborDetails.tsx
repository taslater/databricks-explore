import { useGraphActions } from './actions'
import { useGraphStore } from './graphStore'
import { countMore, expansionKey, type Direction } from './neighbors'

const SIDES: Array<{ dir: Direction; word: string }> = [
  { dir: 'up', word: 'upstream' },
  { dir: 'down', word: 'downstream' },
]

/** Details for a node: how many neighbors it has that are not on the graph, and buttons to add, follow or collapse one side. */
export function NeighborDetails({ id }: { id: string }) {
  const actions = useGraphActions()
  const set = useGraphStore((s) => s.neighbors[id])
  const nodes = useGraphStore((s) => s.nodes)
  const filters = useGraphStore((s) => s.filters)
  const expansions = useGraphStore((s) => s.expansions)
  if (!set) return null
  const more = countMore(set, new Set(nodes.map((n) => n.id)), filters)
  const rows = SIDES.map(({ dir, word }) => ({ dir, word, n: more[dir], added: (expansions[expansionKey(id, dir)] ?? []).length }))
  if (rows.every((r) => r.n === 0 && r.added === 0)) return null
  return (
    <div>
      <h4>Neighbors not on the graph</h4>
      {rows.map(({ dir, word, n, added }) => (
        <p key={dir}>
          {n} {word}{' '}
          {n > 0 && (
            <>
              <button className="link" onClick={() => void actions.expandDirection(id, dir)}>
                Add {n}
              </button>{' '}
              <button className="link" onClick={() => void actions.followDirection(id, dir)}>
                Follow to the end
              </button>{' '}
            </>
          )}
          {added > 0 && (
            <button className="link" onClick={() => actions.collapseDirection(id, dir)}>
              Collapse
            </button>
          )}
        </p>
      ))}
    </div>
  )
}
