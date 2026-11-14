import { useState } from 'react'
import {
  CONCEPT_STATUSES,
  useConcept,
  useCreateConcept,
  useDeleteConcept,
  usePatchConcept,
  type ConceptDetail,
  type ConceptStatus,
} from '../api/concepts'
import { fmtTime } from '../graph/format'
import { Candidates } from './Candidates'
import { useConceptsStore } from './conceptsStore'
import { LinksSection } from './LinksSection'
import { ConfirmDialog } from '../shared/Dialog'
import { bodyOf, draftOf, EMPTY_DRAFT, isDirty, type Draft } from './model'

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface EditorProps {
  /** A concept id, or 'new'. */
  id: string
  names: ReadonlyMap<string, string>
  domains: string[]
}

/** Loads the concept, then hands it to the form. The parent keys this by id, so switching concepts resets the form. */
export function ConceptEditor({ id, names, domains }: EditorProps) {
  const q = useConcept(id === 'new' ? null : id)
  if (id === 'new') return <Form concept={null} names={names} domains={domains} />
  if (q.isError) {
    return (
      <div className="concept-editor">
        <p className="error">{q.error.message}</p>
      </div>
    )
  }
  if (!q.data) {
    return (
      <div className="concept-editor">
        <p className="hint">Loading…</p>
      </div>
    )
  }
  return <Form concept={q.data} names={names} domains={domains} />
}

function Form({ concept, names, domains }: { concept: ConceptDetail | null; names: ReadonlyMap<string, string>; domains: string[] }) {
  const [draft, setDraft] = useState<Draft>(concept ? draftOf(concept) : EMPTY_DRAFT)
  const [error, setError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const create = useCreateConcept()
  const patch = usePatchConcept()
  const del = useDeleteConcept()
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const dirty = concept ? isDirty(draft, concept) : draft.name.trim() !== ''
  const { select } = useConceptsStore.getState()

  async function save() {
    setError(null)
    try {
      if (concept) {
        const saved = await patch.mutateAsync({ id: concept.id, body: bodyOf(draft) })
        setDraft(draftOf(saved))
      } else {
        const made = await create.mutateAsync(bodyOf(draft))
        select(made.id)
      }
    } catch (e) {
      setError(messageOf(e))
    }
  }

  const linkCount = concept ? concept.links.length + concept.incoming.length : 0

  async function remove() {
    if (!concept) return
    setConfirmingDelete(false)
    setError(null)
    try {
      await del.mutateAsync(concept.id)
      select(null)
    } catch (e) {
      setError(messageOf(e))
    }
  }

  return (
    <div className="concept-editor">
      <form
        className="concept-form"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <h3>{concept ? 'Edit concept' : 'New concept'}</h3>
        <label>
          Name
          <input value={draft.name} onChange={(e) => set('name', e.target.value)} aria-label="Name" required maxLength={200} />
        </label>
        <label>
          Definition
          <textarea value={draft.definition} onChange={(e) => set('definition', e.target.value)} rows={3} aria-label="Definition" />
        </label>
        <label>
          Synonyms <span className="hint">comma separated</span>
          <input value={draft.synonyms} onChange={(e) => set('synonyms', e.target.value)} aria-label="Synonyms" />
        </label>
        <div className="concept-form-row">
          <label>
            Domain
            <input
              value={draft.domain}
              onChange={(e) => set('domain', e.target.value)}
              list="concept-domains"
              aria-label="Domain"
              placeholder="none"
            />
            <datalist id="concept-domains">
              {domains.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </label>
          <label>
            Status
            <select value={draft.status} onChange={(e) => set('status', e.target.value as ConceptStatus)} aria-label="Status">
              {CONCEPT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Tags <span className="hint">comma separated</span>
          <input value={draft.tags} onChange={(e) => set('tags', e.target.value)} aria-label="Tags" />
        </label>
        {concept && (
          <dl className="concept-prov">
            <dt>Origin</dt>
            <dd>
              {concept.provenance.origin}
              {concept.provenance.source_ref ? ` (${concept.provenance.source_ref})` : ''}
              {concept.provenance.fetched_at ? `, read ${fmtTime(concept.provenance.fetched_at)}` : ''}
            </dd>
            <dt>Created</dt>
            <dd>{fmtTime(concept.created_at)}</dd>
            <dt>Updated</dt>
            <dd>{fmtTime(concept.updated_at)}</dd>
          </dl>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="btns">
          <button type="submit" disabled={!dirty || !draft.name.trim() || create.isPending || patch.isPending}>
            {concept ? 'Save' : 'Create'}
          </button>
          {concept && dirty && <button type="button" onClick={() => setDraft(draftOf(concept))}>Revert</button>}
          {!concept && <button type="button" onClick={() => select(null)}>Cancel</button>}
          {concept && (
            <button type="button" className="danger" onClick={() => setConfirmingDelete(true)} disabled={del.isPending}>
              Delete
            </button>
          )}
        </div>
      </form>
      {concept && confirmingDelete && (
        <ConfirmDialog
          title="Delete concept"
          message={`Delete "${concept.name}"${linkCount ? ` and its ${linkCount} link${linkCount === 1 ? '' : 's'}` : ''}?`}
          confirmLabel="Delete"
          destructive
          onConfirm={() => void remove()}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
      {concept ? (
        <>
          <LinksSection concept={concept} names={names} />
          <Candidates concept={concept} />
        </>
      ) : (
        <p className="hint">Create the concept, then link it to tables, columns and other concepts.</p>
      )}
    </div>
  )
}
