// "Run all windows": runs every query window of the canvas, a window that references another through {{title}}
// after it. The order is planned here (pure), and the runner starts windows through the same run store and submit
// path as the Run button of one window. The statements of a window that has several are advanced by its own
// component, as for a single run, so the Canvas has to stay on screen until the batch is done.
import { create } from 'zustand'
import * as api from '../api/client'
import type { CanvasWindow } from '../api/types'
import { queryWindowMap, useCanvasStore } from '../store/canvasStore'
import { planRun } from './editor/statements'
import { IDLE_RUN, runningIds, submitStatement, useRunStore, type WindowRun } from './runState'

/** At most this many windows run on the warehouse at once. */
export const MAX_PARALLEL = 4

const REF_PATTERN = /\{\{([^{}]*)\}\}/g

export interface RunPlan {
  /** Ids of the windows to run, in dependency order (a window after every window it references). */
  order: string[]
  /** For each id in `order`, the ids it waits for (windows it references that are also in the plan). */
  waitsFor: Record<string, string[]>
  /** Query windows left out: empty SQL, or part of a reference cycle (or waiting on one). */
  skipped: { id: string; title: string; reason: 'empty' | 'cycle' }[]
}

/**
 * Orders the query windows for a run of all of them. A window comes after the windows its SQL references, windows
 * with nothing between them keep their order on the canvas, and members of a reference cycle (and anything that
 * waits on one) are skipped, because they have no order.
 */
export function planWindowRuns(windows: CanvasWindow[]): RunPlan {
  const skipped: RunPlan['skipped'] = []
  const runnable = windows.filter((w) => {
    if (w.type !== 'query') return false
    if ((w.sql ?? '').trim() !== '') return true
    skipped.push({ id: w.id, title: w.title, reason: 'empty' })
    return false
  })
  const byTitle = new Map(runnable.map((w) => [w.title, w]))
  const needs = new Map<string, Set<string>>()
  for (const w of runnable) {
    const deps = new Set<string>()
    for (const m of (w.sql ?? '').matchAll(REF_PATTERN)) {
      const dep = byTitle.get(m[1].trim())
      if (dep !== undefined) deps.add(dep.id) // a window that names itself waits for itself: a cycle
    }
    needs.set(w.id, deps)
  }
  const order: string[] = []
  const done = new Set<string>()
  for (let progressed = true; progressed; ) {
    progressed = false
    for (const w of runnable) {
      if (done.has(w.id) || ![...(needs.get(w.id) ?? [])].every((d) => done.has(d))) continue
      done.add(w.id)
      order.push(w.id)
      progressed = true
    }
  }
  for (const w of runnable) if (!done.has(w.id)) skipped.push({ id: w.id, title: w.title, reason: 'cycle' })
  const waitsFor: Record<string, string[]> = {}
  for (const id of order) waitsFor[id] = [...(needs.get(id) ?? [])]
  return { order, waitsFor, skipped }
}

/** True once a run has nothing left to start or wait for: every statement it started has a final state. */
export function runFinished(run: WindowRun, token: number): boolean {
  if (run.token !== token) return true // another run took the window over
  if (run.submitting || run.scriptActive) return false
  return run.states.every((s) => s !== null)
}

/** True when every statement of a finished run succeeded. */
export function runSucceeded(run: WindowRun): boolean {
  return run.submitError === null && run.ids.length === run.sqls.length && run.states.every((s) => s === 'SUCCEEDED')
}

export interface BatchState {
  active: boolean
  total: number
  finished: number
  /** What the last batch did, in one line. Null before the first batch. */
  summary: string | null
}

export const useBatchStore = create<BatchState>()(() => ({ active: false, total: 0, finished: 0, summary: null }))

interface Batch {
  plan: RunPlan
  canvasName: string | null
  /** Window id to the token of the run this batch started (or found already under way). */
  started: Map<string, number>
  done: Set<string>
  failed: Set<string>
  unsubscribe: () => void
}

let current: Batch | null = null
let advancing = false
let again = false

function tally(batch: Batch): string {
  const ran = batch.done.size
  const bits = [`Ran ${ran} ${ran === 1 ? 'window' : 'windows'}`]
  if (batch.failed.size > 0) bits.push(`${batch.failed.size} failed`)
  const cycle = batch.plan.skipped.filter((s) => s.reason === 'cycle').map((s) => s.title)
  const empty = batch.plan.skipped.filter((s) => s.reason === 'empty').length
  if (cycle.length > 0) bits.push(`skipped ${cycle.join(', ')} (reference cycle)`)
  if (empty > 0) bits.push(`${empty} without SQL skipped`)
  return bits.join('; ')
}

function startWindow(batch: Batch, id: string): void {
  const store = useRunStore.getState()
  const existing = store.runs[id] ?? IDLE_RUN
  if (existing.submitting || existing.scriptActive || runningIds(existing).length > 0) {
    batch.started.set(id, existing.token) // already running (the person pressed its Run): wait for that run
    return
  }
  const win = useCanvasStore.getState().windows.find((w) => w.id === id)
  const sqls = planRun(win?.sql ?? '', 0, 0, 'all').sqls
  if (sqls.length === 0) {
    batch.done.add(id)
    return
  }
  const token = store.begin(id, sqls)
  batch.started.set(id, token)
  submitStatement(id, token, { sql: sqls[0], windows: queryWindowMap(useCanvasStore.getState().windows) })
}

function end(batch: Batch, summary: string): void {
  batch.unsubscribe()
  current = null
  useBatchStore.setState({ active: false, total: batch.plan.order.length, finished: batch.done.size, summary })
}

/** Starts what can start, notes what finished, and ends the batch when nothing is left. */
function step(batch: Batch): void {
  const canvas = useCanvasStore.getState()
  if (canvas.canvasName !== batch.canvasName) return end(batch, `Stopped after ${batch.done.size} of ${batch.plan.order.length} windows: another canvas was opened`)
  const runs = useRunStore.getState().runs
  for (const [id, token] of batch.started) {
    if (batch.done.has(id)) continue
    const run = runs[id]
    if (run === undefined) {
      // Its run state was dropped: the window was deleted, or another canvas was opened under the same ids.
      if (canvas.windows.some((w) => w.id === id)) return end(batch, `Stopped after ${batch.done.size} of ${batch.plan.order.length} windows: the canvas changed`)
      batch.done.add(id)
      batch.failed.add(id)
    } else if (runFinished(run, token)) {
      batch.done.add(id)
      if (!runSucceeded(run)) batch.failed.add(id)
    }
  }
  let running = [...batch.started.keys()].filter((id) => !batch.done.has(id)).length
  for (const id of batch.plan.order) {
    if (running >= MAX_PARALLEL) break
    if (batch.started.has(id) || batch.done.has(id)) continue
    if (!batch.plan.waitsFor[id].every((d) => batch.done.has(d))) continue
    startWindow(batch, id)
    if (!batch.done.has(id)) running++
  }
  const total = batch.plan.order.length
  if (batch.done.size >= total) end(batch, tally(batch))
  else if (useBatchStore.getState().finished !== batch.done.size) useBatchStore.setState({ finished: batch.done.size })
}

/** Runs `step`, once at a time: starting a window changes the run store, which asks for another step. */
function advance(batch: Batch): void {
  if (advancing) {
    again = true
    return
  }
  advancing = true
  try {
    do {
      again = false
      step(batch)
    } while (again && current === batch)
  } finally {
    advancing = false
  }
}

/** Runs every query window, dependencies first. Does nothing while a batch is already running. */
export function runAllWindows(): void {
  if (current !== null) return
  const canvas = useCanvasStore.getState()
  const plan = planWindowRuns(canvas.windows)
  if (plan.order.length === 0) {
    const text = plan.skipped.length > 0 ? 'No query window has SQL to run.' : 'No query windows to run.'
    useBatchStore.setState({ active: false, total: 0, finished: 0, summary: text })
    return
  }
  const batch: Batch = { plan, canvasName: canvas.canvasName, started: new Map(), done: new Set(), failed: new Set(), unsubscribe: () => undefined }
  current = batch
  useBatchStore.setState({ active: true, total: plan.order.length, finished: 0, summary: null })
  // Every change to a window's run state (a statement settling, a script moving on) may free the next window.
  batch.unsubscribe = useRunStore.subscribe(() => advance(batch))
  advance(batch)
}

/** Stops the batch: nothing more is started, and the statements still running are canceled on the warehouse. */
export function stopRunAll(): void {
  const batch = current
  if (batch === null) return
  const store = useRunStore.getState()
  end(batch, `Stopped after ${batch.done.size} of ${batch.plan.order.length} windows`)
  for (const id of batch.started.keys()) {
    const run = store.runs[id]
    if (!run || batch.done.has(id)) continue
    store.endScript(id, 'Canceled.') // keeps the rest of a script from starting
    for (const sid of runningIds(run)) api.cancelQuery(sid).catch(() => undefined)
  }
}
