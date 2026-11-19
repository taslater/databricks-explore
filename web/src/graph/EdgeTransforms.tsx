// What a flow edge does with its source: up to two small glyphs at the target end, and the "How" section of its Details.
import { EdgeLabelRenderer, type Position } from '@xyflow/react'
import { useMemo, useState } from 'react'
import { useEdgeTransformsFor, useReadStatements, useStatementPlan, type EdgeTransform, type TransformGlyph, type TransformOrigin } from '../api/edgeTransforms'
import { openSqlInCanvas } from '../ask/canvasAction'
import { glyphSpot, glyphTitle, FILTER_KIND, howLines, isPassThrough, transformCandidates } from './transformText'
import { fmtAge } from './format'
import { useGraphStore } from './graphStore'
import type { FlowEdge } from './types'

/** The transforms of the flow edges on the graph, read from the server's cache of definitions and statements. Silent when they cannot be read. */
export function useEdgeTransforms() {
  const edges = useGraphStore((s) => s.edges)
  const wanted = useMemo(() => transformCandidates(edges), [edges])
  return useEdgeTransformsFor(wanted)
}

/** 14 x 14 icons: sigma, bowtie, cup, a one, a funnel. */
const ICON: Record<TransformGlyph, string> = {
  aggregate: 'M10.5 2.5H3.5L7 7L3.5 11.5H10.5',
  join: 'M1.5 3.5L7 7L1.5 10.5ZM12.5 3.5L7 7L12.5 10.5Z',
  union: 'M3.5 2.5V7.5A3.5 3.5 0 0 0 10.5 7.5V2.5',
  dedupe: 'M4.5 4.5L7.5 2.5V11.5M5 11.5H10',
  filter: 'M2 3H12L7 11.5Z',
}

/** One small icon, drawn in the current color. */
export function GlyphIcon({ glyph }: { glyph: TransformGlyph }) {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON[glyph]} />
    </svg>
  )
}

/** The glyphs of a flow edge, out from the end at its target. Click selects the edge, for the details. */
export function EdgeTransformGlyphs({ id, transform, x, y, side, faded }: { id: string; transform?: EdgeTransform; x: number; y: number; side: Position; faded?: boolean }) {
  if (!transform || transform.glyphs.length === 0) return null
  return (
    <EdgeLabelRenderer>
      {transform.glyphs.map((g, n) => {
        const spot = glyphSpot(x, y, side, n)
        return (
          <button
            key={g}
            className="edge-glyph transform nodrag nopan"
            data-testid={`edge-glyph-${g}`}
            style={{ transform: `translate(-50%, -50%) translate(${spot.x}px, ${spot.y}px)`, opacity: faded ? 0.2 : 1 }}
            title={glyphTitle(g, transform)}
            aria-label={glyphTitle(g, transform)}
            onClick={() => useGraphStore.getState().setSelection({ kind: 'edge', id })}
          >
            <GlyphIcon glyph={g} />
          </button>
        )
      })}
    </EdgeLabelRenderer>
  )
}

const NOTE_TEXT: Record<string, string> = {
  metric_view: "A metric view's definition is YAML, not SQL.",
  redacted: 'The statement text is hidden from you (<REDACTED>), so what it does cannot be read.',
  not_read: 'The SQL behind this table does not name this source, so nothing is known about what happens to it.',
  unreadable: 'The table could not be read.',
}

function writerText(o: TransformOrigin): string {
  const w = o.writer
  return w?.type ? `Written by ${w.type} ${w.id ?? ''}, no SQL to read.` : 'Written without a SQL statement, so there is no SQL to read.'
}

function fromText(o: TransformOrigin): string {
  if (o.kind === 'view') return "From the view's definition."
  const s = o.statement
  if (!s) return ''
  return `From statement ${s.id}${s.type ? ` (${s.type})` : ''}${s.run_by ? `, run by ${s.run_by}` : ''}${s.at ? `, ${fmtAge(s.at)}` : ''}.`
}

/** Details for a flow edge: what its target's SQL does with this source, and the SQL itself, unrun. */
export function EdgeHow({ edge }: { edge: FlowEdge }) {
  const info = edge.data!.info
  const answers = useEdgeTransforms().data
  const answer = answers?.edges[info.id]
  const origin = answers?.origins[info.target]
  if (!answer || !origin) return null
  const t = answer.transform
  return (
    <div data-testid="edge-how">
      <h4>How</h4>
      {t ? (
        <>
          {howLines(t).map((line) => (
            <p key={line}>{line}</p>
          ))}
          {isPassThrough(t) && t.driving && <p className="hint">Nothing happens to it on the way: no join, filter, aggregate or dedupe.</p>}
          {t.filters.length > 0 && (
            <ul className="how-filters">
              {t.filters.map((f) => (
                <li key={f.kind + f.sql}>
                  <span className="hint">{FILTER_KIND[f.kind]}</span> <code>{f.sql}</code>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : answer.note === 'unread' ? (
        <ReadStatement table={info.target} />
      ) : answer.note === 'no_sql' ? (
        <>
          <p>{writerText(origin)}</p>
          <ReadStatement table={info.target} again />
        </>
      ) : answer.note === 'unparsed' ? (
        <p className="error">The SQL could not be read: {answer.error}</p>
      ) : (
        <p className="hint">{NOTE_TEXT[answer.note ?? ''] ?? ''}</p>
      )}
      {origin.sql && (
        <p className="hint">
          {fromText(origin)}{' '}
          <button onClick={() => openSqlInCanvas(origin.sql!)} title="Add a query window with this SQL to the Canvas. It is not run.">
            Show SQL
          </button>
        </p>
      )}
    </div>
  )
}

/** The opt-in read: shows the statement it would run on the warehouse and runs it on a click. */
function ReadStatement({ table, again }: { table: string; again?: boolean }) {
  const [open, setOpen] = useState(false)
  const plan = useStatementPlan([table], open)
  const read = useReadStatements()
  const statement = plan.data?.statements[0]
  const error = read.data?.errors[table] ?? (read.error ? (read.error as Error).message : null)
  if (!open) {
    return (
      <p className="hint">
        {again ? null : 'How this table is built is in the SQL that wrote it. '}
        <button onClick={() => setOpen(true)}>{again ? 'Read again' : 'Read the statement that wrote it'}</button>
      </p>
    )
  }
  return (
    <div data-testid="read-statement">
      <p className="hint">Runs on the selected warehouse, as you, and is kept for next time:</p>
      {statement ? <pre className="how-sql">{statement.sql}</pre> : <p className="hint">{plan.isLoading ? 'Preparing...' : (plan.data?.skipped[0]?.reason ?? 'Nothing to read.')}</p>}
      {plan.data && !plan.data.warehouse_id && <p className="error">Pick a SQL warehouse first.</p>}
      {error && <p className="error">{error}</p>}
      <button disabled={!statement || !plan.data?.warehouse_id || read.isPending} onClick={() => read.mutate([table], { onSuccess: () => setOpen(false) })}>
        {read.isPending ? 'Reading...' : 'Run'}
      </button>{' '}
      <button onClick={() => setOpen(false)}>Cancel</button>
    </div>
  )
}
