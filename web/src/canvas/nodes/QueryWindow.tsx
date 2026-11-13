import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import CodeMirror from '@uiw/react-codemirror'
import { sql, type SQLConfig } from '@codemirror/lang-sql'
import { useQueryClient } from '@tanstack/react-query'
import { useCancelQuery, useQueryStatus, useSubmitQueryAsync } from '../../api/hooks'
import type { CanvasWindow, QueryBody, QueryStatus, StatementState } from '../../api/types'
import { DEFAULT_EDITOR_SPLIT, queryWindowMap, titleError, useCanvasStore } from '../../store/canvasStore'
import { useUiStore } from '../../store/uiStore'
import { ResultsGrid } from '../ResultsGrid'
import { ChartTab } from '../chart/ChartTab'
import { useSqlNamespace } from '../useSqlNamespace'
import { windowRefCompletion } from '../linking/completion'
import { remoteNameSource } from '../linking/remoteNames'

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

  // Run state. `statementId` is set once the async submit returns.
  const [statementId, setStatementId] = useState<string | null>(null)
  const [tab, setTab] = useState<'results' | 'chart'>('results')
  const submit = useSubmitQueryAsync()
  const status = useQueryStatus(statementId)
  const cancel = useCancelQuery()

  const st = status.data
  // Polling is handled by useQueryStatus (1s while PENDING or RUNNING).
  const polling = statementId !== null && !status.isError && (st === undefined || ACTIVE_STATES.has(st.state))
  const running = submit.isPending || polling
  const canRun = !running && sqlText.trim() !== ''
  const canCancel = polling && !cancel.isPending

  // Autocomplete tree from cached catalogs and objects. Recomputed when the cache fills in.
  const namespace = useSqlNamespace()
  const qc = useQueryClient()
  const profile = useUiStore((s) => s.connectedProfile)
  // Inside an open `{{` the popup shows only window titles (an override replaces the SQL sources there).
  const extensions = useMemo(() => {
    const config: SQLConfig = { schema: namespace }
    return [sql(config), windowRefCompletion(id, config, remoteNameSource(qc, profile))]
  }, [namespace, id, qc, profile])

  function run() {
    // Read the store at click time so every window's SQL is current.
    const body: QueryBody = {
      sql: sqlText,
      windows: queryWindowMap(useCanvasStore.getState().windows),
    }
    setStatementId(null)
    submit.mutate(body, { onSuccess: (res) => setStatementId(res.statement_id) })
  }

  function cancelRun() {
    if (statementId !== null) cancel.mutate(statementId)
  }

  function onEditorKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      if (canRun) run()
    }
  }

  let statusText = ''
  if (submit.isPending) statusText = 'Submitting...'
  else if (polling) statusText = `${st?.state ?? 'PENDING'}...`
  else if (st) statusText = st.state

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
            <button className="nodrag" onClick={run} disabled={!canRun}>
              Run
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
              <div className="qw-editor nowheel" onKeyDown={onEditorKeyDown}>
                <CodeMirror
                  value={sqlText}
                  extensions={extensions}
                  onChange={(v) => setSql(id, v)}
                  height="100%"
                  theme="light"
                  placeholder="SELECT ...  (Ctrl+Enter to run)"
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
  return (
    <span className="qw-summary">
      {rowCount} {rowCount === 1 ? 'row' : 'rows'}
      {truncated === true && (
        <span className="qw-badge" title="More rows exist than the row limit. Only the first rows are shown.">
          truncated
        </span>
      )}
      <span>{ms === null ? 'time n/a' : `${ms} ms`}</span>
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
  if (errorText) return <div className="error">{errorText}</div>
  if (st?.state === 'CANCELED') return <div className="hint">Canceled.</div>
  if (st?.state === 'CLOSED') return <div className="hint">Statement closed.</div>
  if (st?.state === 'SUCCEEDED') {
    if (st.columns.length === 0) return <div className="hint">Statement succeeded. No result set.</div>
    return <ResultsGrid result={st} />
  }
  if (running) return <div className="hint">Waiting for results...</div>
  return <div className="hint">Run the query to see results.</div>
}
