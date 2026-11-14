import { useEffect, useRef, useState } from 'react'
import { useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { useObject } from '../../api/hooks'
import type { TableInfo } from '../../api/types'
import { useUiStore } from '../../store/uiStore'
import { useSketchStore } from '../sketchStore'
import { diffColumns, summarize, type ColumnRow, type RealColumn } from '../tables'
import type { KeyMarker, PlaceholderColumn, SketchNode } from '../types'
import type { SketchFlowNode } from './ShapeNode'
import { SideHandles } from './SideHandles'
import { useSketchNode } from './useSketchNode'

const NEXT_KEY: Record<string, KeyMarker | undefined> = { '': 'pk', pk: 'fk', fk: undefined }
const KEY_LABEL: Record<string, string> = { '': '', pk: 'PK', fk: 'FK' }

/** Column list of a real table as the diff wants it. Databricks gives `type_text` when it has one. */
export function realColumns(info: TableInfo | undefined): RealColumn[] {
  const out: RealColumn[] = []
  for (const c of info?.columns ?? []) {
    if (typeof c.name !== 'string') continue
    const type = typeof c.type_text === 'string' && c.type_text !== '' ? c.type_text : typeof c.type_name === 'string' ? c.type_name : ''
    out.push({ name: c.name, type: type.toLowerCase() })
  }
  return out
}

/** The linked table's columns lined up with the sketch's, or null while unlinked or not loaded. */
export function useColumnDiff(node: SketchNode): { rows: ColumnRow[]; loading: boolean; error: string | null } | null {
  const linked = node.placeholder?.linked ?? null
  const profile = useUiStore((s) => s.connectedProfile)
  const detail = useObject(linked)
  if (!linked) return null
  if (profile === null) return { rows: [], loading: false, error: 'Connect to compare with the real table.' }
  if (detail.isPending) return { rows: [], loading: true, error: null }
  if (detail.isError) return { rows: [], loading: false, error: detail.error.message }
  return { rows: diffColumns(node.placeholder?.columns ?? [], realColumns(detail.data?.data)), loading: false, error: null }
}

/**
 * A table that does not exist yet. The name, and every column's name, type and key marker, are edited in place.
 * Linked to a real table, it also shows that table's columns and marks where the sketch differs.
 */
export function PlaceholderNode({ id, selected }: NodeProps<SketchFlowNode>) {
  const node = useSketchNode(id)
  if (!node || !node.placeholder) return null
  return <PlaceholderBody node={node} selected={selected} />
}

function PlaceholderBody({ node, selected }: { node: SketchNode; selected: boolean }) {
  const id = node.id
  const spec = node.placeholder!
  const locked = node.locked === true
  const updatePlaceholder = useSketchStore((s) => s.updatePlaceholder)
  const syncHeight = useSketchStore((s) => s.syncHeight)
  const diff = useColumnDiff(node)
  const rootRef = useRef<HTMLDivElement>(null)
  const updateInternals = useUpdateNodeInternals()
  const [focusRow, setFocusRow] = useState<number | null>(null)
  // A new table, or Enter or a double-click on it, puts the cursor in its name. The store flag is only the trigger.
  const editing = useSketchStore((s) => s.editingId === id)
  const setEditing = useSketchStore((s) => s.setEditing)
  useEffect(() => {
    if (!editing) return
    // React Flow keeps a new node hidden until it has measured it, and a hidden input cannot take focus,
    // so try again for a few frames.
    let tries = 0
    let frame = 0
    const attempt = () => {
      const input = rootRef.current?.querySelector<HTMLInputElement>('.ph-name')
      if (input && !input.disabled) {
        input.focus()
        if (document.activeElement === input) {
          input.select()
          setEditing(null)
          return
        }
      }
      if (++tries < 30 && input && !input.disabled) frame = requestAnimationFrame(attempt)
      else setEditing(null)
    }
    attempt()
    return () => cancelAnimationFrame(frame)
  }, [editing, setEditing])

  // The card grows with its columns. Tell the store its measured height, so align, order and export know it.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      syncHeight(id, el.offsetHeight)
      updateInternals(id)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [id, syncHeight, updateInternals])

  useEffect(() => {
    if (focusRow === null) return
    rootRef.current?.querySelector<HTMLInputElement>(`[data-row="${focusRow}"] .ph-col-name`)?.focus()
    setFocusRow(null)
  }, [focusRow])

  function setColumn(i: number, patch: Partial<PlaceholderColumn>, removeKey = false) {
    updatePlaceholder(id, (p) => ({
      ...p,
      columns: p.columns.map((c, k) => {
        if (k !== i) return c
        const next = { ...c, ...patch }
        if (removeKey) delete next.key
        return next
      }),
    }), `ph-col:${id}:${i}`)
  }

  function addColumn() {
    updatePlaceholder(id, (p) => ({ ...p, columns: [...p.columns, { name: '', type: '' }] }), `ph-add:${id}`)
    setFocusRow(spec.columns.length)
  }

  function removeColumn(i: number) {
    updatePlaceholder(id, (p) => ({ ...p, columns: p.columns.filter((_, k) => k !== i) }), `ph-del:${id}:${Date.now()}`)
  }

  const statusOf = new Map<string, ColumnRow>()
  for (const r of diff?.rows ?? []) statusOf.set(r.name.toLowerCase(), r)
  const existing = (diff?.rows ?? []).filter((r) => r.status === 'existing')
  const summary = diff ? summarize(diff.rows) : null
  const stroke = node.stroke ?? '#2563eb'

  return (
    <div
      ref={rootRef}
      className={`sk-node sk-placeholder-node${selected ? ' selected' : ''}${locked ? ' locked' : ''}`}
      style={{ borderColor: stroke }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        if (!locked && !(e.target as Element).closest('input, button')) setEditing(id)
      }}
    >
      <div className="ph-header" style={{ background: stroke }}>
        <input
          className="ph-name nodrag"
          value={spec.name}
          disabled={locked}
          aria-label="Table name"
          placeholder="table_name"
          onChange={(e) => updatePlaceholder(id, (p) => ({ ...p, name: e.target.value }), `ph-name:${id}`)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <span className="ph-badge" title="This table does not exist yet">
          {spec.linked ? 'linked' : 'new'}
        </span>
      </div>
      {spec.linked && (
        <div className="ph-linked nodrag" title={spec.linked}>
          = {spec.linked}
          {summary && !diff?.error && !diff?.loading && (
            <span className="ph-summary">
              {' '}
              {summary.new} new, {summary.type} type, {summary.existing} only in table
            </span>
          )}
          {diff?.error && <span className="ph-summary"> ({diff.error})</span>}
        </div>
      )}
      <div className="ph-cols nodrag nowheel">
        {spec.columns.map((c, i) => {
          const row = statusOf.get(c.name.trim().toLowerCase())
          const status = row?.status
          return (
            <div key={i} className={`ph-row${status ? ` st-${status}` : ''}`} data-row={i}>
              <button
                className="ph-key"
                disabled={locked}
                title="Key marker: click to cycle none, primary key, foreign key"
                aria-label={`Key marker: ${c.key ?? 'none'}`}
                onClick={() => setColumn(i, { key: NEXT_KEY[c.key ?? '']! }, NEXT_KEY[c.key ?? ''] === undefined)}
              >
                {KEY_LABEL[c.key ?? '']}
              </button>
              <input
                className="ph-col-name"
                value={c.name}
                disabled={locked}
                placeholder="column"
                aria-label="Column name"
                onChange={(e) => setColumn(i, { name: e.target.value })}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') e.currentTarget.parentElement?.querySelector<HTMLInputElement>('.ph-col-type')?.focus()
                }}
              />
              <input
                className="ph-col-type"
                value={c.type}
                disabled={locked}
                placeholder="type"
                list={`ph-types-${id}`}
                aria-label="Column type"
                onChange={(e) => setColumn(i, { type: e.target.value })}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') {
                    if (i === spec.columns.length - 1) addColumn()
                    else setFocusRow(i + 1)
                  }
                }}
              />
              {status === 'type' && row?.realType && (
                <span className="ph-mark type" title={`The table has ${row.realType}`}>
                  &ne; {row.realType}
                </span>
              )}
              {status === 'new' && (
                <span className="ph-mark new" title="Not in the real table">
                  + new
                </span>
              )}
              <button className="ph-del" disabled={locked} aria-label="Delete column" title="Delete column" onClick={() => removeColumn(i)}>
                &times;
              </button>
            </div>
          )
        })}
        {existing.map((r) => (
          <div key={`real:${r.name}`} className="ph-row st-existing" title="In the real table, not in the sketch">
            <span className="ph-key" />
            <span className="ph-col-name">{r.name}</span>
            <span className="ph-col-type">{r.realType}</span>
          </div>
        ))}
        {!locked && (
          <button className="ph-add" onClick={addColumn}>
            + column
          </button>
        )}
      </div>
      <datalist id={`ph-types-${id}`}>
        {['string', 'int', 'bigint', 'double', 'decimal(10,2)', 'boolean', 'date', 'timestamp', 'array<string>', 'struct<>', 'map<string,string>'].map(
          (t) => (
            <option key={t} value={t} />
          ),
        )}
      </datalist>
      <SideHandles />
    </div>
  )
}
