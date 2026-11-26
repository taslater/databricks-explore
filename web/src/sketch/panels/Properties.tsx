import { useState } from 'react'
import { useSearch } from '../../api/hooks'
import { useUiStore } from '../../store/uiStore'
import { DEFAULT_FONT_SIZE, DEFAULT_STROKE, FILLS, FONT_SIZES, SHAPE_NAMES, STROKES } from '../model'
import { useColumnDiff } from '../nodes/PlaceholderNode'
import { useSketchStore } from '../sketchStore'
import { summarize } from '../tables'
import { SHAPE_KINDS, type ShapeKind, type SketchNode } from '../types'
import { ArrangeControls } from './ArrangeControls'
import { EdgeProperties } from './EdgeProperties'
import { nodeName, Swatches } from './parts'

/** Link a placeholder to the real table it stands for, and show how the two differ. */
function LinkSection({ node }: { node: SketchNode }) {
  const spec = node.placeholder!
  const updatePlaceholder = useSketchStore((s) => s.updatePlaceholder)
  const connected = useUiStore((s) => s.connectedProfile)
  const [q, setQ] = useState('')
  const search = useSearch(q)
  const diff = useColumnDiff(node)
  const summary = diff ? summarize(diff.rows) : null

  function link(full: string | null) {
    updatePlaceholder(node.id, (p) => ({ ...p, linked: full }), `ph-link:${node.id}:${Date.now()}`)
    setQ('')
  }

  return (
    <section className="panel-section">
      <h4>Real table</h4>
      {spec.linked ? (
        <>
          <p>
            Linked to <code>{spec.linked}</code>. Its columns show on the card, and differences are marked there.
          </p>
          {diff?.error && <p className="hint">{diff.error}</p>}
          {summary && !diff?.error && !diff?.loading && (
            <ul className="sk-diff">
              <li>{summary.same} match</li>
              <li>{summary.new} only in the sketch</li>
              <li>{summary.type} with a different type</li>
              <li>{summary.existing} only in the table</li>
            </ul>
          )}
          <button onClick={() => link(null)}>Unlink</button>
        </>
      ) : (
        <>
          <p className="hint">Once the table exists, link it to compare columns.</p>
          <label className="field">
            Search tables
            <input
              value={q}
              list={`link-${node.id}`}
              placeholder={connected === null ? 'Connect to search' : 'catalog.schema.table'}
              disabled={connected === null}
              onChange={(e) => {
                const v = e.target.value
                setQ(v)
                if (/^[^.\s]+\.[^.\s]+\.[^.\s]+$/.test(v.trim()) && search.data?.data.some((r) => r.full_name === v.trim())) link(v.trim())
              }}
              onKeyDown={(e) => {
                e.stopPropagation()
                const v = q.trim()
                if (e.key === 'Enter' && /^[^.\s]+\.[^.\s]+\.[^.\s]+$/.test(v)) link(v)
              }}
            />
          </label>
          <datalist id={`link-${node.id}`}>
            {search.data?.data.slice(0, 30).map((r) => (
              <option key={r.full_name} value={r.full_name} />
            ))}
          </datalist>
          <p className="hint">Pick a suggestion, or type the full name and press Enter.</p>
        </>
      )}
    </section>
  )
}

function NodeProperties({ targets }: { targets: SketchNode[] }) {
  const updateSelected = useSketchStore((s) => s.updateSelected)
  const updateNode = useSketchStore((s) => s.updateNode)
  const updatePlaceholder = useSketchStore((s) => s.updatePlaceholder)
  const first = targets[0]
  const single = targets.length === 1 ? first : null
  const allLocked = targets.every((n) => n.locked)
  const isPlaceholder = single?.type === 'placeholder'

  return (
    <>
      {single && single.type !== 'placeholder' && (
        <section className="panel-section">
          <h4>{single.type === 'shape' ? SHAPE_NAMES[single.shape ?? 'rect'] : single.type[0].toUpperCase() + single.type.slice(1)}</h4>
          <label className="field">
            Label
            <textarea
              rows={3}
              value={single.label ?? ''}
              disabled={single.locked}
              onChange={(e) => updateNode(single.id, { label: e.target.value }, `label:${single.id}`)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </label>
          {single.type === 'shape' && (
            <label className="field">
              Shape
              <select value={single.shape} disabled={single.locked} onChange={(e) => updateNode(single.id, { shape: e.target.value as ShapeKind })}>
                {SHAPE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {SHAPE_NAMES[k]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>
      )}
      {isPlaceholder && single && (
        <section className="panel-section">
          <h4>New table</h4>
          <label className="field">
            Name
            <input
              value={single.placeholder?.name ?? ''}
              disabled={single.locked}
              onChange={(e) => updatePlaceholder(single.id, (p) => ({ ...p, name: e.target.value }), `ph-name:${single.id}`)}
              onKeyDown={(e) => e.stopPropagation()}
            />
          </label>
          <p className="hint">Edit columns on the card. Click a key box to cycle PK and FK.</p>
        </section>
      )}
      {isPlaceholder && single && <LinkSection node={single} />}
      {targets.length > 1 && (
        <section className="panel-section">
          <h4>{targets.length} sketch nodes</h4>
          <p className="hint">Style changes apply to all of them.</p>
        </section>
      )}
      <section className="panel-section">
        <h4>Style</h4>
        <div className="field">
          Fill
          <Swatches swatches={FILLS} value={first.fill} onPick={(v) => updateSelected({ fill: v })} />
        </div>
        <div className="field">
          {isPlaceholder ? 'Header and outline' : 'Outline'}
          <Swatches swatches={STROKES} value={first.stroke ?? DEFAULT_STROKE} onPick={(v) => updateSelected({ stroke: v })} />
        </div>
        <div className="field">
          Font size
          <div className="seg" role="group" aria-label="Font size">
            {FONT_SIZES.map((f) => (
              <button
                key={f.px}
                className={(first.font_size ?? DEFAULT_FONT_SIZE) === f.px ? 'active' : undefined}
                aria-pressed={(first.font_size ?? DEFAULT_FONT_SIZE) === f.px}
                title={`${f.px} px`}
                onClick={() => updateSelected({ font_size: f.px })}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </section>
      {single && (
        <section className="panel-section">
          <h4>Position and size</h4>
          <div className="sk-geo">
            {(['x', 'y'] as const).map((k) => (
              <label key={k}>
                {k.toUpperCase()}
                <input
                  type="number"
                  value={Math.round(single.position[k])}
                  disabled={single.locked}
                  onChange={(e) => updateNode(single.id, { position: { ...single.position, [k]: Number(e.target.value) } }, `geo:${single.id}`)}
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </label>
            ))}
            {(['w', 'h'] as const).map((k) => (
              <label key={k}>
                {k === 'w' ? 'W' : 'H'}
                <input
                  type="number"
                  min={20}
                  value={Math.round(single.size[k])}
                  disabled={single.locked || isPlaceholder}
                  onChange={(e) =>
                    updateNode(single.id, { size: { ...single.size, [k]: Math.max(20, Number(e.target.value)) } }, `geo:${single.id}`)
                  }
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </label>
            ))}
          </div>
        </section>
      )}
      <label className="check">
        <input type="checkbox" checked={allLocked} onChange={(e) => updateSelected({ locked: e.target.checked || undefined })} />
        Locked (cannot be moved, resized, edited or deleted)
      </label>
    </>
  )
}

const HELP: [string, string][] = [
  ['V H C', 'select, pan, connect'],
  ['R U O D B', 'rectangle, rounded, ellipse, diamond, database'],
  ['T S F P', 'text, sticky note, frame, new table'],
  ['Q N', 'query window, Markdown note'],
  ['Cmd/Ctrl Z', 'undo (Shift: redo)'],
  ['Cmd/Ctrl C V D', 'copy, paste, duplicate'],
  ['Delete', 'delete selection'],
  ['Cmd/Ctrl ] [', 'forward, backward (Shift: front, back)'],
  ['Shift+Cmd/Ctrl L', 'lock'],
  ['Arrows', 'nudge (Shift: a grid step)'],
  ['Enter or F2', 'edit the label'],
  ['G', 'snap to grid'],
  ['Esc', 'deselect, back to Select'],
]

/**
 * The properties panel for the current selection: a sketch node (label, shape, style, position, lock, and for a
 * placeholder its table link), several nodes (style and arrange), or a connector (line, arrows, label, and the
 * relationship section). With nothing selected it lists the shortcuts. Mount it in the host's details area.
 */
export function SketchProperties({ canvasName }: { canvasName: string | null }) {
  const nodes = useSketchStore((s) => s.nodes)
  const edges = useSketchStore((s) => s.edges)
  const selectedIds = useSketchStore((s) => s.selectedIds)
  const selectedEdgeIds = useSketchStore((s) => s.selectedEdgeIds)
  const host = useSketchStore((s) => s.host)

  const sketchTargets = nodes.filter((n) => selectedIds.includes(n.id))
  const hostTargets = host.nodes().filter((h) => selectedIds.includes(h.id))
  const edge = selectedEdgeIds.length === 1 && selectedIds.length === 0 ? edges.find((e) => e.id === selectedEdgeIds[0]) : undefined

  let body
  if (edge) {
    body = <EdgeProperties edge={edge} canvasName={canvasName} />
  } else if (sketchTargets.length === 0 && hostTargets.length === 0) {
    body = (
      <div className="props">
        <p className="hint">Select a shape, table or connector to edit it here.</p>
        <table className="sk-help">
          <tbody>
            {HELP.map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  } else {
    body = (
      <div className="props">
        {sketchTargets.length > 0 && <NodeProperties targets={sketchTargets} />}
        {hostTargets.length > 0 && (
          <section className="panel-section">
            <h4>{hostTargets.length === 1 ? 'Window' : `${hostTargets.length} windows`}</h4>
            <p className="hint">
              {hostTargets.map((h) => nodeName(undefined, h)).join(', ')}. Query windows, notes and table cards are edited in the window itself.
              Locking and stacking order work here.
            </p>
          </section>
        )}
        <section className="panel-section">
          <h4>Arrange</h4>
          <ArrangeControls />
        </section>
      </div>
    )
  }

  return (
    <aside className="details sk-props-panel" aria-label="Properties">
      <div className="panel-header">
        <strong>Properties</strong>
      </div>
      {body}
    </aside>
  )
}
