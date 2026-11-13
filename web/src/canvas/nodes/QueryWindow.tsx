import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import CodeMirror from '@uiw/react-codemirror'
import { Prec } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import { sql, type SQLConfig } from '@codemirror/lang-sql'
import { useQueryClient } from '@tanstack/react-query'
import { useCancelQuery, useQueryStatus, useSubmitQueryAsync } from '../../api/hooks'
import type { CanvasWindow, QueryBody, QueryStatus, StatementState } from '../../api/types'
import { DEFAULT_EDITOR_SPLIT, queryWindowMap, titleError, useCanvasStore } from '../../store/canvasStore'
import { useUiStore } from '../../store/uiStore'
import { ResultsGrid } from '../ResultsGrid'
import { CopyButton } from '../grid/CopyButton'
import { ChartTab } from '../chart/ChartTab'
import { useSqlNamespace } from '../useSqlNamespace'
import { windowRefCompletion } from '../linking/completion'
import { remoteNameSource } from '../linking/remoteNames'
import { flashExtension, flashRanges } from '../editor/flash'
import { planRun, type RunMode } from '../editor/statements'

export type QueryFlowNode = Node<Record<string, unknown>, 'query'>

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
  const editorSplit = win.editor_split ?? DEFAULT_EDITOR_SPLIT

  // Run state. `statementId` is the statement most recently submitted, once the async submit returns.
  const [statementId, setStatementId] = useState<string | null>(null)
  const [tab, setTab] = useState<'results' | 'chart'>('results')
  // A run of several statements: the SQL of each, and which one is running. Null for a single statement.
  const [script, setScript] = useState<{ sqls: string[]; index: number } | null>(null)
  // Set when a script stopped early, or when there was nothing to run.
  const [notice, setNotice] = useState<string | null>(null)
  const submit = useSubmitQueryAsync()
  const status = useQueryStatus(statementId)
  const cancel = useCancelQuery()
  const viewRef = useRef<EditorView | null>(null)
  const advancedFor = useRef<string | null>(null)

  const st = status.data
  // Polling is handled by useQueryStatus (1s while PENDING or RUNNING).
  const polling = statementId !== null && !status.isError && (st === undefined || ACTIVE_STATES.has(st.state))
  const running = submit.isPending || polling || script !== null
  const canRun = !running && sqlText.trim() !== ''
  const canCancel = (polling || script !== null) && !cancel.isPending && statementId !== null

  // Autocomplete tree from cached catalogs and objects. Recomputed when the cache fills in.
  const namespace = useSqlNamespace()
  const qc = useQueryClient()
  const profile = useUiStore((s) => s.connectedProfile)

  // The key bindings are built once and call whatever the latest render set here.
  const runners = useRef<Record<RunMode, () => void>>({ current: () => {}, all: () => {} })
  useEffect(() => {
    runners.current = { current: () => startRun('current'), all: () => startRun('all') }
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
  const extensions = useMemo(() => {
    const config: SQLConfig = { schema: namespace }
    return [sql(config), windowRefCompletion(id, config, remoteNameSource(qc, profile)), runKeys, flashExtension]
  }, [namespace, id, qc, profile, runKeys])

  function submitSql(statement: string) {
    // Read the store at submit time so every window's SQL is current.
    const body: QueryBody = {
      sql: statement,
      windows: queryWindowMap(useCanvasStore.getState().windows),
    }
    setStatementId(null)
    submit.mutate(body, { onSuccess: (res) => setStatementId(res.statement_id) })
  }

  /** Runs the selection or the statement under the cursor ('current'), or every statement in order ('all'). */
  function startRun(mode: RunMode) {
    if (running || sqlText.trim() === '') return
    const view = viewRef.current
    const sel = view?.state.selection.main
    const plan = planRun(view ? view.state.doc.toString() : sqlText, sel?.from ?? 0, sel?.to ?? 0, mode)
    if (plan.sqls.length === 0) {
      setNotice('Nothing to run.')
      return
    }
    setNotice(null)
    if (view) flashRanges(view, plan.ranges)
    setScript(plan.sqls.length > 1 ? { sqls: plan.sqls, index: 0 } : null)
    submitSql(plan.sqls[0])
  }

  function cancelRun() {
    // Dropping the script keeps the remaining statements from starting.
    setScript(null)
    if (statementId !== null) cancel.mutate(statementId)
  }

  // Move a script along: the next statement once this one succeeded, or stop at the first failure.
  useEffect(() => {
    if (script === null || statementId === null || st === undefined) return
    if (ACTIVE_STATES.has(st.state) || advancedFor.current === statementId) return
    advancedFor.current = statementId
    const n = script.sqls.length
    if (st.state === 'SUCCEEDED' && script.index + 1 < n) {
      setScript({ ...script, index: script.index + 1 })
      submitSql(script.sqls[script.index + 1])
      return
    }
    if (st.state !== 'SUCCEEDED') setNotice(`Statement ${script.index + 1} of ${n} did not succeed. The rest did not run.`)
    setScript(null)
    // submitSql only reads the store and uses stable mutation handles, so it is left out of the dependencies.
  }, [script, statementId, st])

  const step = script ? `Statement ${script.index + 1} of ${script.sqls.length}: ` : ''
  let statusText = ''
  if (submit.isPending) statusText = `${step}Submitting...`
  else if (polling) statusText = `${step}${st?.state ?? 'PENDING'}...`
  else if (script) statusText = `${step}Starting...`
  else if (st) statusText = st.state
  if (!running && notice) statusText = notice

  const errorText =
    (submit.isError && submit.error.message) ||
    (status.isError && status.error.message) ||
    (st?.state === 'FAILED' && (st.error ?? 'Query failed.')) ||
    null

  return (
    <div className={`qw-node${selected ? ' selected' : ''}`}>
      <NodeResizer
        isVisible={selected && !collapsed}
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
        <TitleField id={id} title={win.title} />
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
              <div className="qw-editor nowheel">
                <CodeMirror
                  value={sqlText}
                  extensions={extensions}
                  onChange={(v) => {
                    setSql(id, v)
                    setNotice(null)
                  }}
                  onCreateEditor={(view) => {
                    viewRef.current = view
                  }}
                  height="100%"
                  theme="light"
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
                    onClick={() => setTab('results')}
                  >
                    Results
                  </button>
                  <button
                    role="tab"
                    className="qw-tab"
                    aria-selected={tab === 'chart'}
                    onClick={() => setTab('chart')}
                  >
                    Chart
                  </button>
                </div>

                <div className="qw-results nowheel">
                  {tab === 'results' ? (
                    <ResultPane st={st} running={running} errorText={errorText} />
                  ) : (
                    <ChartTab windowId={id} result={st?.state === 'SUCCEEDED' ? st : null} />
                  )}
                </div>
              </div>
            </Panel>
          </Group>
        </div>
      )}
    </div>
  )
}

/** Inline-editable title. Titles must be unique on the canvas and cannot contain braces. */
function TitleField({ id, title }: { id: string; title: string }) {
  const windows = useCanvasStore((s) => s.windows)
  const renameWindow = useCanvasStore((s) => s.renameWindow)
  const [draft, setDraft] = useState(title)

  // Follow the store when the title changes from somewhere else (for example a canvas load).
  useEffect(() => setDraft(title), [title])

  const error = titleError(draft.trim(), windows, id)

  return (
    <div className="qw-title">
      <input
        className="qw-title-input nodrag"
        value={draft}
        aria-label="Window title"
        aria-invalid={error !== null}
        onChange={(e) => setDraft(e.target.value)}
        // Commit on blur. Enter blurs, so it goes through the same path.
        onBlur={() => renameWindow(id, draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          // Escape reverts the draft. It does not blur, so the revert is not committed.
          if (e.key === 'Escape') setDraft(title)
        }}
      />
      {error !== null && <div className="error qw-error">{error}</div>}
    </div>
  )
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

function ResultPane({
  st,
  running,
  errorText,
}: {
  st: QueryStatus | undefined
  running: boolean
  errorText: string | null
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
  if (st?.state === 'SUCCEEDED') {
    if (st.columns.length === 0) return <div className="hint">Statement succeeded. No result set.</div>
    return <ResultsGrid result={st} />
  }
  if (running) return <div className="hint">Waiting for results...</div>
  return <div className="hint">Run the query to see results.</div>
}
