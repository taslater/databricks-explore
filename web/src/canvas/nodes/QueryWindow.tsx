import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SideHandles } from '../../sketch/nodes/SideHandles'
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import CodeMirror from '@uiw/react-codemirror'
import { Prec } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import { sql, type SQLConfig } from '@codemirror/lang-sql'
import { cmTheme } from '../editor/cmTheme'
import { useTheme } from '../../theme'
import { useQueryClient } from '@tanstack/react-query'
import { useCancelQuery, useQueryStatus } from '../../api/hooks'
import type { CanvasWindow, QueryBody, QueryResult, QueryStatus, StatementState } from '../../api/types'
import { DEFAULT_EDITOR_SPLIT, queryWindowMap, useCanvasStore } from '../../store/canvasStore'
import { useUiStore } from '../../store/uiStore'
import { WindowTitle } from './WindowTitle'
import { ResultsGrid } from '../ResultsGrid'
import { CopyButton } from '../grid/CopyButton'
import { ChartTab } from '../chart/ChartTab'
import { useSqlNamespace } from '../useSqlNamespace'
import { windowRefCompletion } from '../linking/completion'
import { remoteNameSource } from '../linking/remoteNames'
import { flashExtension, flashRanges } from '../editor/flash'
import { focusFromBlank } from '../editor/focus'
import { planRun, type RunMode } from '../editor/statements'
import { useEditorMenu } from '../editor/useEditorMenu'
import './statementChips.css'
import { IDLE_RUN, scriptTally, submitStatement, useRunStore, type WindowRun } from '../runState'
import { buildSnapshot, firstSave, snapshotLine, snapshotResult, statementsOf } from '../snapshot'
import { useSnapshotFreshness } from '../useSnapshotFreshness'

export type QueryFlowNode = Node<Record<string, unknown>, 'query'>

/** Gap between this window and a query window opened beside it from the results. */
const WINDOW_GAP = 40

const ACTIVE_STATES: ReadonlySet<StatementState> = new Set(['PENDING', 'RUNNING'])

/**
 * React Flow node for one query window. Reads its window from the canvas store by id.
 * Each instance owns its own mutation and status query, so windows run independently.
 */
export function QueryWindow({ id, selected }: NodeProps<QueryFlowNode>) {
  const win = useCanvasStore((s) => s.windows.find((w) => w.id === id))
  if (!win) return null
  return <QueryWindowBody win={win} selected={selected} />
}

function QueryWindowBody({ win, selected }: { win: CanvasWindow; selected: boolean }) {
  const id = win.id
  const collapsed = win.collapsed ?? false
  const sqlText = win.sql ?? ''
  const setSql = useCanvasStore((s) => s.setSql)
  const setCollapsed = useCanvasStore((s) => s.setCollapsed)
  const removeWindow = useCanvasStore((s) => s.removeWindow)
  const resizeWindow = useCanvasStore((s) => s.resizeWindow)
  const setEditorSplit = useCanvasStore((s) => s.setEditorSplit)
  const setResult = useCanvasStore((s) => s.setResult)
  const setView = useCanvasStore((s) => s.setView)
  const maximized = useCanvasStore((s) => s.maximizedId === win.id)
  const setMaximized = useCanvasStore((s) => s.setMaximized)
  const editorSplit = win.editor_split ?? DEFAULT_EDITOR_SPLIT

  // Run state lives in a store keyed by window id, not here: this view unmounts when another tab is shown,
  // and a query started before that must still be there (and still be advancing) when the tab comes back.
  const run = useRunStore((s) => s.runs[id] ?? IDLE_RUN)
  const begin = useRunStore((s) => s.begin)
  const settle = useRunStore((s) => s.settle)
  const nextStatement = useRunStore((s) => s.nextStatement)
  const endScript = useRunStore((s) => s.endScript)
  const setNotice = useRunStore((s) => s.setNotice)
  const setSelected = useRunStore((s) => s.setSelected)
  // The tab is saved with the window, so a chart window opens on its chart.
  const tab = win.view ?? 'results'
  const setTab = (_id: string, next: 'results' | 'chart') => setView(id, next)
  const lastIndex = run.ids.length - 1
  const latestId = run.ids[lastIndex] ?? null
  // The statement whose result is shown: the chip picked, or the last one started.
  const viewIndex = run.selected !== null && run.selected <= lastIndex ? run.selected : lastIndex
  const viewId = run.ids[viewIndex] ?? null
  const latest = useQueryStatus(latestId)
  const status = useQueryStatus(viewId)
  const cancel = useCancelQuery()
  const viewRef = useRef<EditorView | null>(null)

  const st = status.data
  const latestSt = latest.data
  // Polling is handled by useQueryStatus (1s while PENDING or RUNNING).
  const polling = latestId !== null && !latest.isError && (latestSt === undefined || ACTIVE_STATES.has(latestSt.state))
  const running = run.submitting || polling || run.scriptActive
  const canRun = !running && sqlText.trim() !== ''
  const canCancel = (polling || run.scriptActive) && !run.submitting && !cancel.isPending && latestId !== null

  // Autocomplete tree from cached catalogs and objects. Recomputed when the cache fills in.
  const namespace = useSqlNamespace()
  const qc = useQueryClient()
  const profile = useUiStore((s) => s.connectedProfile)

  // The key bindings are built once and call whatever the latest render set here.
  const runners = useRef<Record<RunMode, () => void>>({ current: () => {}, all: () => {} })
  useEffect(() => {
    runners.current = { current: () => startRun('current'), all: () => startRun('all') }
  })
  const editorMenu = useEditorMenu({
    viewRef,
    run: (mode) => runners.current[mode](),
    canRun,
    say: (text) => setNotice(id, text),
  })
  // Mod-Enter must beat the default keymap, where it inserts a blank line.
  const runKeys = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          { key: 'Mod-Enter', run: () => (runners.current.current(), true) },
          { key: 'Shift-Mod-Enter', run: () => (runners.current.all(), true) },
        ]),
      ),
    [],
  )

  // Inside an open `{{` the popup shows only window titles (an override replaces the SQL sources there).
  const { theme } = useTheme()
  const extensions = useMemo(() => {
    const config: SQLConfig = { schema: namespace }
    return [sql(config), windowRefCompletion(id, config, remoteNameSource(qc, profile)), runKeys, flashExtension, cmTheme(theme === 'dark')]
  }, [namespace, id, qc, profile, runKeys, theme])

  function submitSql(statement: string, token: number) {
    // Read the store at submit time so every window's SQL is current.
    const body: QueryBody = {
      sql: statement,
      windows: queryWindowMap(useCanvasStore.getState().windows),
    }
    submitStatement(id, token, body)
  }

  /** Runs the selection or the statement under the cursor ('current'), or every statement in order ('all'). */
  function startRun(mode: RunMode) {
    if (running || sqlText.trim() === '') return
    const view = viewRef.current
    const sel = view?.state.selection.main
    const plan = planRun(view ? view.state.doc.toString() : sqlText, sel?.from ?? 0, sel?.to ?? 0, mode)
    if (plan.sqls.length === 0) {
      setNotice(id, 'Nothing to run.')
      return
    }
    if (view) flashRanges(view, plan.ranges)
    const token = begin(id, plan.sqls)
    submitSql(plan.sqls[0], token)
  }

  function cancelRun() {
    // Ending the script keeps the remaining statements from starting.
    endScript(id)
    if (latestId !== null) cancel.mutate(latestId)
  }

  // Move a script along: the next statement once this one succeeded, or stop at the first failure.
  // This also runs when the window mounts again, so a script that was under way carries on. `settle` is true
  // only the first time a statement's final state is seen, so nothing advances twice.
  useEffect(() => {
    if (latestId === null) return
    if (latest.isError && run.scriptActive) {
      endScript(id, `Lost track of statement ${lastIndex + 1} of ${run.sqls.length}. The rest did not run.`)
      return
    }
    if (latestSt === undefined || ACTIVE_STATES.has(latestSt.state)) return
    if (!settle(id, lastIndex, latestSt.state) || !run.scriptActive) return
    const n = run.sqls.length
    if (latestSt.state === 'SUCCEEDED' && lastIndex + 1 < n) {
      nextStatement(id)
      submitSql(run.sqls[lastIndex + 1], run.token)
      return
    }
    if (latestSt.state === 'SUCCEEDED') {
      endScript(id)
      return
    }
    const { ok } = scriptTally(useRunStore.getState().runs[id] ?? run)
    endScript(id, `${ok} of ${n} statements succeeded. Statement ${lastIndex + 1} did not, and the rest did not run.`)
    // submitSql only reads the store, and the store actions are stable, so they are left out of the dependencies.
  }, [latestId, latestSt, latest.isError, run])

  const elapsed = useElapsed(running, run.startedAt)
  const scripted = run.sqls.length > 1
  const step = scripted && run.scriptActive ? `Statement ${run.index + 1} of ${run.sqls.length}: ` : ''
  let statusText = ''
  if (run.submitting) statusText = `${step}Submitting...`
  else if (polling) statusText = `${step}${latestSt?.state ?? 'PENDING'}...`
  else if (run.scriptActive) statusText = `${step}Starting...`
  else if (scripted && run.ids.length > 0 && !run.notice) {
    const { ok, total } = scriptTally(run)
    statusText = `${ok} of ${total} statements succeeded`
  } else if (st) statusText = st.state
  if (running && elapsed !== null) statusText += ` ${formatElapsed(elapsed)}`
  if (!running && run.notice) statusText = run.notice

  // A submit that failed belongs to the statement after the last one started, so it shows with the last one.
  const errorText =
    (run.submitError !== null && run.selected === null && run.submitError) ||
    (status.isError && status.error.message) ||
    (st?.state === 'FAILED' && (st.error ?? 'Query failed.')) ||
    null

  // A successful statement that returned a result set becomes the window's saved result (once per statement).
  useEffect(() => {
    if (latestId === null || latestSt?.state !== 'SUCCEEDED' || latestSt.columns.length === 0) return
    const hash = run.hashes[lastIndex]
    if (!hash || !firstSave(latestId)) return
    setResult(id, buildSnapshot(latestSt, hash))
  }, [latestId, latestSt, run.hashes, lastIndex, id, setResult])

  // What the results and chart tabs show: this session's run when it succeeded, else the saved result. The saved one
  // also stays up while a new run is on its way, so a refresh does not blank the window.
  const liveResult = st?.state === 'SUCCEEDED' && st.columns.length > 0 ? st : null
  const saved = win.result ?? null
  const fresh = useSnapshotFreshness(win)
  const useSaved = saved !== null && !errorText && (st === undefined || ACTIVE_STATES.has(st.state))
  const savedResult = useMemo(() => (useSaved && saved !== null ? snapshotResult(saved) : null), [useSaved, saved])
  const shownResult: QueryResult | null = liveResult ?? savedResult
  const savedNote = useSaved && saved !== null ? snapshotLine(saved, fresh) : null

  // The one statement behind the shown result, for "Value counts in new query window": the statement this session
  // ran, or (for a saved result) the window's SQL when it is a single statement. Unknown for a script's saved result.
  const ownStatements = statementsOf(sqlText)
  const sourceSql = liveResult !== null ? (run.sqls[viewIndex] ?? null) : ownStatements.length === 1 ? ownStatements[0] : null
  const addQueryWindowWithSql = useCanvasStore((s) => s.addQueryWindowWithSql)
  const openQuery = (newSql: string) =>
    addQueryWindowWithSql({ x: win.position.x + win.size.w + WINDOW_GAP, y: win.position.y }, newSql)

  return (
    <>
      <div className={`qw-node${selected ? ' selected' : ''}`} data-surface="raised">
        <NodeResizer
          isVisible={selected && !collapsed && !maximized}
          minWidth={360}
          minHeight={220}
          onResize={(_, p) => resizeWindow(id, { x: p.x, y: p.y }, { w: p.width, h: p.height })}
        />

        <div className="qw-header">
          {/* Drag grip: not nodrag, so the full header height is a handle for moving the window. */}
          <span className="qw-grip" aria-hidden="true">
            ⋮⋮
          </span>
          <button
            className="qw-icon nodrag"
            onClick={() => setCollapsed(id, !collapsed)}
            aria-label={collapsed ? 'Expand window' : 'Collapse window'}
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? '▸' : '▾'}
          </button>
          <WindowTitle id={id} title={win.title} />
          <button
            className="qw-icon nodrag"
            onClick={() => setMaximized(maximized ? null : id)}
            aria-label={maximized ? 'Restore window size' : 'Maximize window'}
            aria-pressed={maximized}
            title={maximized ? 'Restore size' : 'Maximize to fill the canvas'}
          >
            {maximized ? '⤡' : '⤢'}
          </button>
          <button
            className="qw-icon nodrag"
            onClick={() => removeWindow(id)}
            aria-label="Delete window"
            title="Delete window"
          >
            ✕
          </button>
        </div>

        {!collapsed && (
          <div className="qw-body">
            {/* The toolbar's blank space drags the window. The buttons stay nodrag so they still click. */}
            <div className="qw-toolbar">
              <button
                className="nodrag"
                onClick={() => startRun('current')}
                disabled={!canRun}
                title="Run the selection, or the statement at the cursor (Cmd/Ctrl+Enter)"
              >
                Run
              </button>
              <button
                className="nodrag"
                onClick={() => startRun('all')}
                disabled={!canRun}
                title="Run every statement in order; stops at the first error (Shift+Cmd/Ctrl+Enter)"
              >
                Run all
              </button>
              <button className="nodrag" onClick={cancelRun} disabled={!canCancel}>
                Cancel
              </button>
              <span className="hint">{statusText}</span>
              {st?.state === 'SUCCEEDED' && <Summary rowCount={st.row_count} truncated={st.truncated} ms={st.ms} />}
            </div>

            {/* Editor on top, Results | Chart below. The splitter's position is saved as a percent. */}
            <Group
              orientation="vertical"
              className="qw-split nodrag"
              defaultLayout={{ editor: editorSplit, results: 100 - editorSplit }}
              onLayoutChanged={(layout, meta) => {
                // Only a drag by the user is saved. The library also reports the initial layout.
                if (meta.isUserInteraction && layout.editor !== undefined) setEditorSplit(id, layout.editor)
              }}
            >
              <Panel id="editor" minSize="90px">
                <div
                  className="qw-editor nowheel"
                  onMouseDown={(e) => focusFromBlank(e, viewRef.current)}
                  onContextMenu={editorMenu.onContextMenu}
                >
                  <CodeMirror
                    className="qw-cm"
                    value={sqlText}
                    extensions={extensions}
                    onChange={(v) => {
                      setSql(id, v)
                      setNotice(id, null)
                    }}
                    onCreateEditor={(view) => {
                      viewRef.current = view
                    }}
                    height="100%"
                    theme="none"
                    placeholder="SELECT ...  (Cmd/Ctrl+Enter runs the statement or selection)"
                  />
                </div>
              </Panel>

              <Separator className="qw-splitter" />

              <Panel id="results" minSize="120px">
                <div className="qw-results-pane">
                  <div className="qw-tabs" role="tablist">
                    <button
                      role="tab"
                      className="qw-tab"
                      aria-selected={tab === 'results'}
                      onClick={() => setTab(id, 'results')}
                    >
                      Results
                    </button>
                    <button
                      role="tab"
                      className="qw-tab"
                      aria-selected={tab === 'chart'}
                      onClick={() => setTab(id, 'chart')}
                    >
                      Chart
                    </button>
                  </div>

                  <StatementChips run={run} viewIndex={viewIndex} onPick={(i) => setSelected(id, i)} />

                  {savedNote !== null && (
                    <div className={`qw-saved-note nodrag${fresh === 'stale' ? ' stale' : ''}`} role="status">
                      {fresh === 'stale' && <span className="qw-badge">stale</span>}
                      <span>{running ? 'Refreshing. ' : ''}{savedNote}</span>
                    </div>
                  )}

                  <div className="qw-results nowheel">
                    {tab === 'results' ? (
                      <ResultPane st={st} shown={shownResult} running={running} errorText={errorText} sourceSql={sourceSql} onOpenQuery={openQuery} />
                    ) : (
                      <ChartTab windowId={id} result={shownResult} />
                    )}
                  </div>
                </div>
              </Panel>
            </Group>
            {editorMenu.menu}
          </div>
        )}
      </div>
      <SideHandles />
    </>
  )
}

/** Milliseconds since the run started (`since`), refreshed several times a second. Null when not active. */
function useElapsed(active: boolean, since: number | null): number | null {
  const [elapsed, setElapsed] = useState<number | null>(null)
  useEffect(() => {
    if (!active) {
      setElapsed(null)
      return
    }
    // The run's own start time, so a window that mounts mid-run does not start counting from zero.
    const t0 = since ?? Date.now()
    setElapsed(Date.now() - t0)
    const timer = window.setInterval(() => setElapsed(Date.now() - t0), 200)
    return () => window.clearInterval(timer)
  }, [active, since])
  return elapsed
}

/** 0.0 s under a minute, then 1m 05s. */
function formatElapsed(ms: number): string {
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} s`
  return `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, '0')}s`
}

function Summary({ rowCount, truncated, ms }: { rowCount: number; truncated: boolean | null; ms: number | null }) {
  const text = `${rowCount} ${rowCount === 1 ? 'row' : 'rows'}${truncated === true ? ' (truncated)' : ''}, ${
    ms === null ? 'time n/a' : `${ms} ms`
  }`
  return (
    <span className="qw-summary nodrag">
      {rowCount} {rowCount === 1 ? 'row' : 'rows'}
      {truncated === true && (
        <span className="qw-badge" title="More rows exist than the row limit. Only the first rows are shown.">
          truncated
        </span>
      )}
      <span>{ms === null ? 'time n/a' : `${ms} ms`}</span>
      <CopyButton text={text} />
    </span>
  )
}

/** One chip per statement of a script ("1 2 3"), to switch between their results. Nothing for one statement. */
function StatementChips({ run, viewIndex, onPick }: { run: WindowRun; viewIndex: number; onPick: (i: number) => void }) {
  if (run.sqls.length < 2) return null
  return (
    <div className="qw-chips nodrag" role="group" aria-label="Statement results">
      {run.sqls.map((sqlText, i) => {
        const state = run.states[i] ?? null
        const started = i < run.ids.length
        const bad = state !== null && state !== 'SUCCEEDED'
        return (
          <button
            key={i}
            className={`qw-chip${i === viewIndex ? ' active' : ''}${bad ? ' bad' : ''}`}
            disabled={!started}
            aria-pressed={i === viewIndex}
            title={`Statement ${i + 1}${state ? `, ${state}` : started ? ', running' : ', not started'}: ${sqlText.trim().slice(0, 200)}`}
            onClick={() => onPick(i)}
          >
            {i + 1}
          </button>
        )
      })}
    </div>
  )
}

function ResultPane({
  st,
  shown,
  running,
  errorText,
  sourceSql,
  onOpenQuery,
}: {
  st: QueryStatus | undefined
  /** The result to show: this session's, or the window's saved one. */
  shown: QueryResult | null
  running: boolean
  errorText: string | null
  /** The statement that produced `shown`, when known. */
  sourceSql: string | null
  onOpenQuery: (sql: string) => void
}): ReactNode {
  if (errorText) {
    return (
      <div className="error nodrag">
        <span className="qw-errtext">{errorText}</span>
        <CopyButton text={errorText} />
      </div>
    )
  }
  if (st?.state === 'CANCELED') return <div className="hint">Canceled.</div>
  if (st?.state === 'CLOSED') return <div className="hint">Statement closed.</div>
  if (shown !== null) return <ResultsGrid result={shown} sourceSql={sourceSql} onOpenQuery={onOpenQuery} />
  if (st?.state === 'SUCCEEDED') return <div className="hint">Statement succeeded. No result set.</div>
  if (running) return <div className="hint">Waiting for results...</div>
  return <div className="hint">Run the query to see results.</div>
}
