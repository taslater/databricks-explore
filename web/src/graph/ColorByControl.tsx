// "Color by": the toolbar menu, the dialog that shows the SQL before tags are read, and the legend of the values on screen.
import { useMemo, useState } from 'react'
import { useCertification } from '../api/concepts'
import { useNodeFacts } from '../api/nodeFacts'
import { useNodeMeta, useReadTags, useTagsPlan, type MetaByTable } from '../api/nodeMeta'
import { certificationOf } from '../concepts/certification'
import { useUiStore } from '../store/uiStore'
import { messageOf } from './actions'
import {
  colorByLabel,
  colorNodes,
  isTagMode,
  MODES,
  tagKeyOf,
  tagKeys,
  typeLegend,
  type ColorBy,
  type NodeColors,
} from './colorBy'
import { useGraphStore } from './graphStore'
import { ICON_LABEL, iconKind, TypeIcon, type IconKind } from './TypeIcon'

/** The tables Color by can read facts for: not placeholders, not missing. */
const isReadable = (n: { id: string; data: { missing?: boolean } }) => !n.id.startsWith('ph:') && !n.data.missing

/** What the graph is colored by, and the fill of each node and the legend for it (null in type mode, where the node's own fill stands). */
export function useNodeColors(): { colorBy: ColorBy; colors: NodeColors | null; meta: MetaByTable | undefined; tables: string[] } {
  const colorBy = useGraphStore((s) => s.colorBy)
  const nodes = useGraphStore((s) => s.nodes)
  const tables = useMemo(() => nodes.filter(isReadable).map((n) => n.id), [nodes])
  // Owners and tags come from the server's cache and tables.get, never a query. Read whatever the mode, so the menu knows what tags exist.
  const meta = useNodeMeta(tables).data
  const facts = useNodeFacts(tables).data
  const cert = useCertification().data
  const colors = useMemo(
    () =>
      colorBy === 'type'
        ? null
        : colorNodes(
            colorBy,
            nodes.map((n) => ({ id: n.id, schema: n.data.schema, missing: n.data.missing, certification: certificationOf(cert, n.id), facts: facts?.[n.id] })),
            meta,
          ),
    [colorBy, nodes, meta, facts, cert],
  )
  return { colorBy, colors, meta, tables }
}

/** The toolbar's Color by menu. For tag it adds a key menu and a button that reads the tags (after showing the SQL). */
export function ColorByControl() {
  const { colorBy, meta, tables } = useNodeColors()
  const setColorBy = useGraphStore((s) => s.setColorBy)
  const warehouseId = useUiStore((s) => s.warehouseId)
  const [reading, setReading] = useState(false)
  const keys = useMemo(() => tagKeys(meta), [meta])
  const keyList = isTagMode(colorBy) && !keys.includes(tagKeyOf(colorBy)) ? [...keys, tagKeyOf(colorBy)].sort() : keys
  // Tags are read through a warehouse. Without one the choice stays off, unless tags were read before or the graph already uses one.
  const tagOff = !warehouseId && keys.length === 0 && !isTagMode(colorBy)
  function choose(mode: string) {
    if (mode !== 'tag') return setColorBy(mode as ColorBy)
    if (keys.length > 0) setColorBy(`tag:${keys[0]}`)
    else setReading(true)
  }
  const nowrap = { whiteSpace: 'nowrap', flexShrink: 0 } as const
  return (
    <>
      <label style={nowrap} title="What the fill of a node means. The icon before the name always says what kind of object it is.">
        Color by{' '}
        <select value={isTagMode(colorBy) ? 'tag' : colorBy} onChange={(e) => choose(e.target.value)} aria-label="Color by">
          {MODES.map((m) => (
            <option key={m.id} value={m.id} disabled={m.id === 'tag' && tagOff}>
              {m.id === 'tag' && tagOff ? 'Tag (needs a SQL warehouse)' : m.label}
            </option>
          ))}
        </select>
      </label>
      {isTagMode(colorBy) && (
        <>
          <select
            value={tagKeyOf(colorBy)}
            onChange={(e) => setColorBy(`tag:${e.target.value}`)}
            aria-label="Tag key"
            style={{ flexShrink: 0 }}
          >
            {keyList.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <button
            style={nowrap}
            onClick={() => setReading(true)}
            disabled={tables.length === 0}
            title="Read the tags of the tables on the graph. Shows the SQL first."
          >
            Read tags…
          </button>
        </>
      )}
      {reading && (
        <TagsDialog
          tables={tables}
          onClose={() => setReading(false)}
          onRead={(read) => {
            const found = tagKeys(read)
            if (!isTagMode(colorBy) && found.length > 0) setColorBy(`tag:${found[0]}`)
          }}
        />
      )}
    </>
  )
}

/** Confirm dialog for reading tags: the exact statements, then Run. Never automatic. */
function TagsDialog({ tables, onClose, onRead }: { tables: string[]; onClose: () => void; onRead: (meta: MetaByTable) => void }) {
  const warehouseId = useUiStore((s) => s.warehouseId)
  const plan = useTagsPlan(tables, true)
  const read = useReadTags()
  const p = plan.data
  async function run() {
    try {
      const out = await read.mutateAsync(tables)
      onRead(out.meta)
      if (Object.keys(out.errors).length === 0) onClose()
    } catch {
      // the error shows in the dialog
    }
  }
  const errors = Object.entries(read.data?.errors ?? {})
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <div className="modal mine-dialog" role="dialog" aria-modal="true" aria-label="Read tags" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Read tags</h3>
        <p className="hint">
          Reads the Unity Catalog tags of each table through the selected SQL warehouse{p?.warehouse_id ? ` (${p.warehouse_id})` : ''}. This can start a stopped
          warehouse. Only tag names and values are kept, with the time they were read.
        </p>
        {plan.isPending && <p className="hint">loading…</p>}
        {plan.isError && <p className="error">{plan.error.message}</p>}
        {p && (
          <>
            <p data-testid="tags-plan-count">
              {p.statements.length} table{p.statements.length === 1 ? '' : 's'}.
            </p>
            {p.statements.length > 0 && (
              <details open>
                <summary>The SQL</summary>
                <pre className="mine-sql">{p.statements.map((s) => s.sql + ';').join('\n\n')}</pre>
              </details>
            )}
          </>
        )}
        {!warehouseId && <p className="error">Pick a SQL warehouse in the picker first.</p>}
        {read.isError && <p className="error">{messageOf(read.error)}</p>}
        {errors.length > 0 && (
          <ul className="error">
            {errors.map(([t, msg]) => (
              <li key={t}>
                {t}: {msg}
              </li>
            ))}
          </ul>
        )}
        <div className="btns">
          <button onClick={() => void run()} disabled={!warehouseId || !p || p.statements.length === 0 || read.isPending}>
            {read.isPending ? 'Reading…' : 'Run these statements'}
          </button>
          <button onClick={onClose}>{errors.length > 0 ? 'Close' : 'Cancel'}</button>
        </div>
      </div>
    </div>
  )
}

/** The legend of what the fill means: "Color by <what>" and only the values on screen, the icons present and the marks (other schema, missing, self-reference). */
export function ColorLegend() {
  const { colorBy, colors } = useNodeColors()
  const nodes = useGraphStore((s) => s.nodes)
  const focusSchema = useGraphStore((s) => s.focusSchema)
  if (nodes.length === 0) return null
  const entries = colorBy === 'type' ? typeLegend(nodes.map((n) => n.data.kind)) : (colors?.legend.entries ?? [])
  const other = colorBy === 'type' ? null : (colors?.legend.other ?? null)
  const icons = [...new Set(nodes.map((n) => iconKind(n.data.kind)))]
  const marks = {
    external: nodes.some((n) => n.data.schema !== focusSchema),
    missing: nodes.some((n) => n.data.missing),
    selfRef: nodes.some((n) => n.data.selfRef),
  }
  return (
    <div className="color-legend legend-kinds" aria-label="Color legend">
      <div className="legend-group">Color by {colorByLabel(colorBy)}</div>
      {entries.map((e) => (
        <span key={e.value}>
          <span className="k" style={{ background: e.fill }} title={`${e.count} on the graph`}>
            {e.value}
          </span>{' '}
        </span>
      ))}
      {other && (
        <span className="k other" title={`${other.count} on the graph`}>
          other ({other.values})
        </span>
      )}
      {colorBy !== 'type' && entries.length === 0 && !other && <span className="hint">no values on screen</span>}
      <div className="type-icons">
        {icons.map((k: IconKind) => (
          <span key={k} className="type-icon-key">
            <TypeIcon kind={k} /> {ICON_LABEL[k]}
          </span>
        ))}
      </div>
      {(marks.external || marks.missing || marks.selfRef) && (
        <div>
          {marks.external && <span className="k ext">other schema</span>} {marks.missing && <span className="k miss">missing</span>}{' '}
          {marks.selfRef && <span className="k">↻ self-ref</span>}
        </div>
      )}
    </div>
  )
}
