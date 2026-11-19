import { useEffect, useMemo, useState, type ReactNode } from 'react'
import * as api from '../api/client'
import { useEdge, useJoinKeys, useObject } from '../api/hooks'
import { formatConstraints } from './constraints'
import { keyDetail, rankKeys } from '../canvas/linking/joinKeys'
import type { EdgeFlow, GraphEdge, JoinKey, Producer, RelationshipStatus } from '../api/types'
import { fetchCurrentEdge, messageOf, useGraphActions } from './actions'
import { KIND_LABEL } from './edgeStyles'
import { EdgeCardinality } from './EdgeEnds'
import { EdgeFilterBoxes, EdgeFrom, EdgeLegend } from './EdgeFamilies'
import { fmtAge, fmtTime, lastPart } from './format'
import { useGraphStore } from './graphStore'
import { canReview, patchIds } from './relationships'
import { EdgeGrainDetails, NodeFactsDetails } from './NodeFacts'
import type { FlowEdge, FlowNode } from './types'

/** Right panel for the graph: visibility filters, actions, and details for the selected node or edge. */
export function GraphDetails() {
  const filters = useGraphStore((s) => s.filters)
  const setFilter = useGraphStore((s) => s.setFilter)
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
  const several = pickedTables.length > 1
  // With one table picked, its details; with several, the list (the last-clicked node alone would mislead).
  const detailNode = several ? undefined : (allNodes.find((n) => n.id === pickedTables[0]) ?? selectedNode)

  return (
    <div className="details">
      <section className="graph-controls">
        <EdgeFilterBoxes />
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
            checked={filters.showSuperseded}
            onChange={(e) => setFilter('showSuperseded', e.target.checked)}
          />
          superseded edges (no longer hold)
        </label>
        <EdgeLegend />
        <div className="legend-kinds">
          <span className="k tbl">table</span> <span className="k view">view / MV</span>{' '}
          <span className="k st">streaming</span> <span className="k ext">other schema</span>{' '}
          <span className="k miss">missing</span> <span className="k">↻ self-ref</span>
        </div>
      </section>

      <p className="hint">Click a node or edge for details. Shift-click to select several. Double-click a node to expand it. Drag to arrange.</p>

      <div className="btns">
        <button
          onClick={() => actions.refreshSelected()}
          disabled={!selectedNode}
          title="Re-read this node's relationships from Databricks"
        >
          Refresh selected
        </button>
        <button
          onClick={() => void actions.sendTables(pickedTables)}
          disabled={pickedTables.length === 0}
          title={
            several
              ? 'Add the selected tables to the canvas as cards, laid out left to right by dependency, with connectors for the known relationships among them'
              : 'Add a table card for this object to the canvas'
          }
        >
          {several ? `Send ${pickedTables.length} tables to canvas` : 'Send to canvas'}
        </button>
        <button
          onClick={() => void actions.sendPath(pickedTables[0], 'downstream')}
          disabled={pickedTables.length !== 1}
          title="Send this table and everything built from it that the graph shows (lineage and view dependencies), with connectors. Select one table."
        >
          Send downstream path
        </button>
        <button
          onClick={() => void actions.sendPath(pickedTables[0], 'upstream')}
          disabled={pickedTables.length !== 1}
          title="Send this table and everything it is built from that the graph shows (lineage and view dependencies), with connectors. Select one table."
        >
          Send upstream path
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
        {several && <SelectionDetails tables={pickedTables} />}
        {detailNode && (detailNode.data.missing ? <MissingDetails id={detailNode.id} node={detailNode} /> : <NodeDetails id={detailNode.id} node={detailNode} />)}
        {selectedEdge && <EdgeDetails edge={selectedEdge} />}
      </div>
    </div>
  )
}

/** The tables ticked on the graph, when there is more than one. */
function SelectionDetails({ tables }: { tables: string[] }) {
  return (
    <div>
      <h3>{tables.length} tables selected</h3>
      <ul className="constraints">
        {tables.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <p className="hint">Shift-click a selected table to remove it. Send them to the canvas together, with their connectors.</p>
    </div>
  )
}

/** An object that does not exist: why, and a likely new name. Nothing is read from Databricks. */
function MissingDetails({ id, node }: { id: string; node: FlowNode }) {
  const { missingReason, renamedTo } = node.data
  const actions = useGraphActions()
  return (
    <div>
      <h3>{id}</h3>
      <p>
        This object does not exist{missingReason ? `: ${missingReason}` : ''}. A view or key still names it, or lineage saw it
        under that name.
      </p>
      {renamedTo && (
        <p>
          Possibly renamed to{' '}
          <button className="link" onClick={() => void actions.addObject(renamedTo)}>
            {renamedTo}
          </button>
          .
        </p>
      )}
    </div>
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
      <NodeFactsDetails id={id} />
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
      <ViewJoins id={id} />
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

function EdgeDetails({ edge }: { edge: FlowEdge }) {
  const info = edge.data!.info
  return (
    <div>
      <EdgeBody info={info} />
      <EdgeFrom info={info} />
      <EdgeCardinality info={info} />
      <EdgeGrainDetails edge={edge} />
      <EdgeProvenance info={info} />
      <EdgeReview key={edge.id} info={info} />
    </div>
  )
}

function EdgeBody({ info }: { info: GraphEdge }) {
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
          <LineageDetails source={info.source} target={info.target} bidir={false} />
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
        {info.last_seen && <p>Last read {fmtAge(info.last_seen)} (from the lineage API).</p>}
        <p className="hint">Click the view for its definition.</p>
      </div>
    )
  }
  if (info.kind === 'lineage') {
    return (
      <div>
        {info.status === 'superseded' && (
          <p className="hint">
            Superseded: the target's current definition no longer reads this source, or the target was recreated after the last
            event. Shown because "superseded edges" is on.
          </p>
        )}
        <LineageDetails source={info.source} target={info.target} bidir={!!info.bidir} />
      </div>
    )
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

/** The joins a view's own SQL defines, between its base tables. Nothing for a table, or a view that joins nothing. */
function ViewJoins({ id }: { id: string }) {
  const joins = useJoinKeys(id).data?.view_joins
  if (!joins || joins.length === 0) return null
  return (
    <>
      <h4>Joins in this view</h4>
      <ul className="constraints">
        {joins.map((j, i) => (
          <li key={i} title={`${j.left} and ${j.right}`}>
            {j.pairs.map((p) => `${lastOf(j.left)}.${p.left} = ${lastOf(j.right)}.${p.right}`).join(' AND ')}
          </li>
        ))}
      </ul>
    </>
  )
}

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
  superseded: 'superseded (no longer holds)',
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

function LineageDetails({ source, target, bidir }: { source: string; target: string; bidir: boolean }) {
  const info = useEdge(source, target)
  let body: ReactNode
  if (info.isPending) body = <p className="hint">loading…</p>
  else if (info.isError) body = <p className="error">{info.error.message}</p>
  else if (info.data.flows.length === 0)
    body = <p className="hint">Nothing cached for this pair. Refresh one of the nodes.</p>
  else
    body = info.data.flows.map((f, i) => <FlowBlock key={`${f.source}-${f.target}-${i}`} flow={f} />)

  return (
    <div>
      <h3>Lineage{bidir ? ' (both ways)' : ''}</h3>
      <p>
        {source}
        <br />
        {bidir ? '↔' : '→'} {target}
      </p>
      {body}
      <p className="hint">From the lineage API (Unity Catalog keeps about a year).</p>
    </div>
  )
}

function FlowBlock({ flow }: { flow: EdgeFlow }) {
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
              <ProducerRow key={`${p.kind}-${p.id}-${i}`} producer={p} />
            ))}
          </tbody>
        </table>
      ) : (
        <p className="hint">No job/notebook/pipeline info returned.</p>
      )}
    </div>
  )
}

function ProducerRow({ producer: p }: { producer: Producer }) {
  const label = `${p.kind} ${p.id}`
  return (
    <tr>
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
