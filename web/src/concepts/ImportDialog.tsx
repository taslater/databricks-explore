import { useState } from 'react'
import { useImportPlan, useRunImport, type ImportEntry, type ImportReport, type ImportSource } from '../api/concepts'
import { useModalBehavior } from '../shared/Dialog'
import { useConceptsStore } from './conceptsStore'

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const SOURCE_LABEL: Record<string, string> = {
  domains: 'Domains',
  pages: 'Pages',
  metric_views: 'Metric views',
  certification: 'Certification tags',
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function sourceLine(id: string, s: ImportSource): string {
  const label = SOURCE_LABEL[id] ?? id
  if (s.status === 'ok') {
    const bad = s.unreadable ? `, ${s.unreadable} could not be read` : ''
    return `${label}: read ${s.count ?? 0}${bad}`
  }
  return `${label}: ${s.status === 'unavailable' ? (s.message ?? 'not available on this workspace') : `failed (${s.message ?? 'unknown error'})`}`
}

function Entries({ title, items }: { title: string; items: ImportEntry[] }) {
  if (items.length === 0) return null
  return (
    <div>
      <strong>{title}</strong>
      <ul>
        {items.map((e) => (
          <li key={e.id}>
            {e.name} <span className="hint">({e.kind})</span>
            {e.fields && e.fields.length > 0 ? `: changed ${e.fields.join(', ')}` : ''}
            {e.kept && e.kept.length > 0 ? `; kept your edit to ${e.kept.join(', ')}` : ''}
            {e.links_added || e.links_removed ? ` (links: ${e.links_added} added, ${e.links_removed} removed)` : ''}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Report({ r }: { r: ImportReport }) {
  return (
    <div className="suggest-result import-result" data-testid="import-result" role="status">
      <ul>
        {Object.entries(r.sources).map(([id, s]) => (
          <li key={id} className={s.status === 'ok' ? '' : 'error'}>
            {sourceLine(id, s)}
          </li>
        ))}
      </ul>
      <p>
        {plural(r.created.length, 'concept')} created, {r.updated.length} updated, {r.unchanged} unchanged
        {r.skipped.length ? `, ${r.skipped.length} skipped` : ''}
        {r.stale.length ? `, ${r.stale.length} no longer in the source (their imported links were removed)` : ''}.
      </p>
      <Entries title="Created" items={r.created} />
      <Entries title="Updated" items={r.updated} />
      {r.skipped.length > 0 && (
        <div>
          <strong>Skipped</strong>
          <ul>
            {r.skipped.map((s, i) => (
              <li key={`${s.name}-${i}`}>
                {s.name}: {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.unreadable.length > 0 && (
        <div>
          <strong>Metric views skipped</strong>
          <ul>
            {r.unreadable.map((u) => (
              <li key={u.view}>
                {u.view}: {u.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {r.stale.length > 0 && (
        <div>
          <strong>No longer in the source</strong>
          <ul>
            {r.stale.map((s) => (
              <li key={s.id}>
                {s.name}: {plural(s.links_removed, 'link')} removed, concept kept
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * Confirm dialog for "Import from Databricks": every REST call and SQL statement first, then a run, then what was created,
 * updated and skipped. Read-only toward Databricks. Nothing runs until the button is pressed.
 */
export function ImportDialog() {
  const plan = useImportPlan(true)
  const run = useRunImport()
  const [result, setResult] = useState<ImportReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const close = () => useConceptsStore.getState().setImportOpen(false)
  useModalBehavior(close)

  async function go() {
    setError(null)
    try {
      setResult(await run.mutateAsync())
    } catch (e) {
      setError(messageOf(e))
    }
  }

  const p = plan.data
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={close}>
      <div
        data-surface="overlay" className="modal suggest-dialog import-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Import concepts from Databricks"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3>Import from Databricks</h3>
        <p className="hint">
          Reads Genie Ontology domains and pages, the measures and dimensions of metric views, and the certification tags (which also
          refreshes the local certification cache), and nothing else. Every call is read-only.
          Domains and pages are Beta endpoints; one that is not available on this workspace is reported and the rest still run. Imported
          concepts have origin “ontology”. Running it again updates them by their source, keeps your edits to what the source did not
          change, and removes only the links it made itself.
        </p>
        {plan.isError && <p className="error">{plan.error.message}</p>}
        {p && (
          <ol className="import-steps" data-testid="import-plan">
            {p.steps.map((s) => (
              <li key={s.id}>
                {s.label}
                {s.kind === 'rest' ? (
                  <div>
                    <code>
                      {s.method} {s.path}
                    </code>
                    {s.paginated ? ' (all pages)' : ''}
                  </div>
                ) : (
                  <pre className="mine-sql">{s.sql}</pre>
                )}
              </li>
            ))}
          </ol>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {result && <Report r={result} />}
        <div className="btns">
          <button onClick={() => void go()} disabled={!p || run.isPending}>
            {run.isPending ? 'Importing…' : result ? 'Run again' : 'Run import'}
          </button>
          <button onClick={close}>{result ? 'Close' : 'Cancel'}</button>
        </div>
      </div>
    </div>
  )
}
