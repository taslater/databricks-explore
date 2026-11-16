import { useMemo } from 'react'
import { useUsage } from '../api/hooks'
import { useGraphActions } from './actions'
import { dayOf } from './mining'
import { shortestNames } from './names'

/** Top tables by runs and distinct users, and top table pairs read together, for the mined window. */
export function UsagePanel() {
  const usage = useUsage()
  const actions = useGraphActions()
  const u = usage.data
  const name = useMemo(
    () => shortestNames([...(u?.tables.map((t) => t.table) ?? []), ...(u?.pairs.flatMap((p) => p.tables) ?? [])]),
    [u],
  )

  const show = (table: string) => void actions.addObject(table)

  if (usage.isError) return <p className="error">{usage.error.message}</p>
  if (!u) return <p className="hint">loading…</p>
  if (!u.window) return <p className="hint">No usage yet. Mine joins to read query history; the summary comes from the same run.</p>
  const maxRuns = Math.max(1, ...u.tables.map((t) => t.runs))
  return (
    <div className="usage" data-testid="usage">
      <p className="hint">
        {u.statements} statements, {dayOf(u.window.since)} to {dayOf(u.window.until)}. Users are counted, not named.
      </p>
      <div className="usage-cols">
        <div>
          <h4>Busiest tables</h4>
          <table className="sg-table">
            <thead>
              <tr>
                <th>Table</th>
                <th>Runs</th>
                <th>Users</th>
              </tr>
            </thead>
            <tbody>
              {u.tables.map((t) => (
                <tr key={t.table}>
                  <td title={t.table}>
                    <button className="link" onClick={() => show(t.table)}>
                      {name(t.table)}
                    </button>
                    <div className="usage-bar" style={{ width: `${(100 * t.runs) / maxRuns}%` }} />
                  </td>
                  <td>{t.runs}</td>
                  <td>{t.users}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h4>Read together</h4>
          <table className="sg-table">
            <thead>
              <tr>
                <th>Tables</th>
                <th>Runs</th>
                <th>Users</th>
              </tr>
            </thead>
            <tbody>
              {u.pairs.map((p) => (
                <tr key={p.tables.join('|')}>
                  <td title={p.tables.join(' + ')}>{p.tables.map(name).join(' + ')}</td>
                  <td>{p.runs}</td>
                  <td>{p.users}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
