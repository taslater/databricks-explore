import { GraphDetails } from '../graph/GraphDetails'
import { useCanvasStore } from '../store/canvasStore'
import { SketchProperties } from '../sketch/panels/Properties'
import { useUiStore } from '../store/uiStore'

/** Right panel. Shows the graph's details and filters on the graph view, and the sketch's properties on the canvas. */
export function DetailsPanel() {
  const view = useUiStore((s) => s.view)
  const canvasName = useCanvasStore((s) => s.canvasName)
  if (view === 'graph') return <GraphDetails />
  return <SketchProperties canvasName={canvasName} />
}
