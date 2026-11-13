import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import * as api from '../api/client'
import { useDiagrams, useSaveDiagram } from '../api/hooks'
import { useUiStore } from '../store/uiStore'
import { messageOf } from './actions'
import { toDiagramBody, fromDiagram } from './diagram'
import { useGraphStore } from './graphStore'

interface GraphToolbarProps {
  /** The picker is collapsed, so the show-picker button sits in the top-left corner. Leave room for it. */
  showPickerToggle: boolean
}

/** Saved diagrams, load, save, and a status line. Same controls as the legacy header. */
export function GraphToolbar({ showPickerToggle }: GraphToolbarProps) {
  const qc = useQueryClient()
  const diagrams = useDiagrams()
  const save = useSaveDiagram()
  const status = useGraphStore((s) => s.status)
  const connected = useUiStore((s) => s.connectedProfile)
  const [selected, setSelected] = useState('')

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

  async function saveAs() {
    const name = window.prompt('Diagram name?')?.trim()
    if (!name) return
    const g = useGraphStore.getState()
    try {
      await save.mutateAsync(
        toDiagramBody(name, { nodes: g.nodes, edges: g.edges, focusSchema: g.focusSchema }),
      )
      useGraphStore.getState().setStatus(`saved ${name}`)
    } catch (e) {
      useGraphStore.getState().setStatus(messageOf(e), true)
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
      <button onClick={load} disabled={!selected}>
        Load
      </button>
      <button onClick={saveAs} disabled={save.isPending}>
        Save diagram
      </button>
      {diagrams.isError && <span className="error">{diagrams.error.message}</span>}
      <span className="spacer" />
      <span
        className={`graph-status${status.error ? ' error' : ''}`}
        title={status.text}
        role="status"
      >
        {status.text || (connected ? '' : 'not connected')}
      </span>
    </div>
  )
}
