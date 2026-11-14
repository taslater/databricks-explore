import { useState } from 'react'
import { useAddLink, useCandidates, type Candidate, type ConceptDetail } from '../api/concepts'
import { defaultRelation, relationsFor } from './model'

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Find candidates: tables and columns whose name or comment mentions the concept's name or a synonym. It searches the
 * local cache only, never the warehouse, so it only knows what has been browsed. Each hit links in one click.
 */
export function Candidates({ concept }: { concept: ConceptDetail }) {
  const [asked, setAsked] = useState(false)
  const [relation, setRelation] = useState(defaultRelation('table'))
  const [error, setError] = useState<string | null>(null)
  const q = useCandidates(concept.id, asked)
  const add = useAddLink()

  async function link(h: Candidate) {
    setError(null)
    try {
      await add.mutateAsync({ id: concept.id, body: { target: { table: h.table, column: h.column }, relation } })
    } catch (e) {
      setError(messageOf(e))
    }
  }

  async function search() {
    if (asked) await q.refetch()
    else setAsked(true)
  }

  const data = q.data
  return (
    <section className="concept-candidates" aria-label="Candidates">
      <h4>Candidates</h4>
      <div className="candidates-bar">
        <button onClick={() => void search()} disabled={q.isFetching} title="Search the cached table and column names and comments. No warehouse.">
          {q.isFetching ? 'Searching…' : 'Find candidates'}
        </button>
        <label>
          Link as{' '}
          <select value={relation} onChange={(e) => setRelation(e.target.value)} aria-label="Relation for linked candidates">
            {relationsFor('table').map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </div>
      {q.isError && <p className="error">{q.error.message}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {data && (
        <>
          <p className="hint" data-testid="candidates-summary">
            {data.hits.length} hit{data.hits.length === 1 ? '' : 's'} for {data.terms.map((t) => `"${t}"`).join(', ')} in{' '}
            {data.searched.tables} cached table{data.searched.tables === 1 ? '' : 's'} ({data.searched.columns} columns from{' '}
            {data.searched.tables_with_columns} table{data.searched.tables_with_columns === 1 ? '' : 's'} you opened).
            {data.truncated && ' Showing the best 200.'}
            {data.searched.tables === 0 && ' Browse some schemas first: only cached metadata is searched.'}
          </p>
          <ul className="candidate-rows">
            {data.hits.map((h) => (
              <li key={`${h.table}#${h.column ?? ''}`} className="candidate-row">
                <span className="candidate-target">
                  {h.table}
                  {h.column ? `.${h.column}` : ''}
                </span>
                <span className="candidate-why" title={h.text}>
                  {h.field} matches “{h.matched}”{h.field === 'comment' ? `: ${h.text}` : ''}
                </span>
                <button onClick={() => void link(h)} disabled={h.linked || add.isPending}>
                  {h.linked ? 'linked' : 'Link'}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
