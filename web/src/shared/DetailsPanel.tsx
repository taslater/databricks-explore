import { GraphDetails } from '../graph/GraphDetails'
import { useUiStore } from '../store/uiStore'

/** Right panel. Shows the graph's details and filters on the graph view. The canvas has no details yet. */
export function DetailsPanel() {
  const view = useUiStore((s) => s.view)
  if (view === 'graph') return <GraphDetails />
  return (
    <div className="details">
      <div className="panel-header">
        <strong>Details</strong>
      </div>
      <p className="hint">Select an item to see its details.</p>
    </div>
  )
}
