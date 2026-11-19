import { useGraphActions } from './actions'
import type { Direction } from './neighbors'
import type { TableNodeData } from './types'

const WORD: Record<Direction, string> = { up: 'upstream', down: 'downstream' }

/** Small counts at a node's left (upstream) and right (downstream) for neighbors not on the Graph. Click adds one hop, Shift-click follows the chain. */
export function NeighborCounts({ id, more }: { id: string; more: TableNodeData['more'] }) {
  const actions = useGraphActions()
  if (!more) return null
  const button = (dir: Direction, n: number) =>
    n > 0 && (
      <button
        className={`tbl-more-count is-${dir} nodrag`}
        title={`${n} more ${WORD[dir]} not on the graph. Click to add them, Shift-click to follow the chain to its end.`}
        onClick={(e) => {
          e.stopPropagation()
          void (e.shiftKey ? actions.followDirection(id, dir) : actions.expandDirection(id, dir))
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {n}
      </button>
    )
  return (
    <>
      {button('up', more.up)}
      {button('down', more.down)}
    </>
  )
}
