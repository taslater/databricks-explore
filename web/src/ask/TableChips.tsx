import { useState } from 'react'
import type { AskTable } from '../api/ask'
import { useGraphActions } from '../graph/actions'
import { useUiStore } from '../store/uiStore'
import { LinkConceptDialog } from './LinkConceptDialog'

/** The tables an answer links to. Each chip opens the table in the Graph or links it to a concept. */
export function TableChips({ tables }: { tables: AskTable[] }) {
  const { openObject } = useGraphActions()
  const setView = useUiStore((s) => s.setView)
  const [linking, setLinking] = useState<string | null>(null)
  if (tables.length === 0) return null

  return (
    <div className="ask-tables" aria-label="Tables in this answer">
      {tables.map((t) => (
        <span className="ask-chip" key={t.name}>
          <span className="ask-chip-name" title={t.name}>
            {t.name}
          </span>
          <button
            onClick={() => {
              openObject(t.name)
              setView('graph')
            }}
            title="Start a graph on this table"
          >
            Open in Graph
          </button>
          <button onClick={() => setLinking(t.name)} title="Link this table to a concept">
            Link to concept…
          </button>
        </span>
      ))}
      {linking && <LinkConceptDialog table={linking} onClose={() => setLinking(null)} />}
    </div>
  )
}
