import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import * as api from '../api/client'
import { useDiagrams, useSaveDiagram } from '../api/hooks'
import { CertificationControl } from '../concepts/CertificationControl'
import { useUiStore } from '../store/uiStore'
import { messageOf } from './actions'
import { toDiagramBody, fromDiagram } from './diagram'
import { useMiningWatcher } from './MiningPanel'
import { useSuggestions } from '../api/hooks'
import { useGraphActions } from './actions'
import { useGraphStore } from './graphStore'
import { NameDialog } from '../shared/Dialog'

interface GraphToolbarProps {
  /** The picker is collapsed, so the show-picker button sits in the top-left corner. Leave room for it. */
  showPickerToggle: boolean
}

/** Buttons keep their label on one line; only the status text gives way when the bar is full. */
const NOWRAP = { whiteSpace: 'nowrap', flexShrink: 0 } as const

/** Saved diagrams, load, save, and a status line. Same controls as the legacy header. */
export function GraphToolbar({ showPickerToggle }: GraphToolbarProps) {
  const qc = useQueryClient()
  const diagrams = useDiagrams()
  const save = useSaveDiagram()
  const status = useGraphStore((s) => s.status)
  const connected = useUiStore((s) => s.connectedProfile)
  const [selected, setSelected] = useState('')
  const [naming, setNaming] = useState(false)
  const actions = useGraphActions()
  const drawer = useGraphStore((s) => s.drawer)
  const showConcepts = useGraphStore((s) => s.showConcepts)
  // The setting, not a count of nodes: a node added later follows it, so the label does not flip back.
  const allColumns = useGraphStore((s) => s.columnsOn)
  const hasNodes = useGraphStore((s) => s.nodes.length > 0)
  const proposed = useSuggestions('proposed').data?.counts.proposed
  useMiningWatcher()
  const toggleDrawer = (d: 'suggestions' | 'usage') => useGraphStore.getState().setDrawer(drawer === d ? null : d)

  async function load() {
    if (!selected) return
    const { setStatus } = useGraphStore.getState()
    try {
      const d = await qc.fetchQuery({
        queryKey: ['diagram', selected],
        queryFn: () => api.getDiagram(selected),
        staleTime: 0,
        retry: false,
      })
      useGraphStore.getState().loadDiagram(fromDiagram(d))
      setStatus(`loaded diagram ${selected} (saved ${d.saved_at})`)
    } catch (e) {
      setStatus(messageOf(e), true)
    }
  }

  /** Saves under `name`. Returns an error message for the dialog to show, or null when it saved. */
  async function saveAs(name: string): Promise<string | null> {
    const g = useGraphStore.getState()
    try {
      await save.mutateAsync(
        toDiagramBody(name, { nodes: g.nodes, edges: g.edges, focusSchema: g.focusSchema }),
      )
      useGraphStore.getState().setStatus(`saved ${name}`)
      setNaming(false)
      return null
    } catch (e) {
      return messageOf(e)
    }
  }

  return (
    <div className={`graph-toolbar${showPickerToggle ? ' with-picker-toggle' : ''}`}>
      <select
        value={selected}
        onChange={(e) => setSelected(e.target.value)}
        aria-label="Saved diagrams"
        disabled={!diagrams.data}
      >
        <option value="">— saved diagrams —</option>
        {diagrams.data?.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <button onClick={load} disabled={!selected} style={NOWRAP}>
        Load
      </button>
      <button onClick={() => setNaming(true)} disabled={save.isPending} style={NOWRAP}>
        Save diagram
      </button>
      {diagrams.isError && <span className="error">{diagrams.error.message}</span>}
      <span className="toolbar-sep" />
      <button
        style={NOWRAP}
        onClick={() => useGraphStore.getState().setMineDialog(true)}
        disabled={!connected}
        title="Read query history for joins between tables. Shows the SQL first."
      >
        Mine joins…
      </button>
      <button style={NOWRAP} onClick={() => toggleDrawer('suggestions')} aria-pressed={drawer === 'suggestions'} disabled={!connected}>
        Suggestions{proposed ? ` (${proposed})` : ''}
      </button>
      <button style={NOWRAP} onClick={() => toggleDrawer('usage')} aria-pressed={drawer === 'usage'} disabled={!connected}>
        Usage
      </button>
      <button
        style={NOWRAP}
        onClick={() => void actions.setAllColumns(!allColumns)}
        disabled={!hasNodes}
        title="Show or hide the columns of every table on the graph"
      >
        {allColumns ? 'Hide columns' : 'Show columns'}
      </button>
      <button
        style={NOWRAP}
        onClick={() => useGraphStore.getState().setShowConcepts(!showConcepts)}
        aria-pressed={showConcepts}
        disabled={!connected}
        title="Draw the glossary concepts linked to the tables on the graph"
      >
        Concepts
      </button>
      <CertificationControl />
      <span className="spacer" />
      <span
        style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        className={`graph-status${status.error ? ' error' : ''}`}
        title={status.text}
        role="status"
      >
        {status.text || (connected ? '' : 'not connected')}
      </span>
      {naming && (
        <NameDialog
          title="Save diagram"
          label="Diagram name"
          onSubmit={saveAs}
          onCancel={() => setNaming(false)}
        />
      )}
    </div>
  )
}
