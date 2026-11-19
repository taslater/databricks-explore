// Profile a relationship: the confirm dialog (SQL first), the measured numbers in Details, the toolbar button and the edge's right-click menu.
import { useCallback, type MouseEvent as ReactMouseEvent } from 'react'
import { create } from 'zustand'
import { getProfilePlan, useProfilePlan, useRunProfile, type ProfileEdge } from '../api/relProfile'
import { openSqlInCanvas } from '../ask/canvasAction'
import { ContextMenu, wantsBrowserMenu, type MenuItem } from '../shared/ContextMenu'
import { useUiStore } from '../store/uiStore'
import { messageOf } from './actions'
import { useCardinality } from './EdgeEnds'
import { fmtTime, lastPart } from './format'
import { useGraphStore } from './graphStore'
import { orphanText, profilableEdges } from './relProfile'
import type { FlowEdge } from './types'

/** The relationships the "Profile" dialog is open for, or null when it is closed. */
export const useProfileDialog = create<{ edges: ProfileEdge[] | null; open: (edges: ProfileEdge[]) => void; close: () => void }>((set) => ({
  edges: null,
  open: (edges) => set({ edges }),
  close: () => set({ edges: null }),
}))

const n = (v: number) => v.toLocaleString('en-US')

/** The toolbar button. It profiles the reference edges between the ticked tables, or every reference edge on the graph when none is ticked. Nothing runs from here. */
export function ProfileButton() {
  const connected = useUiStore((s) => s.connectedProfile)
  const nodes = useGraphStore((s) => s.nodes)
  const edges = useGraphStore((s) => s.edges)
  const open = useProfileDialog((s) => s.open)
  const found = profilableEdges(edges, new Set(nodes.filter((x) => x.selected).map((x) => x.id)))
  return (
    <button
      style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
      onClick={() => open(found)}
      disabled={!connected || found.length === 0}
      title="Measure how the reference edges between the ticked tables behave (or all of them): orphans, repeated keys, rows per key. Shows the SQL first."
    >
      Profile relationships…
    </button>
  )
}

/** Confirm dialog: the exact statements, what is known of the table sizes, the edges skipped and why, then Run. Never automatic. */
export function ProfileDialog() {
  const edges = useProfileDialog((s) => s.edges)
  const close = useProfileDialog((s) => s.close)
  const warehouseId = useUiStore((s) => s.warehouseId)
  const plan = useProfilePlan(edges ?? [])
  const run = useRunProfile()
  if (edges === null) return null
  const p = plan.data
  async function go() {
    try {
      const out = await run.mutateAsync(edges!)
      if (Object.keys(out.errors).length === 0) close()
    } catch {
      // the error shows in the dialog
    }
  }
  const errors = Object.entries(run.data?.errors ?? {})
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={close}>
      <div className="modal mine-dialog" role="dialog" aria-modal="true" aria-label="Profile relationships" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Profile relationships</h3>
        <p className="hint">
          Runs one read-only statement per relationship through the selected SQL warehouse{p?.warehouse_id ? ` (${p.warehouse_id})` : ''}. It reads the key columns of both tables
          (a full scan of each, grouped by key), so it can be slow on large tables and can start a stopped warehouse. Only counts are kept, with the time they were
          measured; no values are stored.
        </p>
        {plan.isPending && <p className="hint">loading…</p>}
        {plan.isError && <p className="error">{plan.error.message}</p>}
        {p && (
          <>
            <p data-testid="profile-plan-count">
              {p.statements.length} relationship{p.statements.length === 1 ? '' : 's'}, one statement each.
            </p>
            {p.statements.map((s) => (
              <details key={s.id} open={p.statements.length === 1}>
                <summary>
                  {lastPart(s.source)}.({s.pairs.map(([a]) => a).join(', ')}) → {lastPart(s.target)}.({s.pairs.map(([, b]) => b).join(', ')})
                  {Object.values(s.rows).some((r) => r !== null) && (
                    <span className="hint">
                      {' '}
                      · {lastPart(s.source)} {s.rows[s.source] !== null ? `${n(s.rows[s.source]!)} rows` : 'size unknown'}, {lastPart(s.target)}{' '}
                      {s.rows[s.target] !== null ? `${n(s.rows[s.target]!)} rows` : 'size unknown'}
                    </span>
                  )}
                </summary>
                <pre className="mine-sql">{s.sql}</pre>
                <button className="link" onClick={() => openSqlInCanvas(s.sql)}>
                  Open as query (not run)
                </button>
              </details>
            ))}
            {p.skipped.length > 0 && (
              <details>
                <summary>{p.skipped.length} skipped</summary>
                <ul className="constraints">
                  {p.skipped.map((s) => (
                    <li key={s.id}>
                      {s.id}: {s.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </>
        )}
        {!warehouseId && <p className="error">Pick a SQL warehouse in the picker first.</p>}
        {run.isError && <p className="error">{messageOf(run.error)}</p>}
        {errors.length > 0 && (
          <ul className="error">
            {errors.map(([id, msg]) => (
              <li key={id}>
                {id}: {msg}
              </li>
            ))}
          </ul>
        )}
        <div className="btns">
          <button onClick={() => void go()} disabled={!warehouseId || !p || p.statements.length === 0 || run.isPending}>
            {run.isPending ? 'Profiling…' : 'Run these statements'}
          </button>
          <button onClick={close}>{errors.length > 0 ? 'Close' : 'Cancel'}</button>
        </div>
      </div>
    </div>
  )
}

/** Details of a reference edge: what was measured and when, with a button to measure (again). Nothing for other edges. */
export function ProfileDetails({ edge }: { edge: FlowEdge }) {
  const info = edge.data!.info
  const open = useProfileDialog((s) => s.open)
  const connected = useUiStore((s) => s.connectedProfile)
  const ends = useCardinality().data
  const p = (ends?.[info.id] ?? info.cardinality)?.profile
  const asked = profilableEdges([edge])
  if (asked.length === 0) return null
  const orphans = orphanText(p)
  return (
    <div className="edge-ends" data-testid="profile-details">
      <h4>Measured</h4>
      {p ? (
        <>
          <p className="hint">
            {fmtTime(p.measured_at)} on {lastPart(p.source)}.({p.pairs.map(([a]) => a).join(', ')}) → {lastPart(p.target)}.({p.pairs.map(([, b]) => b).join(', ')})
          </p>
          <table className="cols">
            <tbody>
              <tr>
                <td>{lastPart(p.source)}</td>
                <td>
                  {n(p.a_rows)} rows, {n(p.a_null_rows)} with a null key, {n(p.a_distinct_keys)} distinct keys
                </td>
              </tr>
              <tr>
                <td>{lastPart(p.target)}</td>
                <td>
                  {n(p.b_rows)} rows, {n(p.b_distinct_keys)} distinct keys, {p.b_repeated_keys === 0 ? 'none repeated' : `${n(p.b_repeated_keys)} repeated`}
                </td>
              </tr>
              <tr>
                <td>unused</td>
                <td>{n(p.unused_keys)} keys of {lastPart(p.target)} have no row in {lastPart(p.source)}</td>
              </tr>
              <tr>
                <td>per key</td>
                <td>
                  {n(p.max_fanout)} rows at most, 95% of keys have {n(p.p95_fanout)} or fewer (approx.)
                </td>
              </tr>
            </tbody>
          </table>
          {orphans ? <p className="orphan-note">{orphans}.</p> : <p className="hint">No orphans: every key in {lastPart(p.source)} has a match.</p>}
        </>
      ) : (
        <p className="hint">Not measured. The ends above come from keys and nullability.</p>
      )}
      <button onClick={() => open(asked)} disabled={!connected}>
        {p ? 'Measure again…' : 'Profile…'}
      </button>
    </div>
  )
}

// ---- the edge's right-click menu ----

interface OpenMenu {
  x: number
  y: number
  items: MenuItem[]
}

const useEdgeMenuStore = create<{ menu: OpenMenu | null; set: (m: OpenMenu | null) => void }>((set) => ({ menu: null, set: (menu) => set({ menu }) }))

/** The handler for `onEdgeContextMenu`: a menu on a reference edge, the browser's own for any other. Shift+right-click keeps the browser's. */
export function useEdgeContextMenu() {
  const open = useProfileDialog((s) => s.open)
  return useCallback(
    (e: ReactMouseEvent, edge: FlowEdge) => {
      if (wantsBrowserMenu(e) || !edge.data) return
      const asked = profilableEdges([edge])
      if (asked.length === 0) return
      e.preventDefault()
      const items: MenuItem[] = [
        { kind: 'action', label: 'Profile relationship…', run: () => open(asked) },
        {
          kind: 'action',
          label: 'Open profile as query',
          title: 'Puts the statement in a query window without running it',
          run: () =>
            void getProfilePlan(asked)
              .then((plan) => {
                const sql = plan.statements[0]?.sql
                if (sql) openSqlInCanvas(sql)
                else useGraphStore.getState().setStatus(plan.skipped[0]?.reason ?? 'nothing to profile', true)
              })
              .catch((err) => useGraphStore.getState().setStatus(messageOf(err), true)),
        },
      ]
      useEdgeMenuStore.getState().set({ x: e.clientX, y: e.clientY, items })
    },
    [open],
  )
}

/** Draws the open edge menu. Rendered once, by the Graph view. */
export function EdgeMenuHost() {
  const menu = useEdgeMenuStore((s) => s.menu)
  const close = useCallback(() => useEdgeMenuStore.getState().set(null), [])
  if (!menu) return null
  return <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={close} />
}
