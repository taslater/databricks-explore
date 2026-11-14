import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useAddLink, useCertification, useConcepts, useRemoveLink, type ConceptDetail } from '../api/concepts'
import { getObject } from '../api/client'
import { useObject, useSearch } from '../api/hooks'
import type { Relationship } from '../api/types'
import { columnsOf, findColumn } from '../graph/columns'
import { useUiStore } from '../store/uiStore'
import { useGraphStore } from '../graph/graphStore'
import { CertBadge } from './CertBadge'
import { CertificationControl } from './CertificationControl'
import { certificationOf } from './certification'
import { conceptIdOf, defaultRelation, parseTypedName, relationsFor, sourceLabel, targetLabel } from './model'
import { useConceptsStore } from './conceptsStore'

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

type TargetKind = 'table' | 'column' | 'concept'

/** The links of one concept: what it points at, what points at it, and a picker to add one. */
export function LinksSection({ concept, names }: { concept: ConceptDetail; names: ReadonlyMap<string, string> }) {
  const add = useAddLink()
  const remove = useRemoveLink()
  const certification = useCertification()
  const [error, setError] = useState<string | null>(null)

  async function run(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(messageOf(e))
    }
  }

  const changeRelation = (l: Relationship, relation: string) =>
    run(() => add.mutateAsync({ id: concept.id, body: { target: l.target, relation, note: l.note } }))

  return (
    <section className="concept-links" aria-label="Links">
      <h4>Links</h4>
      <CertificationControl />
      {concept.links.length === 0 && concept.incoming.length === 0 && <p className="hint">Not linked to anything yet.</p>}
      <ul className="link-rows">
        {concept.links.map((l) => {
          const toConcept = conceptIdOf(l.target.table) !== null
          const open = toConcept ? conceptIdOf(l.target.table) : null
          return (
            <li key={l.id} className="link-row">
              <select
                value={l.relation ?? ''}
                onChange={(e) => void changeRelation(l, e.target.value)}
                aria-label={`Relation to ${targetLabel(l, names)}`}
              >
                {relationsFor(toConcept ? 'concept' : 'table').map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              {open ? (
                <button className="link-target as-link" onClick={() => useConceptsStore.getState().select(open)} title="Open this concept">
                  {targetLabel(l, names)}
                </button>
              ) : (
                <span className="link-target" title={targetLabel(l, names)}>
                  {targetLabel(l, names)}
                </span>
              )}
              {!toConcept && <CertBadge status={certificationOf(certification.data, l.target.table, l.target.column)} />}
              <button
                className="link-remove"
                aria-label={`Remove link to ${targetLabel(l, names)}`}
                title="Remove this link"
                onClick={() => void run(() => remove.mutateAsync({ id: concept.id, edgeId: l.id }))}
              >
                ✕
              </button>
            </li>
          )
        })}
        {concept.incoming.map((l) => (
          <li key={l.id} className="link-row incoming">
            <span className="link-rel">{sourceLabel(l, names)} {l.relation ?? ''}</span>
            <span className="link-target">this concept</span>
            <button
              className="link-remove"
              aria-label={`Remove link from ${sourceLabel(l, names)}`}
              onClick={() => void run(() => remove.mutateAsync({ id: concept.id, edgeId: l.id }))}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="error" role="alert">{error}</p>}
      <AddLink concept={concept} onError={setError} />
    </section>
  )
}

/**
 * Choose a table, a column or a concept, a relation that fits, and add. Tables come from the search over everything
 * cached (every catalog) or, for one that was never browsed, from a typed `catalog.schema.table[.column]` that is
 * checked with one tables.get call before it can be linked.
 */
function AddLink({ concept, onError }: { concept: ConceptDetail; onError: (m: string | null) => void }) {
  const add = useAddLink()
  const qc = useQueryClient()
  const connected = useUiStore((s) => s.connectedProfile)
  const concepts = useConcepts({ q: '', domain: '', status: '' })
  const [kind, setKind] = useState<TargetKind>('table')
  const [text, setText] = useState('')
  const [table, setTable] = useState<string | null>(null)
  const [column, setColumn] = useState('')
  const [conceptId, setConceptId] = useState('')
  const [relation, setRelation] = useState<string>(defaultRelation('table'))
  const [checking, setChecking] = useState(false)
  const graphNodes = useGraphStore((s) => s.nodes)
  const search = useSearch(kind === 'concept' || table ? '' : text)
  const object = useObject(kind === 'column' ? table : null)
  const columns = object.data ? columnsOf(object.data.data) : []
  const typed = kind === 'concept' || table ? null : parseTypedName(text)
  const typedFits = typed !== null && (kind === 'column' || typed.column === null)

  /** Check a typed full name against the workspace (cached after the first time) and take it as the target. */
  async function takeTypedName() {
    if (!typed || !typedFits) return
    onError(null)
    setChecking(true)
    try {
      const got = await qc.fetchQuery({ queryKey: ['object', connected, typed.table], queryFn: () => getObject(typed.table), staleTime: 60_000 })
      const name = typeof got.data.full_name === 'string' ? got.data.full_name : typed.table
      let picked = ''
      if (typed.column) {
        const found = findColumn(columnsOf(got.data), typed.column)
        if (!found) throw new Error(`${name} has no column "${typed.column}".`)
        picked = found.name
      }
      setTable(name)
      setColumn(picked)
      setText('')
    } catch (e) {
      onError(messageOf(e))
    } finally {
      setChecking(false)
    }
  }

  const relations = relationsFor(kind)
  const changeKind = (k: TargetKind) => {
    setKind(k)
    setRelation(defaultRelation(k))
    setColumn('')
  }
  const target =
    kind === 'concept'
      ? conceptId
        ? { table: `concept:${conceptId}` }
        : null
      : table
        ? { table, column: kind === 'column' && column ? column : null }
        : null
  const ready = target !== null && (kind !== 'column' || column !== '')
  const others = (concepts.data?.concepts ?? []).filter((c) => c.id !== concept.id)

  async function submit() {
    if (!target || !ready) return
    onError(null)
    try {
      await add.mutateAsync({ id: concept.id, body: { target, relation } })
      setText('')
      setTable(null)
      setColumn('')
      setConceptId('')
    } catch (e) {
      onError(messageOf(e))
    }
  }

  return (
    <form
      className="add-link"
      onSubmit={(e) => {
        e.preventDefault()
        if (typedFits && !table) void takeTypedName()
        else void submit()
      }}
      aria-label="Add a link"
    >
      <div className="add-link-row">
        <select value={kind} onChange={(e) => changeKind(e.target.value as TargetKind)} aria-label="Link to a">
          <option value="table">table</option>
          <option value="column">column</option>
          <option value="concept">concept</option>
        </select>
        {kind === 'concept' ? (
          <select value={conceptId} onChange={(e) => setConceptId(e.target.value)} aria-label="Concept to link to">
            <option value="">— pick a concept —</option>
            {others.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : table ? (
          <span className="picked-table">
            {table}{' '}
            <button type="button" onClick={() => { setTable(null); setColumn('') }} aria-label="Change table">
              change
            </button>
          </span>
        ) : (
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={connected ? 'search tables, or type catalog.schema.table' : 'connect first'}
            aria-label="Search tables"
            disabled={!connected}
          />
        )}
        {kind === 'column' && table && (
          <select value={column} onChange={(e) => setColumn(e.target.value)} aria-label="Column" disabled={!object.data}>
            <option value="">{object.isLoading ? 'loading columns…' : '— pick a column —'}</option>
            {columns.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.type})
              </option>
            ))}
          </select>
        )}
        <select value={relation} onChange={(e) => setRelation(e.target.value)} aria-label="Relation">
          {relations.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button type="submit" disabled={!ready || add.isPending}>
          Add link
        </button>
      </div>
      {kind !== 'concept' && !table && text.trim() && (
        <ul className="table-hits" aria-label="Matching tables">
          {typed && (
            <li>
              <button type="button" onClick={() => void takeTypedName()} disabled={!typedFits || checking}>
                {checking ? 'Checking…' : typedFits ? `Use ${text.trim()}` : `Switch to "column" to link ${text.trim()}`}
              </button>
            </li>
          )}
          {search.isError && <li className="error">{search.error.message}</li>}
          {search.data?.data.slice(0, 12).map((r) => (
            <li key={r.full_name}>
              <button type="button" onClick={() => setTable(r.full_name)}>
                {r.full_name}
              </button>
            </li>
          ))}
          {search.data && search.data.data.length === 0 && !typed && (
            <li className="hint">No match in {search.data.source}. A table never browsed can be linked by its full catalog.schema.table name.</li>
          )}
        </ul>
      )}
      {graphNodes.length > 0 && kind !== 'concept' && !table && !text.trim() && (
        <div className="hint">
          On the graph:{' '}
          {graphNodes
            .filter((n) => !n.id.startsWith('ph:'))
            .slice(0, 6)
            .map((n) => (
              <button type="button" key={n.id} className="as-link" onClick={() => setTable(n.id)}>
                {n.data.name}
              </button>
            ))}
        </div>
      )}
    </form>
  )
}
