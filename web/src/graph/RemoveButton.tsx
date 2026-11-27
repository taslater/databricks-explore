// The details panel's Remove button: takes the selected tables off the graph.
import { useGraphStore } from './graphStore'
import { removalTargets, removeSelected } from './removal'

/** Removes the tables ticked on the graph, or the one whose details are open. Disabled when there is none. */
export function RemoveButton() {
  const count = useGraphStore((s) => removalTargets(s.nodes, s.selection).length)
  return (
    <button
      className="danger"
      onClick={() => removeSelected()}
      disabled={count === 0}
      title="Take the selected tables off the graph, with their edges (Delete or Backspace). A neighbor's count, the picker or Add to graph brings one back."
    >
      {count > 1 ? `Remove ${count} tables` : 'Remove from graph'}
    </button>
  )
}
