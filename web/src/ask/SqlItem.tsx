import { useState } from 'react'
import { getAskResult, type AskQueryItem, type AskResult } from '../api/ask'
import { ResultsGrid } from '../canvas/ResultsGrid'
import { openSqlInCanvas } from './canvasAction'

/** One SQL statement Genie ran: the text, Show result (fetched on demand, into the results grid) and Open in Canvas. */
export function SqlItem({ item, conversationId, responseId }: { item: AskQueryItem; conversationId: string; responseId: string }) {
  const [shown, setShown] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<AskResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      setResult(await getAskResult(conversationId, responseId, item.item_id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  async function toggle() {
    const next = !shown
    setShown(next)
    if (next && !result?.ready) await load()
  }

  return (
    <div className="ask-sql">
      <pre className="ask-sql-text">{item.sql}</pre>
      <div className="ask-sql-actions">
        <button onClick={() => void toggle()} aria-expanded={shown} disabled={loading}>
          {loading ? 'Loading…' : shown ? 'Hide result' : 'Show result'}
        </button>
        <button onClick={() => openSqlInCanvas(item.sql)} title="Add a query window with this SQL to the Canvas">
          Open in Canvas
        </button>
      </div>
      {shown && error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {shown && result && !result.ready && !error && (
        <p className="hint" role="status">
          The result is not ready yet ({result.state ?? 'unknown'}).{' '}
          <button className="link" onClick={() => void load()}>
            Check again
          </button>
        </p>
      )}
      {shown && result?.ready && (
        <>
          <div className="ask-grid" data-testid="ask-grid">
            <ResultsGrid result={result} />
          </div>
          {result.truncated && (
            <p className="hint">
              Showing {result.row_count} of {result.total_row_count ?? 'more'} rows. Open it in the Canvas to run the full query.
            </p>
          )}
        </>
      )}
    </div>
  )
}
