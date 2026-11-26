import { useState } from 'react'
import { useMiningPlan, useStartMining } from '../api/hooks'
import { useModalBehavior } from '../shared/Dialog'
import { useUiStore } from '../store/uiStore'
import { messageOf } from './actions'
import { useGraphStore } from './graphStore'

const WINDOWS = [7, 30, 90, 365]

/**
 * Confirm dialog for a mining run: the window, and the exact SQL that will run, before anything does.
 * Mining is never automatic. Running closes the dialog and opens the Mining tab for progress.
 */
export function MineDialog() {
  const warehouseId = useUiStore((s) => s.warehouseId)
  const [days, setDays] = useState('30')
  const [full, setFull] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const n = Number(days)
  const plan = useMiningPlan(n, full, true)
  const start = useStartMining()

  const close = () => useGraphStore.getState().setMineDialog(false)
  useModalBehavior(close)

  async function run() {
    setError(null)
    try {
      await start.mutateAsync({ windowDays: n, full })
      const g = useGraphStore.getState()
      g.setMineDialog(false)
      g.setDrawer('mining')
    } catch (e) {
      setError(messageOf(e))
    }
  }

  const p = plan.data
  const valid = Number.isInteger(n) && n >= 1 && n <= 365
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={close}>
      <div
        className="modal mine-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Mine joins from query history"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3>Mine joins from query history</h3>
        <p className="hint">
          Reads finished statements and the tables they read from the system tables, through the selected SQL
          warehouse{p?.warehouse_id ? ` (${p.warehouse_id})` : ''}. Statement text is read in memory to find the join
          columns and is never stored; neither are user names.
        </p>
        <div className="mine-window">
          <label>
            Window, days{' '}
            <input
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              aria-label="Window in days"
              disabled={!!p?.incremental && !full}
            />
          </label>
          {WINDOWS.map((w) => (
            <button key={w} type="button" onClick={() => setDays(String(w))} disabled={!!p?.incremental && !full}>
              {w}d
            </button>
          ))}
          {p?.cursor && (
            <label className="check">
              <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} />
              Re-mine the whole window (replaces counts)
            </label>
          )}
        </div>
        {!valid && <p className="error">Window must be a whole number of days from 1 to 365.</p>}
        {plan.isError && <p className="error">{plan.error.message}</p>}
        {p && (
          <>
            <p className="mine-window-text" data-testid="mine-window">
              {p.incremental ? 'Incremental: ' : 'Window: '}
              <strong>{p.since}</strong> to <strong>{p.until}</strong> (UTC), at most {p.row_cap} statements.
              {p.incremental && ' It continues from the last run, so the window above does not apply.'}
            </p>
            {p.remine_reason && (
              <p className="hint" data-testid="mine-remine-reason">
                {p.remine_reason}
              </p>
            )}
            {p.queries.map((q) => (
              <details key={q.name} open>
                <summary>{q.name === 'query_history' ? 'system.query.history' : 'system.access.table_lineage'}</summary>
                <pre className="mine-sql">{q.sql}</pre>
                <div className="hint">
                  {Object.entries(q.params)
                    .map(([k, v]) => `:${k} = ${v}`)
                    .join(', ')}
                </div>
              </details>
            ))}
          </>
        )}
        {!warehouseId && <p className="error">Pick a SQL warehouse in the picker first.</p>}
        {error && <p className="error">{error}</p>}
        <div className="btns">
          <button onClick={() => void run()} disabled={!valid || !p || !warehouseId || start.isPending}>
            Run these queries
          </button>
          <button onClick={close}>Cancel</button>
        </div>
      </div>
    </div>
  )
}
