import { useState } from 'react'
import { useWarehouses } from '../api/hooks'
import { AgentCanvasSync } from '../canvas/persistence/AgentCanvasSync'
import { useUiStore, type MainView } from '../store/uiStore'
import { AgentAccessPanel } from './AgentAccessPanel'
import { ThemeToggle } from './ThemeToggle'

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
  const [agentPanelOpen, setAgentPanelOpen] = useState(false)
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
      <AgentCanvasSync />
      <button onClick={() => setAgentPanelOpen(true)} title="Let a coding agent use this app through MCP">
        Agent access
      </button>
      <ThemeToggle />
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
      {agentPanelOpen && <AgentAccessPanel onClose={() => setAgentPanelOpen(false)} />}
    </header>
  )
}
