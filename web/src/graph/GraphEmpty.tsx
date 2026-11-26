import { useGraphStore } from './graphStore'
import { useUiStore } from '../store/uiStore'

/** What an empty Graph canvas says: how to put the first table on it, with one button that goes to the picker's filter. */
export function GraphEmpty() {
  const empty = useGraphStore((s) => s.nodes.length === 0)
  const setPickerCollapsed = useUiStore((s) => s.setPickerCollapsed)
  if (!empty) return null

  function findTable() {
    setPickerCollapsed(false)
    // The picker may have just opened, so look for its filter after it has rendered.
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.pick-filter')?.focus())
  }

  return (
    <div className="graph-empty">
      <div className="graph-empty-card">
        <h3>Nothing on the graph yet</h3>
        <p>Add a table from the picker, then double-click it to bring in the tables it joins, reads from or feeds.</p>
        <button onClick={findTable}>Find a table</button>
      </div>
    </div>
  )
}
