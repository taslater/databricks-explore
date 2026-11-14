// Run state of each query window: the statements it started, where a script has got to, and which result
// the person is looking at. It lives in memory only, outside the component, so it survives the Canvas tab
// being hidden (the view unmounts). It is not saved to the canvas file. canvasStore clears it when a window
// is deleted or a different canvas is opened.
import { create } from 'zustand'
import * as api from '../api/client'
import type { QueryBody, StatementState } from '../api/types'

export type ResultTab = 'results' | 'chart'

export interface WindowRun {
  /** Changes with every run. A late submit answer for an older run is ignored. */
  token: number
  /** The SQL of each statement of the latest run: one entry for a single statement. */
  sqls: string[]
  /** Statement id of each statement started so far, in order. Shorter than `sqls` while a script is running. */
  ids: string[]
  /** Final state of each started statement, or null while it is still running. */
  states: (StatementState | null)[]
  /** Index in `sqls` of the statement being submitted or run. */
  index: number
  /** True while a script (more than one statement) may still start its next statement. */
  scriptActive: boolean
  /** The submit call is in flight. */
  submitting: boolean
  /** Error from the submit call itself (not a failed statement). */
  submitError: string | null
  /** Set when a script stopped early, or when there was nothing to run. */
  notice: string | null
  /** When the latest run started (ms since the epoch), so the elapsed time survives a remount. */
  startedAt: number | null
  /** Statement chip the person picked, or null for the last one. */
  selected: number | null
  tab: ResultTab
}

export const IDLE_RUN: WindowRun = {
  token: 0,
  sqls: [],
  ids: [],
  states: [],
  index: 0,
  scriptActive: false,
  submitting: false,
  submitError: null,
  notice: null,
  startedAt: null,
  selected: null,
  tab: 'results',
}

interface RunStore {
  runs: Record<string, WindowRun>
  /** Starts a run of `sqls` (one or more). Returns the new token. */
  begin: (id: string, sqls: string[]) => number
  /** The submit call for the statement at `index` returned `statementId`. Ignored for a stale token. */
  submitted: (id: string, token: number, statementId: string) => void
  submitFailed: (id: string, token: number, message: string) => void
  /**
   * Records the final state of statement `index`. Returns true the first time only, so a remount does not
   * advance a script twice.
   */
  settle: (id: string, index: number, state: StatementState) => boolean
  /** Moves a script on to its next statement. */
  nextStatement: (id: string) => void
  /** Ends the script (finished, stopped by a failure, or canceled). */
  endScript: (id: string, notice?: string | null) => void
  setNotice: (id: string, notice: string | null) => void
  setSelected: (id: string, index: number | null) => void
  setTab: (id: string, tab: ResultTab) => void
  clearWindows: (ids: string[]) => void
  /** Drops the state of every window that is not in `keep`. */
  clearExcept: (keep: ReadonlySet<string>) => void
  clearAll: () => void
}

function update(runs: Record<string, WindowRun>, id: string, change: Partial<WindowRun>): Record<string, WindowRun> {
  return { ...runs, [id]: { ...(runs[id] ?? IDLE_RUN), ...change } }
}

export const useRunStore = create<RunStore>()((set, get) => ({
  runs: {},

  begin: (id, sqls) => {
    const prev = get().runs[id] ?? IDLE_RUN
    const token = prev.token + 1
    set({
      runs: update(get().runs, id, {
        token,
        sqls,
        ids: [],
        states: [],
        index: 0,
        scriptActive: sqls.length > 1,
        submitting: true,
        submitError: null,
        notice: null,
        startedAt: Date.now(),
        selected: null,
      }),
    })
    return token
  },

  submitted: (id, token, statementId) => {
    const run = get().runs[id]
    if (!run || run.token !== token) return
    set({
      runs: update(get().runs, id, {
        ids: [...run.ids, statementId],
        states: [...run.states, null],
        submitting: false,
      }),
    })
  },

  submitFailed: (id, token, message) => {
    const run = get().runs[id]
    if (!run || run.token !== token) return
    set({ runs: update(get().runs, id, { submitting: false, submitError: message, scriptActive: false }) })
  },

  settle: (id, index, state) => {
    const run = get().runs[id]
    if (!run || index >= run.states.length || run.states[index] !== null) return false
    const states = run.states.slice()
    states[index] = state
    set({ runs: update(get().runs, id, { states }) })
    return true
  },

  nextStatement: (id) => {
    const run = get().runs[id]
    if (!run) return
    set({ runs: update(get().runs, id, { index: run.index + 1, submitting: true, submitError: null }) })
  },

  endScript: (id, notice = null) => {
    if (!get().runs[id]) return
    set({ runs: update(get().runs, id, { scriptActive: false, notice }) })
  },

  setNotice: (id, notice) => {
    const run = get().runs[id]
    if (!run || run.notice === notice) return
    set({ runs: update(get().runs, id, { notice }) })
  },

  setSelected: (id, selected) => set({ runs: update(get().runs, id, { selected }) }),

  setTab: (id, tab) => set({ runs: update(get().runs, id, { tab }) }),

  clearWindows: (ids) => {
    const runs = { ...get().runs }
    let changed = false
    for (const id of ids) {
      if (id in runs) {
        delete runs[id]
        changed = true
      }
    }
    if (changed) set({ runs })
  },

  clearExcept: (keep) => {
    const stale = Object.keys(get().runs).filter((id) => !keep.has(id))
    if (stale.length > 0) get().clearWindows(stale)
  },

  clearAll: () => set({ runs: {} }),
}))

/** Submits one statement and records the answer in the store, whether or not the window is on screen. */
export function submitStatement(id: string, token: number, body: QueryBody): void {
  api
    .submitQueryAsync(body)
    .then((res) => useRunStore.getState().submitted(id, token, res.statement_id))
    .catch((err: unknown) =>
      useRunStore.getState().submitFailed(id, token, err instanceof Error ? err.message : 'Could not submit the query.'),
    )
}

/** How many statements of the latest run succeeded, and how many it had. */
export function scriptTally(run: WindowRun): { ok: number; total: number } {
  return { ok: run.states.filter((s) => s === 'SUCCEEDED').length, total: run.sqls.length }
}
