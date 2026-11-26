import { useState } from 'react'
import { useRunTagSuggestions, useTagPlan, type TagRunEntry, type TagRunResult } from '../api/concepts'
import { useModalBehavior } from '../shared/Dialog'
import { useUiStore } from '../store/uiStore'
import { useConceptsStore } from './conceptsStore'

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function Entries({ title, items }: { title: string; items: TagRunEntry[] }) {
  if (items.length === 0) return null
  return (
    <div>
      <strong>{title}</strong>
      <ul>
        {items.map((e) => (
          <li key={e.id}>
            {e.name}: {e.links} link{e.links === 1 ? '' : 's'}
            {e.links_added || e.links_removed ? ` (${e.links_added} added, ${e.links_removed} removed)` : ''}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Confirm dialog for "Suggest from tags": the exact read-only SQL first, then a run on the selected warehouse, then what was
 * created or updated. Nothing runs until the button is pressed.
 */
export function SuggestDialog() {
  const warehouseId = useUiStore((s) => s.warehouseId)
  const plan = useTagPlan(true)
  const run = useRunTagSuggestions()
  const [result, setResult] = useState<TagRunResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const close = () => useConceptsStore.getState().setSuggestOpen(false)
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
      <div className="modal suggest-dialog" role="dialog" aria-modal="true" aria-label="Suggest concepts from tags" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Suggest concepts from Unity Catalog tags</h3>
        <p className="hint">
          Reads the tags on catalogs, schemas, tables and columns through the selected SQL warehouse{p?.warehouse_id ? ` (${p.warehouse_id})` : ''},
          at most {p?.row_cap ?? 20000} rows. Each tag key and value becomes a draft concept, linked with “describes” to the tables
          and columns that carry it. Running it again updates those concepts and keeps your edits.
        </p>
        {plan.isError && <p className="error">{plan.error.message}</p>}
        {p?.queries.map((q) => (
          <details key={q.name} open={!result}>
            <summary>system.information_schema tag tables (read-only)</summary>
            <pre className="mine-sql" data-testid="tag-sql">{q.sql}</pre>
          </details>
        ))}
        {!warehouseId && !result && <p className="error">Pick a SQL warehouse in the picker first.</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {result && (
          <div className="suggest-result" data-testid="tag-result" role="status">
            <p>
              Read {result.rows} tag row{result.rows === 1 ? '' : 's'}: {result.created.length} concept
              {result.created.length === 1 ? '' : 's'} created, {result.updated.length} updated
              {result.skipped.length ? `, ${result.skipped.length} skipped` : ''}.
              {result.truncated && ' The row cap was reached, so some tags are missing.'}
            </p>
            <Entries title="Created" items={result.created} />
            <Entries title="Updated" items={result.updated} />
            {result.skipped.length > 0 && (
              <ul>
                {result.skipped.map((s) => (
                  <li key={s.name}>
                    {s.name}: {s.reason}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <div className="btns">
          <button onClick={() => void go()} disabled={!p || !warehouseId || run.isPending}>
            {run.isPending ? 'Running…' : result ? 'Run again' : 'Run this query'}
          </button>
          <button onClick={close}>{result ? 'Close' : 'Cancel'}</button>
        </div>
      </div>
    </div>
  )
}
