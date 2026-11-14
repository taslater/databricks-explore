import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useMiningStatus, useSuggestions } from '../api/hooks'
import type { MiningStatus } from '../api/types'
import { useGraphActions } from './actions'
import { useGraphStore, type Drawer } from './graphStore'
import { progressFraction, progressText, resultLines } from './mining'
import { Suggestions } from './Suggestions'
import { UsagePanel } from './UsagePanel'

const TABS: { id: Exclude<Drawer, null>; label: string }[] = [
  { id: 'suggestions', label: 'Suggested relationships' },
  { id: 'mining', label: 'Mining' },
  { id: 'usage', label: 'Usage' },
]

/**
 * Keeps the data fresh when a run ends: suggestions and usage are re-read, and so is everything on the graph.
 * Mounted with the toolbar so it works while the panel is closed.
 */
export function useMiningWatcher() {
  const qc = useQueryClient()
  const actions = useGraphActions()
  const status = useMiningStatus().data?.state
  const previous = useRef<MiningStatus['state'] | undefined>(undefined)
  useEffect(() => {
    if (previous.current === 'running' && status && status !== 'running') {
      void qc.invalidateQueries({ queryKey: ['suggestions'] })
      void qc.invalidateQueries({ queryKey: ['usage'] })
      if (status === 'succeeded') void actions.refreshGraph()
    }
    previous.current = status
  }, [status, qc, actions])
}

/** Bottom panel of the graph: suggested relationships, the mining run's progress and result, and usage. */
export function MiningPanel({ drawer }: { drawer: Exclude<Drawer, null> }) {
  const setDrawer = useGraphStore((s) => s.setDrawer)
  return (
    <section className="graph-drawer" aria-label="Mining">
      <div className="drawer-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={drawer === t.id}
            className={drawer === t.id ? 'active' : undefined}
            onClick={() => setDrawer(t.id)}
          >
            {t.label}
          </button>
        ))}
        <span className="spacer" />
        <button onClick={() => useGraphStore.getState().setMineDialog(true)}>Mine joins…</button>
        <button aria-label="Close panel" onClick={() => setDrawer(null)}>
          ✕
        </button>
      </div>
      <div className="drawer-body">
        {drawer === 'suggestions' && <Suggestions />}
        {drawer === 'mining' && <MiningStatusView />}
        {drawer === 'usage' && <UsagePanel />}
      </div>
    </section>
  )
}

/** Progress while a run is going, and its outcome after: a summary, the redacted-text message, or the error. */
function MiningStatusView() {
  const q = useMiningStatus()
  const s = q.data
  if (q.isError) return <p className="error">{q.error.message}</p>
  if (!s) return <p className="hint">loading…</p>
  const fraction = progressFraction(s)
  return (
    <div className="mining-status" data-testid="mining-status">
      {s.state === 'idle' && !s.last_run && (
        <p className="hint">No run yet. Mine joins reads query history through the selected warehouse. It shows the SQL first.</p>
      )}
      {s.state === 'running' && (
        <>
          <div role="status">{progressText(s)}</div>
          <progress className="mine-progress" max={1} value={fraction ?? undefined} aria-label="Mining progress" />
          {s.plan && (
            <div className="hint">
              {s.plan.since} to {s.plan.until}
            </div>
          )}
        </>
      )}
      {s.state === 'blocked' && (
        <div className="mine-blocked" role="alert">
          <strong>Query text is redacted</strong>
          <p>{s.error}</p>
        </div>
      )}
      {s.state === 'failed' && (
        <p className="error" role="alert">
          Mining failed: {s.error}
        </p>
      )}
      {s.state === 'succeeded' && s.result && <ResultSummary title="Finished" result={s.result} />}
      {s.state !== 'succeeded' && s.last_run && <ResultSummary title="Last stored run" result={s.last_run} />}
    </div>
  )
}

function ResultSummary({ title, result }: { title: string; result: NonNullable<MiningStatus['result']> }) {
  const proposed = useSuggestions('proposed').data?.counts.proposed
  return (
    <div className="mine-result">
      <h4>
        {title} <small>{result.since.slice(0, 10)} to {result.until.slice(0, 10)}</small>
      </h4>
      <ul>
        {resultLines(result).map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      {proposed !== undefined && (
        <button onClick={() => useGraphStore.getState().setDrawer('suggestions')}>
          Review {proposed} suggestions
        </button>
      )}
    </div>
  )
}
