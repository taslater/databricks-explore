import { useState } from 'react'
import { useModalBehavior } from '../shared/Dialog'
import { useAddLink, useConcepts, useCreateConcept } from '../api/concepts'

const ALL = { q: '', domain: '', status: '' } as const
const NEW = 'new'

/** Links a table to a concept with `describes`: pick an existing concept or create one by name. */
export function LinkConceptDialog({ table, onClose }: { table: string; onClose: () => void }) {
  useModalBehavior(onClose)
  const concepts = useConcepts(ALL)
  const create = useCreateConcept()
  const add = useAddLink()
  const [choice, setChoice] = useState('')
  const [name, setName] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const list = concepts.data?.concepts ?? []
  const busy = create.isPending || add.isPending
  const ready = choice !== '' && (choice !== NEW || name.trim() !== '')

  async function link() {
    setError(null)
    try {
      let id = choice
      let label = list.find((c) => c.id === choice)?.name ?? ''
      if (choice === NEW) {
        const made = await create.mutateAsync({ name: name.trim() })
        id = made.id
        label = made.name
      }
      await add.mutateAsync({ id, body: { target: { table }, relation: 'describes' } })
      setDone(`${table} is now described by “${label}”.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="modal ask-link-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Link to concept"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3>Link to concept</h3>
        <p className="hint">
          Adds a “describes” link from a concept to <code>{table}</code>. Pick a concept or make a new one.
        </p>
        {concepts.isError && <p className="error">{concepts.error.message}</p>}
        {!done && (
          <div className="ask-link-form">
            <select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Concept" disabled={busy}>
              <option value="">Choose a concept…</option>
              {list.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value={NEW}>New concept…</option>
            </select>
            {choice === NEW && (
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name of the new concept"
                aria-label="New concept name"
                autoFocus
                disabled={busy}
              />
            )}
          </div>
        )}
        {done && (
          <p role="status" data-testid="ask-link-done">
            {done}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="btns">
          {!done && (
            <button onClick={() => void link()} disabled={!ready || busy}>
              {busy ? 'Linking…' : 'Link'}
            </button>
          )}
          <button onClick={onClose}>{done ? 'Close' : 'Cancel'}</button>
        </div>
      </div>
    </div>
  )
}
