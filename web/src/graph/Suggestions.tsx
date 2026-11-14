import { useState } from 'react'
import { useBulkReview, useSuggestions } from '../api/hooks'
import type { Relationship, StoredStatus } from '../api/types'
import { messageOf, useGraphActions } from './actions'
import { dayOf, pairLabel } from './mining'

const STATUSES: StoredStatus[] = ['proposed', 'accepted', 'rejected']

/** Proposed `join_mined` edges, most evidence first, with per-row and bulk Accept and Reject. */
export function Suggestions() {
  const [status, setStatus] = useState<StoredStatus>('proposed')
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const list = useSuggestions(status)
  const bulk = useBulkReview()
  const actions = useGraphActions()
  const edges = list.data?.edges ?? []
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
  const allPicked = edges.length > 0 && edges.every((e) => picked.has(e.id))
  const chosen = edges.filter((e) => picked.has(e.id)).map((e) => e.id)

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
      {list.isSuccess && edges.length === 0 && (
        <p className="hint">
          {status === 'proposed'
            ? 'No suggestions. Use Mine joins to read query history for joins between tables.'
            : `Nothing ${status}.`}
        </p>
      )}
      {edges.length > 0 && (
        <table className="sg-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={allPicked}
                  onChange={() => setPicked(allPicked ? new Set() : new Set(edges.map((e) => e.id)))}
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
            {edges.map((e) => (
              <Row key={e.id} edge={e} picked={picked.has(e.id)} onToggle={() => toggle(e.id)} onReview={review} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function Row({
  edge,
  picked,
  onToggle,
  onReview,
}: {
  edge: Relationship
  picked: boolean
  onToggle: () => void
  onReview: (ids: string[], to: StoredStatus) => Promise<void>
}) {
  const actions = useGraphActions()
  const ev = edge.evidence
  const title = `${edge.source.table}.${edge.source.column} = ${edge.target.table}.${edge.target.column}${
    ev?.sample_refs.length ? `\nstatements: ${ev.sample_refs.join(', ')}` : ''
  }`
  return (
    <tr className={picked ? 'picked' : undefined}>
      <td>
        <input type="checkbox" aria-label={`Select ${pairLabel(edge)}`} checked={picked} onChange={onToggle} />
      </td>
      <td title={title}>{pairLabel(edge)}</td>
      <td>{ev?.runs ?? ''}</td>
      <td>{ev?.users ?? ''}</td>
      <td>{dayOf(ev?.last_seen)}</td>
      <td className="sg-actions">
        <button
          onClick={() => void actions.showColumnEdge(edge.source.table, edge.target.table, edge.id)}
          title="Show both tables and their columns in the graph"
        >
          Show
        </button>
        {edge.status !== 'accepted' && <button onClick={() => void onReview([edge.id], 'accepted')}>Accept</button>}
        {edge.status !== 'rejected' && <button onClick={() => void onReview([edge.id], 'rejected')}>Reject</button>}
      </td>
    </tr>
  )
}
