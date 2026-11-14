import { useEffect } from 'react'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import { AskView } from '../ask/AskView'
import { CanvasView } from '../canvas/CanvasView'
import { ConceptsView } from '../concepts/ConceptsView'
import { GraphView } from '../graph/GraphView'
import { useUiStore } from '../store/uiStore'
import { DetailsPanel } from './DetailsPanel'
import { Picker } from './Picker'
import { TopBar } from './TopBar'

/** Layout: collapsible picker | main view | details. */
export function AppShell() {
  const view = useUiStore((s) => s.view)
  const canvasDetailsOpen = useUiStore((s) => s.canvasDetailsOpen)
  const pickerCollapsed = useUiStore((s) => s.pickerCollapsed)
  const setPickerCollapsed = useUiStore((s) => s.setPickerCollapsed)
  const pickerRef = usePanelRef()
  const detailsRef = usePanelRef()

  // The store is the source of truth. Push changes into the panel; dragging syncs back via onResize.
  useEffect(() => {
    const panel = pickerRef.current
    if (!panel) return
    if (pickerCollapsed) panel.collapse()
    else panel.expand()
  }, [pickerCollapsed, pickerRef])

  // The canvas keeps Details collapsed until its Properties button opens it, and Concepts and Ask have no use for it. The graph always shows it.
  useEffect(() => {
    const panel = detailsRef.current
    if (!panel) return
    if ((view === 'canvas' && !canvasDetailsOpen) || view === 'concepts' || view === 'ask') panel.collapse()
    else panel.expand()
  }, [view, canvasDetailsOpen, detailsRef])

  return (
    <div className="shell">
      <TopBar />
      <Group orientation="horizontal" className="workspace">
        <Panel
          id="picker"
          panelRef={pickerRef}
          defaultSize="20%"
          minSize="12%"
          collapsible
          collapsedSize="0%"
          onResize={() => setPickerCollapsed(pickerRef.current?.isCollapsed() ?? false)}
        >
          <Picker onCollapse={() => setPickerCollapsed(true)} />
        </Panel>
        <Separator className="resize-handle" />
        <Panel id="main" minSize="30%">
          <div className="main">
            {pickerCollapsed && (
              <button
                className="show-picker"
                onClick={() => setPickerCollapsed(false)}
                title="Show picker"
                aria-label="Show picker"
              >
                »
              </button>
            )}
            {view === 'graph' ? (
              <GraphView />
            ) : view === 'concepts' ? (
              <ConceptsView />
            ) : view === 'ask' ? (
              <AskView />
            ) : (
              <CanvasView />
            )}
          </div>
        </Panel>
        <Separator className="resize-handle" />
        <Panel id="details" panelRef={detailsRef} defaultSize="22%" minSize="10%" collapsible collapsedSize="0%">
          <DetailsPanel />
        </Panel>
      </Group>
    </div>
  )
}
