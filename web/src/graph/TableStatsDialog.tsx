import { create } from 'zustand'
import { useReadTableStats, useStatsPlan } from '../api/nodeFacts'
import { useModalBehavior } from '../shared/Dialog'
import { useUiStore } from '../store/uiStore'
import { messageOf } from './actions'
import { useGraphStore } from './graphStore'

/** The tables the "Read size and history" dialog is open for, or null when it is closed. */
export const useStatsDialog = create<{ tables: string[] | null; open: (tables: string[]) => void; close: () => void }>((set) => ({
  tables: null,
  open: (tables) => set({ tables }),
  close: () => set({ tables: null }),
}))

/**
 * The toolbar button. It reads the ticked tables, or every table on the graph when none is ticked. Nothing runs from here:
 * the dialog shows the SQL first.
 */
export function TableStatsButton() {
  const connected = useUiStore((s) => s.connectedProfile)
  const nodes = useGraphStore((s) => s.nodes)
  const open = useStatsDialog((s) => s.open)
  const readable = (n: { id: string; data: { missing?: boolean } }) => !n.id.startsWith('ph:') && !n.data.missing
  const ticked = nodes.filter((n) => n.selected && readable(n))
  const tables = (ticked.length > 0 ? ticked : nodes.filter(readable)).map((n) => n.id)
  return (
    <button
      style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
      onClick={() => open(tables)}
      disabled={!connected || tables.length === 0}
      title="Read table sizes and when each was last written, for the ticked tables or all of them. Shows the SQL first."
    >
      Size and history…
    </button>
  )
}

/** Confirm dialog for reading size and history: the exact statements, the tables skipped and why, then Run. Never automatic. */
export function TableStatsDialog() {
  const tables = useStatsDialog((s) => s.tables)
  const close = useStatsDialog((s) => s.close)
  const warehouseId = useUiStore((s) => s.warehouseId)
  const plan = useStatsPlan(tables ?? [])
  const read = useReadTableStats()
  useModalBehavior(close, tables !== null)
  if (tables === null) return null
  const p = plan.data
  const tableCount = new Set(p?.statements.map((s) => s.table)).size
  async function run() {
    try {
      const out = await read.mutateAsync(tables!)
      if (Object.keys(out.errors).length === 0) close()
    } catch {
      // the error shows in the dialog
    }
  }
  const errors = Object.entries(read.data?.errors ?? {})
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={close}>
      <div className="modal mine-dialog" role="dialog" aria-modal="true" aria-label="Read size and history" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Read size and history</h3>
        <p className="hint">
          Runs DESCRIBE DETAIL and DESCRIBE HISTORY for each table through the selected SQL warehouse
          {p?.warehouse_id ? ` (${p.warehouse_id})` : ''}. This can start a stopped warehouse. Only sizes, file counts and the log of writes are kept, with the
          time they were read; no data is read.
        </p>
        {plan.isPending && <p className="hint">loading…</p>}
        {plan.isError && <p className="error">{plan.error.message}</p>}
        {p && (
          <>
            <p data-testid="stats-plan-count">
              {tableCount} table{tableCount === 1 ? '' : 's'}, {p.statements.length} statements.
            </p>
            {p.statements.length > 0 && (
              <details open>
                <summary>The SQL</summary>
                <pre className="mine-sql">{p.statements.map((s) => s.sql + ';').join('\n')}</pre>
              </details>
            )}
            {p.skipped.length > 0 && (
              <details>
                <summary>{p.skipped.length} skipped</summary>
                <ul className="constraints">
                  {p.skipped.map((s) => (
                    <li key={s.table}>
                      {s.table}: {s.reason}
                    </li>
                  ))}
                </ul>
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
          <button onClick={close}>{errors.length > 0 ? 'Close' : 'Cancel'}</button>
        </div>
      </div>
    </div>
  )
}
