// The column trace's pieces on the Graph: the right-click menu on a column row, the bar that ends it, the label on a hop, and its Details.
import { EdgeLabelRenderer, type Position } from '@xyflow/react'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { useColumnTraceData, type TraceDirection, type TraceHop } from '../api/columnTrace'
import { useReadStatements, useStatementPlan } from '../api/edgeTransforms'
import { ContextMenu, wantsBrowserMenu, type MenuItem } from '../shared/ContextMenu'
import { fmtAge, lastPart } from './format'
import { useGraphStore } from './graphStore'
import { hopLines, NOTE_WORDS, type ActiveTrace } from './traceDraw'
import { useTraceActions } from './traceActions'
import { useTraceStore } from './traceStore'
import { glyphSpot } from './transformText'

/** The trace to draw: what the server answered for the request, with the columns loaded for its tables. Null when none is on, or it has not answered yet. */
export function useActiveTrace(): ActiveTrace | null {
  const request = useTraceStore((s) => s.request)
  const columns = useTraceStore((s) => s.columns)
  const data = useColumnTraceData(request).data
  return useMemo(() => (request && data && data.table === request.table && data.column === request.column ? { data, columns } : null), [request, data, columns])
}

const WORD: Record<TraceDirection, string> = { upstream: 'upstream', downstream: 'downstream', both: 'both ways' }

/** The items that trace one column. */
export function traceItems(table: string, column: string, start: (table: string, column: string, direction: TraceDirection) => void, clear: (() => void) | null): MenuItem[] {
  return [
    { kind: 'title', label: `${lastPart(table)}.${column}` },
    { kind: 'action', label: 'Trace upstream', title: 'Where does this column come from?', run: () => start(table, column, 'upstream') },
    { kind: 'action', label: 'Trace downstream', title: 'What is built from this column?', run: () => start(table, column, 'downstream') },
    { kind: 'action', label: 'Trace both', run: () => start(table, column, 'both') },
    ...(clear ? ([{ kind: 'separator' }, { kind: 'action', label: 'Clear trace', run: clear }] as MenuItem[]) : []),
  ]
}

/** A column row's right-click menu: `props(column)` goes on the row, `element` is drawn once beside the rows. Shift+right-click keeps the browser's menu. */
export function useColumnTraceMenu(table: string) {
  const actions = useTraceActions()
  const active = useTraceStore((s) => s.request !== null)
  const [open, setOpen] = useState<{ x: number; y: number; column: string } | null>(null)
  const props = (column: string) => ({
    onContextMenu: (e: MouseEvent) => {
      if (wantsBrowserMenu(e)) return
      e.preventDefault()
      e.stopPropagation()
      setOpen({ x: e.clientX, y: e.clientY, column })
    },
  })
  const element = open ? (
    <ContextMenu x={open.x} y={open.y} items={traceItems(table, open.column, (t, c, d) => void actions.start(t, c, d), active ? actions.stop : null)} onClose={() => setOpen(null)} />
  ) : null
  return { props, element }
}

/** Three small buttons that trace a column: in the column list of a table's Details. */
export function TraceButtons({ table, column }: { table: string; column: string }) {
  const actions = useTraceActions()
  const go = (d: TraceDirection, glyph: string, title: string) => (
    <button className="trace-btn" title={title} aria-label={`${title}: ${column}`} onClick={() => void actions.start(table, column, d)}>
      {glyph}
    </button>
  )
  return (
    <span className="trace-btns">
      {go('upstream', '←', 'Trace upstream')}
      {go('downstream', '→', 'Trace downstream')}
      {go('both', '↔', 'Trace both')}
    </span>
  )
}

/** The bar over the graph while a trace is on: what it traces and the button that ends it. Esc ends it too. */
export function TraceBar() {
  const request = useTraceStore((s) => s.request)
  const actions = useTraceActions()
  const query = useColumnTraceData(request)
  const startMissing = useGraphStore((s) => request !== null && !s.nodes.some((n) => n.id === request.table))
  useEffect(() => {
    if (!request) return
    if (startMissing) {
      useTraceStore.getState().reset() // the graph was cleared or replaced: nothing is left to restore
      return
    }
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (e.key === 'Escape' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') actions.stop()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, startMissing, actions])
  if (!request) return null
  const hops = query.data?.hops.length
  return (
    <div className="trace-bar" role="status" data-testid="trace-bar">
      <span>
        Tracing <b>{lastPart(request.table)}.{request.column}</b> {WORD[request.direction]}
        {hops !== undefined && ` · ${hops} hop${hops === 1 ? '' : 's'}`}
        {query.isFetching && hops === undefined && ' · reading…'}
        {query.isError && ' · failed'}
      </span>
      <button onClick={actions.stop} title="End the trace and put the graph back as it was (Esc)">
        Clear trace
      </button>
    </div>
  )
}

/** The class of a hop, as a small label at its target end. */
export function EdgeTraceLabel({ hop, x, y, side, faded }: { hop?: TraceHop; x: number; y: number; side: Position; faded?: boolean }) {
  if (!hop?.label) return null
  const spot = glyphSpot(x, y, side, 0)
  const title = hop.expr ? `${hop.label}: ${hop.expr}` : hop.class === 'same' ? 'The same column, read as it is' : hop.class === 'rename' ? 'The same column under another name' : hop.label
  return (
    <EdgeLabelRenderer>
      <span
        className="edge-trace-label nodrag nopan"
        data-testid="trace-label"
        title={title}
        style={{ transform: `translate(-50%, -50%) translate(${spot.x}px, ${spot.y}px)`, opacity: faded ? 0.2 : 1 }}
      >
        {hop.label}
      </span>
    </EdgeLabelRenderer>
  )
}

/** Details of the trace: the hops as a list, upstream first, what is unread and who reads the end. Shown while a trace is on. */
export function TraceDetails() {
  const request = useTraceStore((s) => s.request)
  const actions = useTraceActions()
  const query = useColumnTraceData(request)
  if (!request) return null
  const data = query.data
  const lines = data ? hopLines(data) : []
  return (
    <div data-testid="trace-details">
      <h3>
        Trace: {lastPart(request.table)}.{request.column}
      </h3>
      <p className="hint">
        {WORD[request.direction]}, up to {request.depth} hops each way.{' '}
        <button onClick={actions.stop}>Clear trace</button>
      </p>
      {query.isError && <p className="error">{(query.error as Error).message}</p>}
      {!data && !query.isError && <p className="hint">reading column lineage…</p>}
      {data && lines.length === 0 && <p className="hint">No column lineage found. Lineage only shows queries run since it was enabled; without a warehouse only the REST API and view definitions are read.</p>}
      {lines.length > 0 && (
        <ol className="trace-hops">
          {lines.map((l) => (
            <li key={l.id} title={l.expr ?? undefined}>
              <code>{l.from}</code> <span className="trace-arrow">→</span>{' '}
              {l.label ? <span className="edge-trace-label inline">{l.label}</span> : <span className="hint">({l.note ? (NOTE_WORDS[l.note] ?? l.note) : 'unknown'})</span>}{' '}
              <span className="trace-arrow">→</span> <code>{l.to}</code>
              {l.expr && <div className="hint trace-expr">{l.expr}</div>}
            </li>
          ))}
        </ol>
      )}
      {data && data.unread.length > 0 && <ReadUnread tables={data.unread} />}
      {data && data.readers.length > 0 && (
        <>
          <h4>Read by</h4>
          <ul className="trace-readers">
            {data.readers.map((r) => (
              <li key={`${r.table}|${r.kind}|${r.id}`}>
                {r.url ? (
                  <a href={r.url} target="_blank" rel="noreferrer">
                    {r.kind} {r.id}
                  </a>
                ) : (
                  <>
                    {r.kind} {r.id}
                  </>
                )}{' '}
                <span className="hint">
                  reads {lastPart(r.table)}
                  {r.last_seen ? `, ${fmtAge(r.last_seen)}` : ''}
                </span>
              </li>
            ))}
          </ul>
          <p className="hint">Lineage names the readers of a table, not of one column.</p>
        </>
      )}
      {data?.truncated && <p className="hint">Stopped at the cap on tables or hops: trace one direction, or from a table nearer the middle.</p>}
      {data?.errors.map((m) => (
        <p key={m} className="error">
          {m}
        </p>
      ))}
    </div>
  )
}

/** The opt-in read of the statements that wrote the tables on the path, which gives their hops a class. Shows the SQL first. */
function ReadUnread({ tables }: { tables: string[] }) {
  const [open, setOpen] = useState(false)
  const plan = useStatementPlan(tables, open)
  const read = useReadStatements()
  const qc = useQueryClient()
  const statements = plan.data?.statements ?? []
  const errors = Object.entries(read.data?.errors ?? {})
  return (
    <div data-testid="trace-unread">
      <p className="hint">
        {tables.length === 1 ? 'One table was' : `${tables.length} tables were`} written by a statement that was not read, so the hops into {tables.length === 1 ? 'it have' : 'them have'} no class yet.{' '}
        {!open && <button onClick={() => setOpen(true)}>Read the statements</button>}
      </p>
      {open && (
        <>
          <p className="hint">Runs on the selected warehouse, as you, one statement per table, and is kept for next time:</p>
          {statements.map((s) => (
            <pre key={s.table} className="how-sql">
              {s.sql}
            </pre>
          ))}
          {plan.isLoading && <p className="hint">Preparing...</p>}
          {plan.data && !plan.data.warehouse_id && <p className="error">Pick a SQL warehouse first.</p>}
          {errors.map(([t, m]) => (
            <p key={t} className="error">
              {lastPart(t)}: {m}
            </p>
          ))}
          <button
            disabled={statements.length === 0 || !plan.data?.warehouse_id || read.isPending}
            onClick={() => read.mutate(tables, { onSuccess: () => void qc.invalidateQueries({ queryKey: ['column-trace'] }) })}
          >
            {read.isPending ? 'Reading...' : 'Run'}
          </button>{' '}
          <button onClick={() => setOpen(false)}>Cancel</button>
        </>
      )}
    </div>
  )
}
