import { useRef } from 'react'
import { exportConcepts, useConcepts, useImportConcepts } from '../api/concepts'
import { useUiStore } from '../store/uiStore'
import { ConceptEditor } from './ConceptEditor'
import { ConceptList } from './ConceptList'
import { ImportDialog } from './ImportDialog'
import { useConceptsStore } from './conceptsStore'
import { downloadJson, exportName } from './model'
import { SuggestDialog } from './SuggestDialog'

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The Concepts tab: a glossary list on the left, the open concept on the right. */
export function ConceptsView() {
  const profile = useUiStore((s) => s.connectedProfile)
  const pickerCollapsed = useUiStore((s) => s.pickerCollapsed)
  const selected = useConceptsStore((s) => s.selected)
  const filters = useConceptsStore((s) => s.filters)
  const suggestOpen = useConceptsStore((s) => s.suggestOpen)
  const importOpen = useConceptsStore((s) => s.importOpen)
  const notice = useConceptsStore((s) => s.notice)
  const list = useConcepts(filters)
  const importer = useImportConcepts()
  const fileInput = useRef<HTMLInputElement>(null)
  const { select, setSuggestOpen, setImportOpen, setNotice } = useConceptsStore.getState()

  async function doExport() {
    try {
      downloadJson(exportName(profile), await exportConcepts())
      setNotice('Exported the concepts and their links.')
    } catch (e) {
      setNotice(messageOf(e), true)
    }
  }

  async function doImport(file: File) {
    try {
      const json: unknown = JSON.parse(await file.text())
      const r = await importer.mutateAsync(json)
      setNotice(
        `Imported ${r.concepts ?? 0} concept${r.concepts === 1 ? '' : 's'} (${r.concepts_created ?? 0} new) and ${r.imported} edge${r.imported === 1 ? '' : 's'}.`,
      )
    } catch (e) {
      setNotice(`Import failed, nothing changed: ${messageOf(e)}`, true)
    }
  }

  if (!profile) {
    return (
      <div className="concepts-view" data-surface="raised">
        <p className="hint concepts-empty">Connect to a profile to use concepts. Demo mode works too.</p>
      </div>
    )
  }

  const noConcepts = !!list.data && list.data.concepts.length === 0 && !filters.q && !filters.domain && !filters.status && !selected

  return (
    <div className="concepts-view" data-surface="raised">
      <div className={`concepts-toolbar${pickerCollapsed ? ' with-picker-toggle' : ''}`}>
        <strong>Concepts</strong>
        <button className="primary" onClick={() => select('new')}>
          + New concept
        </button>
        <button
          onClick={() => setSuggestOpen(true)}
          title="Draft concepts from Unity Catalog tags. Shows the SQL first."
        >
          Suggest from tags…
        </button>
        <button
          onClick={() => setImportOpen(true)}
          title="Read Genie Ontology pages and domains, metric views and certification. Read-only; shows every call first."
        >
          Import from Databricks…
        </button>
        <span className="toolbar-sep" />
        <button onClick={() => void doExport()} title="Save the concepts and their links as a JSON file">
          Export
        </button>
        <button onClick={() => fileInput.current?.click()} disabled={importer.isPending} title="Load an export file. All or nothing.">
          Import
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label="Import file"
          onChange={(e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (f) void doImport(f)
          }}
        />
        <span className="spacer" />
        {notice && (
          <span className={`concepts-notice${notice.error ? ' error' : ''}`} role="status" title={notice.text}>
            {notice.text}
          </span>
        )}
      </div>
      {/* no concepts and nothing filtered out: one empty state across the page instead of an empty list beside a placeholder */}
      <div className={`concepts-body${noConcepts ? ' concepts-body-empty' : ''}`}>
        {!noConcepts && <ConceptList list={list.data} loading={list.isLoading} error={list.isError ? list.error.message : null} />}
        {selected ? (
          <ConceptEditor key={selected} id={selected} names={new Map((list.data?.concepts ?? []).map((c) => [c.id, c.name]))} domains={list.data?.domains ?? []} />
        ) : (
          <div className="concept-editor concept-placeholder">
            {noConcepts ? (
              <div className="empty-state">
                <h3>No concepts yet</h3>
                <p>A concept is a business term, such as "active customer", linked to the tables and columns that define it.</p>
                <button onClick={() => select('new')}>Write the first concept</button>
              </div>
            ) : (
              <p className="hint">Pick a concept to edit it, or add a new one.</p>
            )}
          </div>
        )}
      </div>
      {suggestOpen && <SuggestDialog />}
      {importOpen && <ImportDialog />}
    </div>
  )
}
