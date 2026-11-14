import { useWarehouses } from '../api/hooks'
import { useUiStore, type MainView } from '../store/uiStore'

const VIEWS: { id: MainView; label: string }[] = [
  { id: 'graph', label: 'Graph' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'concepts', label: 'Concepts' },
  { id: 'ask', label: 'Ask' },
]

export function TopBar() {
  const view = useUiStore((s) => s.view)
  const setView = useUiStore((s) => s.setView)
  const connected = useUiStore((s) => s.connectedProfile)
  const warehouseId = useUiStore((s) => s.warehouseId)
  const warehouses = useWarehouses()
  const warehouseName = warehouseId ? (warehouses.data?.find((w) => w.id === warehouseId)?.name ?? warehouseId) : 'none'

  return (
    <header className="topbar">
      <strong className="app-title">Databricks Explorer</strong>
      <span className="chip" title="Connected profile">
        Profile: {connected ?? 'not connected'}
      </span>
      <span className="chip" title="SQL warehouse">
        Warehouse: {warehouseName}
      </span>
      <span className="spacer" />
      <div className="segmented" role="tablist" aria-label="Main view">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={view === v.id}
            className={view === v.id ? 'active' : undefined}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>
    </header>
  )
}
