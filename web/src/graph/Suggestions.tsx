import { useMemo, useState } from 'react'
import { useBulkReview, useSuggestions } from '../api/hooks'
import type { StoredStatus } from '../api/types'
import { messageOf, useGraphActions } from './actions'
import { dayOf, pairLabel } from './mining'
import { shortestNames } from './names'
import { groupSuggestions, type SuggestionRow } from './suggestionGroups'

const STATUSES: StoredStatus[] = ['proposed', 'accepted', 'rejected']

/** Proposed `join_mined` edges, most evidence first, with per-row and bulk Accept and Reject. */
export function Suggestions() {
  const [status, setStatus] = useState<StoredStatus>('proposed')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const list = useSuggestions(status)
  const bulk = useBulkReview()
  const actions = useGraphActions()
  const edges = useMemo(() => list.data?.edges ?? [], [list.data])
  const rows = useMemo(() => groupSuggestions(edges), [edges])
  const name = useMemo(() => shortestNames(edges.flatMap((e) => [e.source.table, e.target.table])), [edges])
  const counts = list.data?.counts

  async function review(ids: string[], to: StoredStatus) {
    if (ids.length === 0) return
    setError(null)
    try {
      await bulk.mutateAsync({ ids, status: to })
      setPicked(new Set())
      await actions.refreshGraph()
    } catch (e) {
      setError(messageOf(e))
    }
  }

  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const allPicked = rows.length > 0 && rows.every((r) => picked.has(r.key))
  const chosen = [...new Set(rows.filter((r) => picked.has(r.key)).flatMap((r) => r.ids))]

  return (
    <div className="suggestions" data-testid="suggestions">
      <div className="sg-bar">
        {STATUSES.map((s) => (
          <button
            key={s}
            className={s === status ? 'active' : undefined}
            aria-pressed={s === status}
            onClick={() => {
              setStatus(s)
              setPicked(new Set())
            }}
          >
            {s} {counts ? `(${counts[s]})` : ''}
          </button>
        ))}
        <span className="spacer" />
        <span className="hint">{chosen.length} selected</span>
        {status !== 'accepted' && (
          <button disabled={chosen.length === 0 || bulk.isPending} onClick={() => void review(chosen, 'accepted')}>
            Accept selected
          </button>
        )}
        {status !== 'rejected' && (
          <button disabled={chosen.length === 0 || bulk.isPending} onClick={() => void review(chosen, 'rejected')}>
            Reject selected
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {list.isError && <p className="error">{list.error.message}</p>}
      {list.isSuccess && rows.length === 0 && (
        <p className="hint">
          {status === 'proposed'
            ? 'No suggestions. Use Mine joins to read query history for joins between tables.'
            : `Nothing ${status}.`}
        </p>
      )}
      {rows.length > 0 && (
        <table className="sg-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allPicked}
                  onChange={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.key)))}
                />
              </th>
              <th>Join</th>
              <th>Runs</th>
              <th>Users</th>
              <th>Last seen</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Row
                key={r.key}
                row={r}
                name={name}
                status={status}
                picked={picked.has(r.key)}
                onToggle={() => toggle(r.key)}
                onReview={review}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function Row({
  row,
  name,
  status,
  picked,
  onToggle,
  onReview,
}: {
  row: SuggestionRow
  name: (table: string) => string
  status: StoredStatus
  picked: boolean
  onToggle: () => void
  onReview: (ids: string[], to: StoredStatus) => Promise<void>
}) {
  const actions = useGraphActions()
  const labels = row.columns.map(([s, t]) =>
    pairLabel({ source: { table: row.source, column: s }, target: { table: row.target, column: t } }, name),
  )
  const refs = [...new Set(row.edges.flatMap((e) => e.evidence?.sample_refs ?? []))]
  const title = `${row.columns.map(([s, t]) => `${row.source}.${s} = ${row.target}.${t}`).join('\n')}${
    refs.length ? `\nstatements: ${refs.join(', ')}` : ''
  }`
  const subject = row.composite ? `${labels[0]} and ${labels.length - 1} more` : labels[0]
  return (
    <tr className={picked ? 'picked' : undefined}>
      <td>
        <input type="checkbox" aria-label={`Select ${subject}`} checked={picked} onChange={onToggle} />
      </td>
      <td title={title}>
        {row.composite && <span className="hint">composite key, {labels.length} columns</span>}
        {labels.map((l) => (
          <div key={l}>{l}</div>
        ))}
      </td>
      <td>{row.runs}</td>
      <td>{row.users || ''}</td>
      <td>{dayOf(row.lastSeen)}</td>
      <td className="sg-actions">
        <button
          onClick={() => void actions.showColumnEdge(row.source, row.target, row.ids[0])}
          title="Show both tables and their columns in the graph"
        >
          Show
        </button>
        {status !== 'accepted' && <button onClick={() => void onReview(row.ids, 'accepted')}>Accept</button>}
        {status !== 'rejected' && <button onClick={() => void onReview(row.ids, 'rejected')}>Reject</button>}
      </td>
    </tr>
  )
}
