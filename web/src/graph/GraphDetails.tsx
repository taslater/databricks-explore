import { useState, type ReactNode } from 'react'
import { useEdge, useObject } from '../api/hooks'
import type { EdgeFlow, Producer } from '../api/types'
import { sendToCanvas, useGraphActions } from './actions'
import { ageDays, fmtAge, lastPart } from './format'
import { DEFAULT_STALE_DAYS, useGraphStore } from './graphStore'
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
    s.selection?.kind === 'edge' ? s.edges.find((e) => e.id === s.selection?.id) : undefined,
  )
  const actions = useGraphActions()

  // Keep the field's own text so the user can clear it and type a new number. The store gets the parsed value.
  const [daysText, setDaysText] = useState(String(staleDays))

  return (
    <div className="details">
      <section className="graph-controls">
        <label className="check">
          <input type="checkbox" checked={filters.lineage} onChange={(e) => setFilter('lineage', e.target.checked)} />
          <span className="lg-lineage">── lineage</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={filters.fk} onChange={(e) => setFilter('fk', e.target.checked)} />
          <span className="lg-fk">- - FK</span>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={filters.view_dep}
            onChange={(e) => setFilter('view_dep', e.target.checked)}
          />
          <span className="lg-view">── view dep</span>
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

function NodeDetails({ id, node }: { id: string; node: FlowNode }) {
  const obj = useObject(id)
  if (obj.isPending) return <p className="hint">loading…</p>
  if (obj.isError) return <p className="error">{obj.error.message}</p>
  const payload = obj.data
  const t = payload.data
  const cols = t.columns ?? []
  const constraints = (t.table_constraints ?? []).map((c) => JSON.stringify(c)).join('\n')
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
      {constraints && (
        <>
          <h4>Constraints</h4>
          <pre>{constraints}</pre>
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
  return <LineageDetails source={info.source} target={info.target} bidir={!!info.bidir} staleDays={staleDays} />
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
