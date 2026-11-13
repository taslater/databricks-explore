import { useEffect } from 'react'
import { Group, Panel, Separator, usePanelRef } from 'react-resizable-panels'
import { CanvasView } from '../canvas/CanvasView'
import { GraphView } from '../graph/GraphView'
import { useUiStore } from '../store/uiStore'
import { DetailsPanel } from './DetailsPanel'
import { Picker } from './Picker'
import { TopBar } from './TopBar'

/** Layout: collapsible picker | main view | details. */
export function AppShell() {
  const view = useUiStore((s) => s.view)
  const pickerCollapsed = useUiStore((s) => s.pickerCollapsed)
  const setPickerCollapsed = useUiStore((s) => s.setPickerCollapsed)
  const pickerRef = usePanelRef()

  // The store is the source of truth. Push changes into the panel; dragging syncs back via onResize.
  useEffect(() => {
    const panel = pickerRef.current
    if (!panel) return
    if (pickerCollapsed) panel.collapse()
    else panel.expand()
  }, [pickerCollapsed, pickerRef])

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
            {view === 'graph' ? <GraphView /> : <CanvasView />}
          </div>
        </Panel>
        <Separator className="resize-handle" />
        <Panel id="details" defaultSize="22%" minSize="10%">
          <DetailsPanel />
        </Panel>
      </Group>
    </div>
  )
}
