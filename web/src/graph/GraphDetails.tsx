import { useEffect, useMemo, useState, type ReactNode } from 'react'
import * as api from '../api/client'
import { useEdge, useJoinKeys, useObject } from '../api/hooks'
import { formatConstraints } from './constraints'
import { keyDetail, rankKeys } from '../canvas/linking/joinKeys'
import type { EdgeFlow, GraphEdge, JoinKey, Producer, RelationshipStatus } from '../api/types'
import { fetchCurrentEdge, messageOf, sendToCanvas, useGraphActions } from './actions'
import { DERIVED_KINDS, KIND_LABEL, KIND_STYLE, STORED_KINDS } from './edgeStyles'
import { ageDays, fmtAge, fmtTime, lastPart } from './format'
import { DEFAULT_STALE_DAYS, useGraphStore } from './graphStore'
import { canReview, patchIds } from './relationships'
import type { FlowEdge, FlowNode } from './types'

/** Right panel for the graph: visibility filters, actions, and details for the selected node or edge. */
export function GraphDetails() {
  const filters = useGraphStore((s) => s.filters)
  const setFilter = useGraphStore((s) => s.setFilter)
  const staleDays = useGraphStore((s) => s.staleDays)
  const setStaleDays = useGraphStore((s) => s.setStaleDays)
  const hasNodes = useGraphStore((s) => s.nodes.length > 0)
  const selectedNode = useGraphStore((s) =>
    s.selection?.kind === 'node' ? s.nodes.find((n) => n.id === s.selection?.id) : undefined,
  )
  const selectedEdge = useGraphStore((s) =>
    s.selection?.kind === 'edge'
      ? (s.edges.find((e) => e.id === s.selection?.id) ?? s.columnEdges.find((e) => e.id === s.selection?.id))
      : undefined,
  )
  const actions = useGraphActions()
  const allNodes = useGraphStore((s) => s.nodes)
  // The tables ticked on the graph (shift-click or drag a box), or the one node whose details are open.
  const pickedTables = useMemo(() => {
    const picked = allNodes.filter((n) => n.selected && !n.id.startsWith('ph:')).map((n) => n.id)
    return picked.length > 0 ? picked : selectedNode && !selectedNode.id.startsWith('ph:') ? [selectedNode.id] : []
  }, [allNodes, selectedNode])

  // Keep the field's own text so the user can clear it and type a new number. The store gets the parsed value.
  const [daysText, setDaysText] = useState(String(staleDays))

  return (
    <div className="details">
      <section className="graph-controls">
        <div className="legend-group">From Unity Catalog</div>
        {DERIVED_KINDS.map((kind) => (
          <KindFilter key={kind} kind={kind} />
        ))}
        <div className="legend-group">Stored</div>
        {STORED_KINDS.map((kind) => (
          <KindFilter key={kind} kind={kind} />
        ))}
        <label className="check">
          <input
            type="checkbox"
            checked={filters.showRejected}
            onChange={(e) => setFilter('showRejected', e.target.checked)}
          />
          rejected edges
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={filters.showStale}
            onChange={(e) => setFilter('showStale', e.target.checked)}
          />
          stale lineage (not seen in
          <input
            type="number"
            className="days-input"
            min={1}
            value={daysText}
            onChange={(e) => {
              setDaysText(e.target.value)
              setStaleDays(Number(e.target.value) || DEFAULT_STALE_DAYS)
            }}
            aria-label="Stale after days"
          />
          days)
        </label>
        <p className="hint legend-note">Lighter lines are proposed, faint ones rejected. No arrowhead means undirected.</p>
        <div className="legend-kinds">
          <span className="k tbl">table</span> <span className="k view">view / MV</span>{' '}
          <span className="k st">streaming</span> <span className="k ext">other schema</span>{' '}
          <span className="k">↻ self-ref</span>
        </div>
      </section>

      <p className="hint">Click a node or edge for details. Double-click a node to expand it. Drag to arrange.</p>

      <div className="btns">
        <button
          onClick={() => actions.refreshSelected()}
          disabled={!selectedNode}
          title="Re-read this node's relationships from Databricks"
        >
          Refresh selected
        </button>
        <button
          onClick={() => {
            if (selectedNode) useGraphStore.getState().setStatus(sendToCanvas(selectedNode.id))
          }}
          disabled={!selectedNode}
          title="Add a table card for this object to the canvas"
        >
          Send to canvas
        </button>
        <button
          onClick={() => void actions.queryTables(pickedTables)}
          disabled={pickedTables.length === 0}
          title="Write a SELECT that joins the selected tables along known relationships, and open it on the canvas"
        >
          Query {pickedTables.length > 1 ? 'these tables' : 'this table'}
        </button>
        <button onClick={() => useGraphStore.getState().requestLayout()} disabled={!hasNodes}>
          Reset layout
        </button>
        <button onClick={() => useGraphStore.getState().clear()}>Clear</button>
      </div>

      <div className="details-body">
        {selectedNode && <NodeDetails id={selectedNode.id} node={selectedNode} />}
        {selectedEdge && <EdgeDetails edge={selectedEdge} staleDays={staleDays} />}
      </div>
    </div>
  )
}

/** A filter checkbox for one edge kind, with a sample of its line style as the legend. */
function KindFilter({ kind }: { kind: GraphEdge['kind'] }) {
  const checked = useGraphStore((s) => s.filters[kind])
  const setFilter = useGraphStore((s) => s.setFilter)
  const style = KIND_STYLE[kind]
  return (
    <label className="check kind-filter">
      <input type="checkbox" checked={checked} onChange={(e) => setFilter(kind, e.target.checked)} />
      <svg className="lg-line" width="34" height="8" aria-hidden="true">
        <line
          x1="1"
          y1="4"
          x2="33"
          y2="4"
          stroke={style.stroke}
          strokeWidth={style.strokeWidth ?? 1.6}
          strokeDasharray={style.strokeDasharray}
        />
      </svg>
      {KIND_LABEL[kind]}
    </label>
  )
}

function NodeDetails({ id, node }: { id: string; node: FlowNode }) {
  const obj = useObject(id)
  if (obj.isPending) return <p className="hint">loading…</p>
  if (obj.isError) return <p className="error">{obj.error.message}</p>
  const payload = obj.data
  const t = payload.data
  const cols = t.columns ?? []
  const constraints = formatConstraints(t.table_constraints)
  const viewDefinition = str(t.view_definition)
  return (
    <div>
      <h3>{str(t.full_name) || id}</h3>
      <div>
        {str(t.table_type)} · {str(t.data_source_format)} · owner {str(t.owner) || '?'}
      </div>
      <div className="hint">cached {payload.fetched_at}</div>
      {node.data.selfRef && <p>↻ Reads its own data (e.g. MERGE). Last seen {fmtAge(node.data.selfRefLastSeen)}</p>}
      <p>{str(t.comment)}</p>
      {constraints.length > 0 && (
        <>
          <h4>Constraints</h4>
          <ul className="constraints">
            {constraints.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </>
      )}
      <h4>Columns ({cols.length})</h4>
      <table className="cols">
        <tbody>
          {cols.map((c, i) => (
            <tr key={`${str(c.name)}-${i}`}>
              <td>{str(c.name)}</td>
              <td>{str(c.type_text)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {viewDefinition && (
        <>
          <h4>View definition</h4>
          <pre>{viewDefinition}</pre>
        </>
      )}
    </div>
  )
}

function EdgeDetails({ edge, staleDays }: { edge: FlowEdge; staleDays: number }) {
  const info = edge.data!.info
  return (
    <div>
      <EdgeBody info={info} staleDays={staleDays} />
      <EdgeProvenance info={info} />
      <EdgeReview key={edge.id} info={info} />
    </div>
  )
}

function EdgeBody({ info, staleDays }: { info: GraphEdge; staleDays: number }) {
  if (info.source_column && info.target_column) {
    const from = `${info.source}.${info.source_column}`
    const to = `${info.target}.${info.target_column}`
    return (
      <div>
        <h3>Column {KIND_LABEL[info.kind]}</h3>
        <p>
          {from}
          <br />
          {info.directed === false ? '↔' : '→'} {to}
        </p>
        {info.kind === 'lineage' && (
          <LineageDetails source={info.source} target={info.target} bidir={false} staleDays={staleDays} />
        )}
      </div>
    )
  }
  if (info.kind === 'fk') {
    const child = info.child_columns ?? []
    const parent = info.parent_columns ?? []
    return (
      <div>
        <h3>Foreign key</h3>
        <div>{info.constraint ?? ''}</div>
        <p>
          {info.source}
          <br />→ {info.target}
        </p>
        <table className="cols">
          <tbody>
            {child.map((c, i) => (
              <tr key={`${c}-${i}`}>
                <td>{c}</td>
                <td>→ {parent[i] ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  if (info.kind === 'view_dep') {
    return (
      <div>
        <h3>View dependency</h3>
        <p>
          {info.source} → {info.target}
        </p>
        <p className="hint">Click the view for its definition.</p>
      </div>
    )
  }
  if (info.kind === 'lineage') {
    return <LineageDetails source={info.source} target={info.target} bidir={!!info.bidir} staleDays={staleDays} />
  }
  return (
    <div>
      <h3>{KIND_LABEL[info.kind]}</h3>
      <p>
        {info.source}
        <br />
        {info.directed === false ? '↔' : '→'} {info.target}
      </p>
      {(info.kind === 'join_mined' || info.kind === 'manual') && <JoinKeySets info={info} />}
    </div>
  )
}

const lastOf = (table: string) => table.split('.').pop() ?? table

/**
 * The key sets a mined or manual table edge stands for, one per way the tables were joined: which columns, and
 * for a mined one how many statements used exactly that set. A composite key is one line with its columns ANDed.
 */
function JoinKeySets({ info }: { info: GraphEdge }) {
  const joins = useJoinKeys(info.source)
  const wanted = info.kind === 'manual' ? 'manual' : 'mined'
  const keys: JoinKey[] = useMemo(() => {
    const found = joins.data?.joins.find((j) => j.table.toLowerCase() === info.target.toLowerCase())
    const mine = (found?.keys ?? []).filter((k) => k.source === wanted && k.pairs.length > 0)
    // Usable ones first, best first, then the rejected ones.
    return [...rankKeys(mine), ...mine.filter((k) => k.status === 'rejected')]
  }, [joins.data, info.target, wanted])
  if (joins.isPending) return <p className="hint">loading columns…</p>
  if (joins.isError) return <p className="error">{joins.error.message}</p>
  if (keys.length === 0) return <p className="hint">No columns recorded for this edge.</p>
  const a = lastOf(info.source)
  const b = lastOf(info.target)
  return (
    <div className="key-sets">
      <h4>{keys.length === 1 ? 'Joined on' : `Joined ${keys.length} ways`}</h4>
      {keys.map((k, i) => (
        <p key={i} className={k.status === 'rejected' ? 'rejected' : undefined}>
          {k.pairs.map((p) => `${a}.${p.here} = ${b}.${p.there}`).join(' AND ')}
          <br />
          <span className="hint">
            {keyDetail(k)}
            {k.pairs.length > 1 ? ' · composite key' : ''}
            {k.status === 'rejected' ? ' · rejected' : ''}
          </span>
        </p>
      ))}
      {wanted === 'mined' && (
        <p className="hint">
          Runs are counted per key set, in the Suggestions list too. A single column's runs include the statements that
          used it inside a composite key, so they are not added up here.
        </p>
      )}
    </div>
  )
}

/** Where a stored or derived edge came from and how often it was seen. Hidden for edges from an old saved diagram. */
function EdgeProvenance({ info }: { info: GraphEdge }) {
  const p = info.provenance
  const ev = info.evidence
  if (!p) return null
  // A table-level mined edge adds up the runs of its column pairs, which counts a composite-key statement once per
  // column. The key sets above carry the real counts, so the sum is not shown.
  const summed = info.kind === 'join_mined' && !info.source_column
  const counts = ev && !summed ? [ev.runs != null && `${ev.runs} runs`, ev.users != null && `${ev.users} users`].filter(Boolean) : []
  return (
    <div className="edge-provenance">
      <h4>Provenance</h4>
      <div>
        {p.origin}
        {p.source_ref ? ` · ${p.source_ref}` : ''}
      </div>
      {p.fetched_at && <div className="hint">read {fmtAge(p.fetched_at)}</div>}
      {ev && (
        <>
          <h4>Evidence</h4>
          {counts.length > 0 && <div>{counts.join(' · ')}</div>}
          {(ev.first_seen || ev.last_seen) && (
            <div>
              {ev.first_seen ? `first seen ${fmtTime(ev.first_seen)}` : ''}
              {ev.first_seen && ev.last_seen ? ' · ' : ''}
              {ev.last_seen ? `last seen ${fmtTime(ev.last_seen)}` : ''}
            </div>
          )}
          {ev.sample_refs.length > 0 && <div className="hint">samples: {ev.sample_refs.join(', ')}</div>}
        </>
      )}
    </div>
  )
}

const STATUS_TEXT: Record<RelationshipStatus, string> = {
  derived: 'derived from Unity Catalog',
  proposed: 'proposed',
  accepted: 'accepted',
  rejected: 'rejected',
}

/**
 * Status and note for the selected edge. A stored edge can be accepted or rejected and carries a note.
 * A derived edge takes a note only. Changes go to every id the edge stands for (see patchIds).
 */
function EdgeReview({ info }: { info: GraphEdge }) {
  const [note, setNote] = useState(info.note ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The note box stays disabled until the server's current note is in, so saving never blanks one that
  // an edge restored from an old diagram did not carry.
  const [loaded, setLoaded] = useState(false)
  const status: RelationshipStatus = info.status ?? 'derived'
  const id = info.id

  useEffect(() => {
    let live = true
    const current = useGraphStore.getState().edges.find((e) => e.id === id)?.data?.info
    if (!current) return
    fetchCurrentEdge(current)
      .then((fresh) => {
        if (!live) return
        if (fresh) {
          const { status, note, provenance, evidence, directed, patch_ids } = fresh
          useGraphStore.getState().updateEdgeInfo(id, { status, note, provenance, evidence, directed, patch_ids })
          setNote(note ?? '')
        }
        setLoaded(true)
      })
      .catch((e) => {
        if (live) setError(messageOf(e))
      })
    return () => {
      live = false
    }
  }, [id])
  const stored = canReview(info)

  async function send(body: { status: 'accepted' | 'rejected' } | { note: string }) {
    setBusy(true)
    setError(null)
    try {
      await Promise.all(patchIds(info).map((id) => api.patchRelationship(id, body)))
      useGraphStore.getState().updateEdgeInfo(info.id, body)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="edge-review">
      <h4>Status</h4>
      <div className={`edge-status status-${status}`}>{STATUS_TEXT[status]}</div>
      {stored && (
        <div className="btns">
          <button disabled={busy || status === 'accepted'} onClick={() => void send({ status: 'accepted' })}>
            Accept
          </button>
          <button disabled={busy || status === 'rejected'} onClick={() => void send({ status: 'rejected' })}>
            Reject
          </button>
        </div>
      )}
      <h4>Note</h4>
      <textarea
        className="edge-note"
        rows={3}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        aria-label="Note"
        disabled={!loaded}
        placeholder={stored ? 'Why this edge is right or wrong' : 'A note on this derived edge'}
      />
      <div className="btns">
        <button disabled={busy || !loaded || note === (info.note ?? '')} onClick={() => void send({ note })}>
          Save note
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  )
}

function LineageDetails({
  source,
  target,
  bidir,
  staleDays,
}: {
  source: string
  target: string
  bidir: boolean
  staleDays: number
}) {
  const info = useEdge(source, target)
  let body: ReactNode
  if (info.isPending) body = <p className="hint">loading…</p>
  else if (info.isError) body = <p className="error">{info.error.message}</p>
  else if (info.data.flows.length === 0)
    body = <p className="hint">Nothing cached for this pair. Refresh one of the nodes.</p>
  else
    body = info.data.flows.map((f, i) => (
      <FlowBlock key={`${f.source}-${f.target}-${i}`} flow={f} staleDays={staleDays} />
    ))

  return (
    <div>
      <h3>Lineage{bidir ? ' (both ways)' : ''}</h3>
      <p>
        {source}
        <br />
        {bidir ? '↔' : '→'} {target}
      </p>
      {body}
      <p className="hint">
        Producers older than {staleDays} days are grey. From the lineage API (Unity Catalog keeps about a year).
      </p>
    </div>
  )
}

function FlowBlock({ flow, staleDays }: { flow: EdgeFlow; staleDays: number }) {
  return (
    <div>
      <h4>
        {lastPart(flow.source)} → {lastPart(flow.target)}
      </h4>
      <div>last seen {fmtAge(flow.last_seen)}</div>
      {flow.producers.length > 0 ? (
        <table className="cols">
          <tbody>
            {flow.producers.map((p, i) => (
              <ProducerRow key={`${p.kind}-${p.id}-${i}`} producer={p} staleDays={staleDays} />
            ))}
          </tbody>
        </table>
      ) : (
        <p className="hint">No job/notebook/pipeline info returned.</p>
      )}
    </div>
  )
}

function ProducerRow({ producer: p, staleDays }: { producer: Producer; staleDays: number }) {
  const age = ageDays(p.last_seen)
  const stale = age !== null && age > staleDays
  const label = `${p.kind} ${p.id}`
  return (
    <tr className={stale ? 'stale' : undefined}>
      <td>
        {p.url ? (
          <a href={p.url} target="_blank" rel="noreferrer">
            {label}
          </a>
        ) : (
          label
        )}
        {p.other_workspace && <small> (other workspace)</small>}
      </td>
      <td>{fmtAge(p.last_seen)}</td>
    </tr>
  )
}

/** Server values can be non-strings (for example numbers or null), so turn them into text before rendering. */
function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}
