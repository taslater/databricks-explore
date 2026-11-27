import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { hasWrapped, useOverflowLevel } from '../shared/useOverflowLevel'
import * as api from '../api/client'
import { useDiagrams } from '../api/hooks'
import { CertificationControl } from '../concepts/CertificationControl'
import { useUiStore } from '../store/uiStore'
import { messageOf } from './actions'
import { toDiagramBody, fromDiagram } from './diagram'
import { ColorByControl } from './ColorByControl'
import { GroupControl } from './CollapseControls'
import { LensSwitch } from './LensSwitch'
import { GraphExportButton } from './GraphExport'
import { useMiningWatcher } from './MiningPanel'
import { ProfileButton } from './ProfileDialog'
import { TableStatsButton } from './TableStatsDialog'
import { useSuggestions } from '../api/hooks'
import { useGraphActions } from './actions'
import { useGraphStore } from './graphStore'
import { ConfirmDialog, NameDialog } from '../shared/Dialog'
import {
  DiagramConflict,
  deleteDiagram,
  getDiagramRevision,
  renameDiagram,
  saveDiagramChecked,
  storedName,
  type DiagramRevision,
} from '../api/diagrams'
import { currentSignature, reloadOpenDiagram, useDiagramSync } from './diagramSync'

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
  const openDiagram = useGraphStore((s) => s.openDiagram)
  const changed = useGraphStore((s) => s.diagramChanged)
  const [saving, setSaving] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  /** A save refused because an agent saved the graph since this page loaded it: the person decides whether to overwrite. */
  const [overwrite, setOverwrite] = useState<{ name: string; remote: DiagramRevision } | null>(null)
  const status = useGraphStore((s) => s.status)
  const connected = useUiStore((s) => s.connectedProfile)
  const [selected, setSelected] = useState('')
  const [naming, setNaming] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const actions = useGraphActions()
  const drawer = useGraphStore((s) => s.drawer)
  const showConcepts = useGraphStore((s) => s.showConcepts)
  // The setting, not a count of nodes: a node added later follows it, so the label does not flip back.
  const allColumns = useGraphStore((s) => s.columnsOn)
  const hasNodes = useGraphStore((s) => s.nodes.length > 0)
  const proposed = useSuggestions('proposed').data?.counts.proposed
  useEffect(() => {
    if (!toolsOpen) return
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) setToolsOpen(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [toolsOpen])
  // When a row would wrap (a wide font, a narrow window), Show columns and Concepts, then Color by and Group by, move into Tools.
  const barRef = useRef<HTMLDivElement>(null)
  const overflow = useOverflowLevel(barRef, 2, (el) => Array.from(el.querySelectorAll<HTMLElement>(':scope > .tb-row:not(.tb-tools)')).some(hasWrapped))
  useMiningWatcher()
  useDiagramSync()
  const toggleDrawer = (d: 'suggestions' | 'usage') => useGraphStore.getState().setDrawer(drawer === d ? null : d)

  async function load() {
    if (!selected) return
    const { setStatus } = useGraphStore.getState()
    try {
      // The revision first and the file second: a write in between only makes the page reload once more.
      const revision = await getDiagramRevision(selected).catch(() => null)
      const d = await qc.fetchQuery({
        queryKey: ['diagram', selected],
        queryFn: () => api.getDiagram(selected),
        staleTime: 0,
        retry: false,
      })
      useGraphStore.getState().loadDiagram(fromDiagram(d))
      useGraphStore
        .getState()
        .setOpenDiagram(revision && { name: revision.name, revision: revision.revision, signature: currentSignature() })
      setStatus(`loaded diagram ${selected} (saved ${d.saved_at})`)
    } catch (e) {
      setStatus(messageOf(e), true)
    }
  }

  /**
   * Saves under `name`, checking against the revision the page loaded when it is the same graph. Returns an error
   * message for the dialog to show, or null when it saved or the person is being asked about a newer save.
   */
  async function saveAs(name: string, base?: number | null): Promise<string | null> {
    const g = useGraphStore.getState()
    const open = g.openDiagram
    const checked = base !== undefined ? base : open && open.name === storedName(name) ? open.revision : null
    g.setDiagramSaving(true)
    setSaving(true)
    try {
      const res = await saveDiagramChecked(
        toDiagramBody(name, { nodes: g.nodes, edges: g.edges, focusSchema: g.focusSchema, colorBy: g.colorBy, grouping: g.grouping, lens: g.lens, lensPositions: g.lensPositions }),
        checked,
      )
      void qc.invalidateQueries({ queryKey: ['diagrams'] })
      useGraphStore
        .getState()
        .setOpenDiagram({ name: res.saved, revision: res.revision ?? 0, signature: currentSignature() })
      useGraphStore.getState().setStatus(`saved ${name}`)
      setNaming(false)
      setOverwrite(null)
      return null
    } catch (e) {
      if (e instanceof DiagramConflict) {
        setNaming(false)
        setOverwrite({ name, remote: e.remote })
        return null
      }
      return messageOf(e)
    } finally {
      useGraphStore.getState().setDiagramSaving(false)
      setSaving(false)
    }
  }

  /** Renames the selected graph. Returns an error message for the dialog, or null when it worked. */
  async function renameSelected(newName: string): Promise<string | null> {
    try {
      const res = await renameDiagram(selected, newName)
      const g = useGraphStore.getState()
      if (g.openDiagram?.name === selected) g.setOpenDiagram({ ...g.openDiagram, name: res.renamed, revision: res.revision })
      g.setStatus(`renamed ${selected} to ${res.renamed}`)
      void qc.invalidateQueries({ queryKey: ['diagrams'] })
      setSelected(res.renamed)
      setRenaming(false)
      return null
    } catch (e) {
      return messageOf(e)
    }
  }

  async function deleteSelected() {
    setDeleting(false)
    const { setStatus } = useGraphStore.getState()
    try {
      const res = await deleteDiagram(selected)
      const g = useGraphStore.getState()
      if (g.openDiagram?.name === selected) g.setOpenDiagram(null)
      setStatus(`deleted ${res.deleted} (a copy is in the diagrams/.trash folder of the data folder)`)
      void qc.invalidateQueries({ queryKey: ['diagrams'] })
      setSelected('')
    } catch (e) {
      setStatus(messageOf(e), true)
    }
  }

  /** The banner's Reload (drops the page's unsaved changes) and Keep mine (the next save then replaces the newer one, knowingly). */
  async function reloadChanged() {
    if (!changed) return
    try {
      await reloadOpenDiagram(changed, true)
    } catch (e) {
      useGraphStore.getState().setStatus(messageOf(e), true)
    }
  }

  function keepMine() {
    const g = useGraphStore.getState()
    if (g.openDiagram && changed) g.setOpenDiagram({ ...g.openDiagram, revision: changed.revision })
  }

  /** Show columns and Concepts. They sit in the second row, and move into Tools when the toolbar would wrap. */
  const viewControls = (
    <div className="tb-group">
      <button
        style={NOWRAP}
        onClick={() => void actions.setAllColumns(!allColumns)}
        disabled={!hasNodes}
        title={hasNodes ? 'Show or hide the columns of every table on the graph' : 'Add a table to the graph first'}
      >
        {allColumns ? 'Hide columns' : 'Show columns'}
      </button>
      <button
        style={NOWRAP}
        onClick={() => useGraphStore.getState().setShowConcepts(!showConcepts)}
        aria-pressed={showConcepts}
        disabled={!connected}
        title={connected ? 'Draw the glossary concepts linked to the tables on the graph' : 'Connect to a workspace first'}
      >
        Concepts
      </button>
    </div>
  )

  return (
    <div ref={barRef} className={`graph-toolbar${showPickerToggle ? ' with-picker-toggle' : ''}`}>
      <div className="tb-row">
        <div className="tb-group">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            aria-label="Saved diagrams"
            title="Pick a saved diagram to load, rename or delete"
            disabled={!diagrams.data}
          >
            <option value="">— pick a saved diagram —</option>
            {diagrams.data?.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {/* These act on the picked diagram, so they appear with one. The select's title says what picking does. */}
          {selected && (
            <span className="selection-ui" data-selection-ui>
              <button onClick={load} style={NOWRAP}>
                Load
              </button>
              <button onClick={() => setRenaming(true)} style={NOWRAP}>
                Rename
              </button>
              <button className="danger" onClick={() => setDeleting(true)} style={NOWRAP}>
                Delete
              </button>
            </span>
          )}
        </div>
        <button className="primary" onClick={() => setNaming(true)} disabled={saving} style={NOWRAP}>
          Save diagram
        </button>
        {changed && (
          <span role="alert" className="graph-status error" style={NOWRAP}>
            {openDiagram?.name} was changed{changed.by ? ` by ${changed.by}` : ''}.{' '}
            <button onClick={() => void reloadChanged()}>Reload</button> <button onClick={keepMine}>Keep mine</button>
          </span>
        )}
        {diagrams.isError && <span className="error">{diagrams.error.message}</span>}
        <span className="toolbar-sep" />
        <LensSwitch />
        <span className="spacer" />
        <span
          style={{ flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          className={`graph-status${status.error ? ' error' : ''}`}
          title={status.text}
          role="status"
        >
          {status.text || (connected ? '' : 'not connected')}
        </span>
      </div>
      <div className="tb-row">
        {overflow < 1 && viewControls}
        {overflow < 1 && <span className="toolbar-sep" />}
        {overflow < 2 && (
          <>
            <ColorByControl />
            <span className="toolbar-sep" />
            <GroupControl />
          </>
        )}
        <span className="spacer" />
        <button
          style={NOWRAP}
          onClick={() => setToolsOpen((o) => !o)}
          aria-expanded={toolsOpen}
          title="Mine joins, suggestions, usage, table size and history, relationship profiles, certification and export"
        >
          Tools{proposed ? ` (${proposed})` : ''} {overflow < 2 && <span className="menu-hint" aria-hidden="true"> joins, size, export</span>} &#9662;
        </button>
      </div>
      {/* Opens inside the toolbar, like the Canvas More panel, so the graph below gives way and nothing is covered. */}
      {toolsOpen && (
        <div className="tb-row tb-tools" role="group" aria-label="Graph tools">
          {overflow >= 1 && viewControls}
          {overflow >= 2 && (
            <>
              <span className="toolbar-sep" />
              <ColorByControl />
              <span className="toolbar-sep" />
              <GroupControl />
              <span className="toolbar-sep" />
            </>
          )}
          <div className="tb-group">
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
          </div>
          <span className="toolbar-sep" />
          <div className="tb-group">
            <TableStatsButton />
            <ProfileButton />
            <CertificationControl />
          </div>
          <span className="toolbar-sep" />
          <GraphExportButton />
        </div>
      )}
      {naming && (
        <NameDialog
          title="Save diagram"
          label="Diagram name"
          initial={openDiagram?.name ?? ''}
          onSubmit={(name) => saveAs(name)}
          onCancel={() => setNaming(false)}
        />
      )}
      {renaming && (
        <NameDialog
          title="Rename diagram"
          label="New name"
          initial={selected}
          confirmLabel="Rename"
          onSubmit={renameSelected}
          onCancel={() => setRenaming(false)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete diagram"
          message={`Delete "${selected}"? A copy is kept in the diagrams/.trash folder of the data folder.`}
          confirmLabel="Delete"
          destructive
          onConfirm={() => void deleteSelected()}
          onCancel={() => setDeleting(false)}
        />
      )}
      {overwrite && (
        <ConfirmDialog
          title="Overwrite newer save?"
          message={`"${overwrite.remote.name}" was saved${overwrite.remote.by ? ` by ${overwrite.remote.by}` : ''} since you loaded it (revision ${overwrite.remote.revision}). Saving now replaces that version.`}
          confirmLabel="Overwrite"
          destructive
          onConfirm={() => void saveAs(overwrite.name, overwrite.remote.revision)}
          onCancel={() => setOverwrite(null)}
        />
      )}
    </div>
  )
}
