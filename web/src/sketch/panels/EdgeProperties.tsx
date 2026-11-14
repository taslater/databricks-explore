import { useState } from 'react'
import * as api from '../../api/client'
import { useObject } from '../../api/hooks'
import { useUiStore } from '../../store/uiStore'
import { realColumns } from '../nodes/PlaceholderNode'
import { STROKES, DEFAULT_EDGE_COLOR } from '../model'
import { useSketchStore } from '../sketchStore'
import { newStoredEdgeId, sketchColumnNames, sketchImportFile, storeTableName, type TableLike } from '../tables'
import type { LineKind, SketchEdge, SketchNode } from '../types'
import { nodeName, Swatches } from './parts'

const LINES: { kind: LineKind; label: string }[] = [
  { kind: 'straight', label: 'Straight' },
  { kind: 'step', label: 'Orthogonal' },
  { kind: 'curve', label: 'Curved' },
]

/** What an end of a connector is: its table name in the relationship store (or null), and its columns. */
function useEnd(id: string): { like: TableLike | null; table: string | null; label: string; columns: string[] } {
  const node: SketchNode | undefined = useSketchStore((s) => s.nodes.find((n) => n.id === id))
  const hostNode = useSketchStore((s) => s.host.nodes().find((h) => h.id === id))
  const like: TableLike | null = node
    ? { type: node.type, placeholder: node.placeholder }
    : hostNode
      ? { type: hostNode.type, table: hostNode.table }
      : null
  const table = like ? storeTableName(like) : null
  const real = table && !table.startsWith('ph:') ? table : null
  const detail = useObject(real)
  const names = new Set<string>(like ? sketchColumnNames(like) : [])
  for (const c of realColumns(detail.data?.data)) names.add(c.name)
  return { like, table, label: nodeName(node, hostNode), columns: [...names] }
}

function ColumnSelect({ label, value, options, disabled, onChange }: {
  label: string
  value: string | undefined
  options: string[]
  disabled: boolean
  onChange: (v: string | undefined) => void
}) {
  const all = value && !options.includes(value) ? [value, ...options] : options
  return (
    <label className="field">
      {label}
      <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">(table level)</option>
        {all.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </label>
  )
}

/** Save this connector to the relationship store as a `sketch` edge, on request. Never done automatically. */
function RelationshipSection({ edge, canvasName }: { edge: SketchEdge; canvasName: string | null }) {
  const src = useEnd(edge.source)
  const tgt = useEnd(edge.target)
  const connected = useUiStore((s) => s.connectedProfile)
  const updateEdge = useSketchStore((s) => s.updateEdge)
  const markRelationship = useSketchStore((s) => s.markRelationship)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)
  const saved = edge.relationship?.id

  if (!src.table || !tgt.table) {
    return (
      <section className="panel-section">
        <h4>Relationship</h4>
        <p className="hint">Connect two tables (table cards or placeholders) to save the link as a relationship.</p>
      </section>
    )
  }
  const sourceTable = src.table
  const targetTable = tgt.table

  function setColumn(side: 'source_column' | 'target_column', v: string | undefined) {
    const next = { ...(edge.relationship ?? {}) }
    if (v) next[side] = v
    else delete next[side]
    updateEdge(edge.id, { relationship: Object.keys(next).length > 0 ? next : undefined }, `rel:${edge.id}`)
  }

  async function save() {
    setBusy(true)
    setMessage(null)
    try {
      const wanted = newStoredEdgeId()
      await api.importRelationships(sketchImportFile({ edge, sourceTable, targetTable, canvasName, id: wanted }))
      // The store keeps its own id when the same edge already existed, so look the stored edge up.
      const probe = sourceTable.startsWith('ph:') ? sourceTable : targetTable.startsWith('ph:') ? targetTable : sourceTable
      const found = await api.getRelationships(probe, false, 'column')
      const stored =
        found.edges.find((e) => e.id === wanted) ??
        found.edges.find(
          (e) =>
            e.kind === 'sketch' &&
            [sourceTable, targetTable].includes(e.source.table) &&
            [sourceTable, targetTable].includes(e.target.table) &&
            e.source.table !== e.target.table,
        )
      markRelationship(edge.id, { ...(edge.relationship ?? {}), id: stored?.id ?? wanted })
      setMessage({ text: 'Saved to the relationship store.', error: false })
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), error: true })
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!saved) return
    setBusy(true)
    setMessage(null)
    try {
      try {
        await api.deleteRelationship(saved)
      } catch (e) {
        // Already gone from the store (removed in the Graph tab, say): the connector should still let go of it.
        if (!(e instanceof Error) || !/not found/i.test(e.message)) throw e
      }
      const { id: _gone, ...rest } = edge.relationship ?? {}
      markRelationship(edge.id, rest)
      setMessage({ text: 'Removed from the relationship store.', error: false })
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : String(e), error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel-section">
      <h4>Relationship</h4>
      <p className="hint">
        {src.label} to {tgt.label}. Columns are optional.
      </p>
      <ColumnSelect
        label={`Column in ${src.label}`}
        value={edge.relationship?.source_column}
        options={src.columns}
        disabled={!!saved}
        onChange={(v) => setColumn('source_column', v)}
      />
      <ColumnSelect
        label={`Column in ${tgt.label}`}
        value={edge.relationship?.target_column}
        options={tgt.columns}
        disabled={!!saved}
        onChange={(v) => setColumn('target_column', v)}
      />
      {saved ? (
        <>
          <p className="hint">
            Saved as a sketch edge (<code>{saved}</code>). To change columns or direction, remove it and save again.
            Deleting this connector does not remove the stored edge.
          </p>
          <button disabled={busy} onClick={() => void remove()}>
            Remove from relationship store
          </button>
        </>
      ) : (
        <button
          disabled={busy || connected === null}
          title={connected === null ? 'Connect to a profile to use the relationship store.' : 'Writes one sketch edge to the relationship store'}
          onClick={() => void save()}
        >
          Save to relationship store
        </button>
      )}
      {message && (
        <p className={message.error ? 'error' : 'hint'} role={message.error ? 'alert' : undefined}>
          {message.text}
        </p>
      )}
    </section>
  )
}

/** Properties of one connector: line, arrowheads, dash, color, label, direction, and the relationship section. */
export function EdgeProperties({ edge, canvasName }: { edge: SketchEdge; canvasName: string | null }) {
  const updateEdge = useSketchStore((s) => s.updateEdge)
  const reverse = useSketchStore((s) => s.reverseEdge)
  const setEdgeLabel = useSketchStore((s) => s.setEdgeLabel)
  const saved = !!edge.relationship?.id
  return (
    <div className="props">
      <section className="panel-section">
        <h4>Connector</h4>
        <div className="seg" role="group" aria-label="Line type">
          {LINES.map((l) => (
            <button
              key={l.kind}
              className={edge.line === l.kind ? 'active' : undefined}
              aria-pressed={edge.line === l.kind}
              onClick={() => updateEdge(edge.id, { line: l.kind })}
            >
              {l.label}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={edge.arrow_start} onChange={(e) => updateEdge(edge.id, { arrow_start: e.target.checked })} />
          Arrowhead at the start
        </label>
        <label className="check">
          <input type="checkbox" checked={edge.arrow_end} onChange={(e) => updateEdge(edge.id, { arrow_end: e.target.checked })} />
          Arrowhead at the end
        </label>
        <label className="check">
          <input type="checkbox" checked={edge.dashed} onChange={(e) => updateEdge(edge.id, { dashed: e.target.checked })} />
          Dashed
        </label>
        <div className="field">
          Color
          <Swatches swatches={STROKES} value={edge.color ?? DEFAULT_EDGE_COLOR} onPick={(v) => updateEdge(edge.id, { color: v })} />
        </div>
        <label className="field">
          Label
          <input
            value={edge.label ?? ''}
            placeholder="none"
            onChange={(e) => setEdgeLabel(edge.id, e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </label>
        <button disabled={saved} onClick={() => reverse(edge.id)} title={saved ? 'Remove it from the relationship store first' : 'Swap the two ends'}>
          Reverse direction
        </button>
      </section>
      <RelationshipSection edge={edge} canvasName={canvasName} />
    </div>
  )
}
