import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgGridReact } from 'ag-grid-react'
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type CellContextMenuEvent,
  type CellDoubleClickedEvent,
  type ColDef,
  type FirstDataRenderedEvent,
  type GridApi,
  type GridReadyEvent,
} from 'ag-grid-community'
import type { QueryResult } from '../api/types'
import { MAX_AUTO_WIDTH, buildColumnDefs, columnKind, columnTypeName, type Cell, type ColumnKind, type Row } from './grid/columns'
import { writeClipboard } from './grid/clipboard'
import { CopyMenu, type MenuItem } from './grid/CopyMenu'
import { CellViewer } from './grid/CellViewer'
import { GridUiContext } from './grid/ColumnLabel'
import { GUTTER_ID, useGridSelection } from './grid/useGridSelection'
import { valueCountsSql, valueFilterModel, whereEquals, type ValueFilterMode } from './grid/actions'
import {
  COPY_FORMAT_LABELS,
  cellText,
  columnText,
  formatTable,
  rowText,
  type CopyFormat,
  type CopyTable,
} from './grid/copy'
import { cellCount, copyPlan, describePlan, forEachCell, touchedColumns, type CopyPlan } from './grid/selection'
import { computeStats, formatStat, type SelectionStats } from './grid/stats'

// Community modules only. Do not register any Enterprise module here: cell range selection is Enterprise,
// so the selection is built in grid/selection.ts and grid/useGridSelection.ts.
ModuleRegistry.registerModules([AllCommunityModule])

// Quartz's default border colour is ~#dcdddd (15% ink on white), which is too faint.
// #c5c6c7 is ~25% ink on white: a clearly visible neutral gray, not black.
// Quartz also draws no vertical column lines by default (columnBorder is transparent),
// so columnBorder is set explicitly to the same colour.
const GRID_LINE_COLOR = '#c5c6c7'
const resultsTheme = themeQuartz.withParams({
  borderColor: GRID_LINE_COLOR,
  columnBorder: { style: 'solid', width: 1, color: GRID_LINE_COLOR },
  // Compact rows: Quartz defaults are 42px rows and 48px headers. The header has two lines: name and type.
  rowHeight: 24,
  headerHeight: 40,
})

// Everything passed to AgGridReact below is a module constant or memoized. A prop that is a new object on
// every render makes the grid re-apply it and can loop (React error #185). Keep it that way.
// Columns are not movable: a drag across headers selects columns, and a header drag would move one instead.
const DEFAULT_COL_DEF: ColDef<Row> = { sortable: true, filter: true, resizable: true, minWidth: 80, suppressMovable: true }

/** The row-number column: pinned, narrow, no sort or filter. Row numbers are the display order, 1 to n. */
function gutterColumn(rowCount: number, cellClassRules: ColDef<Row>['cellClassRules']): ColDef<Row> {
  const width = Math.max(40, 20 + 8 * String(Math.max(1, rowCount)).length)
  return {
    colId: GUTTER_ID,
    headerName: '',
    width,
    minWidth: width,
    maxWidth: width,
    pinned: 'left',
    lockPosition: 'left',
    lockPinned: true,
    suppressMovable: true,
    suppressAutoSize: true,
    suppressHeaderMenuButton: true,
    sortable: false,
    filter: false,
    resizable: false,
    valueGetter: (p) => (p.node?.rowIndex === null || p.node?.rowIndex === undefined ? null : String(p.node.rowIndex + 1)),
    cellClass: 'qw-gutter',
    cellClassRules,
    headerClass: 'qw-gutter-head',
  }
}

/** Fit every column to its content, then cap the width so one long text column cannot fill the window. */
function autosize(e: FirstDataRenderedEvent<Row>) {
  e.api.autoSizeAllColumns()
  const capped = e.api
    .getColumnState()
    .filter((c) => (c.width ?? 0) > MAX_AUTO_WIDTH && /^c\d+$/.test(c.colId))
    .map((c) => ({ key: c.colId, newWidth: MAX_AUTO_WIDTH }))
  if (capped.length) e.api.setColumnWidths(capped)
}

// ---- Reading rows out of the grid ------------------------------------------------------------------

const DATA_COLUMN = /^c\d+$/

/** Indexes (into result.columns) of the data columns in the order they are shown. The row-number column is skipped. */
function shownColumns(api: GridApi<Row>): number[] {
  return api
    .getAllDisplayedColumns()
    .map((c) => c.getColId())
    .filter((id) => DATA_COLUMN.test(id))
    .map((id) => Number(id.slice(1)))
}

/** The rows shown after filters and sort, as the shown columns. */
function readAll(api: GridApi<Row>, result: QueryResult): CopyTable {
  const cols = shownColumns(api)
  const rows: Cell[][] = []
  api.forEachNodeAfterFilterAndSort((node) => rows.push(cols.map((i) => node.data?.[`c${i}`] ?? null)))
  return { columns: cols.map((i) => result.columns[i]), rows }
}

/** The cells a copy plan covers: its rows (by display position) and columns (by position among the shown columns). */
function readPlan(api: GridApi<Row>, result: QueryResult, plan: CopyPlan): CopyTable {
  const shown = shownColumns(api)
  const cols = plan.cols.map((p) => shown[p])
  const rows = plan.rows.map((r) => {
    const data = api.getDisplayedRowAtIndex(r)?.data
    return cols.map((i) => data?.[`c${i}`] ?? null)
  })
  return { columns: cols.map((i) => result.columns[i]), rows }
}

interface MenuState {
  x: number
  y: number
  /** Where the menu was opened: a cell (right-click), a column header (right-click) or the toolbar button. */
  from: { kind: 'cell'; rowIndex: number; colId: string } | { kind: 'toolbar'; colId: string } | { kind: 'header'; colId: string }
}

interface ViewerState {
  x: number
  y: number
  title: string
  value: Cell
}

const FORMATS: CopyFormat[] = ['tsv', 'csv', 'markdown', 'json']

/** The kind (number, text, ...) of the result column behind a grid column id like `c3`. */
function kindOfColId(result: QueryResult, colId: string | undefined): ColumnKind {
  const col = colId ? result.columns[Number(colId.slice(1))] : undefined
  return columnKind(col ? columnTypeName(col) : '')
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`

/** The numbers shown at the right of the bar for a selection of several cells. */
function StatsBar({ stats }: { stats: SelectionStats }) {
  const item = (label: string, value: string) => (
    <span key={label} className="qw-stat">
      {label} <b>{value}</b>
    </span>
  )
  return (
    <span className="qw-grid-stats" aria-label="Selection summary">
      {item('Count', formatStat(stats.count))}
      {item('Distinct', formatStat(stats.distinct))}
      {item('Nulls', formatStat(stats.nulls))}
      {stats.numeric && item('Sum', formatStat(stats.numeric.sum))}
      {stats.numeric && item('Avg', formatStat(stats.numeric.avg))}
      {stats.numeric && item('Min', formatStat(stats.numeric.min))}
      {stats.numeric && item('Max', formatStat(stats.numeric.max))}
    </span>
  )
}

/**
 * Results as a grid with a spreadsheet selection. Rows are positional arrays from the API. Each cell is keyed
 * `c<index>` so column names that contain dots are not read as nested paths.
 *
 * Click, drag, Shift and Cmd/Ctrl pick cells, rows (the numbers on the left) and columns (the headers), and
 * the arrow keys move the active cell. Cmd/Ctrl+C copies the selection with headers. The "Copy as" formats and
 * the right-click actions apply to the selection when it holds more than one cell, otherwise to every shown row.
 *
 * `sourceSql` is the one statement that produced the result, when it is known; it enables "Value counts in new
 * query window" in the header menu, which hands a new query to `onOpenQuery`.
 */
export function ResultsGrid({
  result,
  sourceSql = null,
  onOpenQuery,
}: {
  result: QueryResult
  sourceSql?: string | null
  onOpenQuery?: (sql: string) => void
}) {
  const apiRef = useRef<GridApi<Row> | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [viewer, setViewer] = useState<ViewerState | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [stats, setStats] = useState<SelectionStats | null>(null)
  const messageTimer = useRef<number | undefined>(undefined)

  const say = useCallback((text: string) => {
    setMessage(text)
    window.clearTimeout(messageTimer.current)
    messageTimer.current = window.setTimeout(() => setMessage(null), 3500)
  }, [])

  const copy = useCallback(
    async (text: string, what: string) => {
      say((await writeClipboard(text)) ? `Copied ${what}` : 'Copy failed: the browser blocked clipboard access')
    },
    [say],
  )

  const openMenu = menu !== null
  const openViewer = viewer !== null
  const sel = useGridSelection({
    apiRef,
    wrapRef,
    onCopy: copySelection,
    onHeaderMenu: (colId, x, y) => setMenu({ x, y, from: { kind: 'header', colId } }),
    isBlocked: () => openMenu || openViewer,
  })
  const { selection, syncColumns, reset, ensureCellSelected, dims } = sel

  const rowData = useMemo<Row[]>(
    () => result.rows.map((r) => Object.fromEntries(r.map((v, i) => [`c${i}`, v]))),
    [result.rows],
  )
  const columnDefs = useMemo(
    () => [gutterColumn(result.rows.length, sel.gutterClassRules), ...buildColumnDefs(result.columns)],
    [result.columns, result.rows.length, sel.gutterClassRules],
  )
  const defaultColDef = useMemo<ColDef<Row>>(() => ({ ...DEFAULT_COL_DEF, cellClassRules: sel.cellClassRules }), [sel.cellClassRules])

  const closeMenu = useCallback(() => setMenu(null), [])
  const closeViewer = useCallback(() => setViewer(null), [])
  const onGridReady = useCallback(
    (e: GridReadyEvent<Row>) => {
      apiRef.current = e.api
      syncColumns()
    },
    [syncColumns],
  )

  // A different order or set of rows or columns changes what a position means, so the selection goes.
  const onViewChanged = useCallback(() => reset(), [reset])

  const onCellContextMenu = useCallback(
    (e: CellContextMenuEvent<Row>) => {
      const ev = e.event as MouseEvent | null
      const colId = e.column.getColId()
      if (!ev || !DATA_COLUMN.test(colId)) return
      const col = sel.colIdsRef.current.indexOf(colId)
      if (col >= 0 && e.rowIndex !== null) ensureCellSelected(e.rowIndex, col)
      setMenu({ x: ev.clientX, y: ev.clientY, from: { kind: 'cell', rowIndex: e.rowIndex ?? 0, colId } })
    },
    [ensureCellSelected, sel.colIdsRef],
  )

  const onCellDoubleClicked = useCallback((e: CellDoubleClickedEvent<Row>) => {
    const ev = e.event as MouseEvent | null
    const colId = e.column.getColId()
    if (!ev || !DATA_COLUMN.test(colId)) return
    setViewer({
      x: ev.clientX,
      y: ev.clientY,
      title: e.column.getColDef().headerName ?? colId,
      value: e.data?.[colId] ?? null,
    })
  }, [])

  // The summary of the selected cells, a moment after the selection settles so a drag stays smooth.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const api = apiRef.current
      if (!api || cellCount(selection.ranges) <= 1) return setStats(null)
      const ids = sel.colIdsRef.current
      const numeric = [...touchedColumns(selection.ranges)].every((p) => kindOfColId(result, ids[p]) === 'number')
      const values: Cell[] = []
      forEachCell(selection.ranges, (row, col) => values.push(api.getDisplayedRowAtIndex(row)?.data?.[ids[col]] ?? null))
      setStats(computeStats(values, numeric))
    }, 80)
    return () => window.clearTimeout(timer)
  }, [selection, result.columns, sel.colIdsRef])

  const rowsLabel = (n: number) => plural(n, 'row')

  /** What the selection covers as a copy plan, or null for none. */
  function currentPlan(): CopyPlan | null {
    return copyPlan(selection.ranges, dims())
  }

  /** Cmd/Ctrl+C: the selection as TSV with headers; one cell is just its value. */
  function copySelection() {
    const api = apiRef.current
    const plan = sel.selRef.current.ranges.length ? copyPlan(sel.selRef.current.ranges, dims()) : null
    if (!api || !plan) return
    const t = readPlan(api, result, plan)
    if (plan.rows.length === 1 && plan.cols.length === 1) return void copy(cellText(t.rows[0][0]), 'value')
    const what = describePlan(plan, dims())
    void copy(
      formatTable(t, 'tsv', { headers: true }),
      plan.dropped ? `${what} (the last of ${plan.ranges} selected ranges; only one rectangle can be copied)` : what,
    )
  }

  function filterValue(colId: string, raw: Cell | undefined, mode: ValueFilterMode) {
    const api = apiRef.current
    if (!api) return
    const idx = Number(colId.slice(1))
    const kind = kindOfColId(result, colId)
    const model = valueFilterModel(raw, kind, mode)
    if (!model) return say('That value cannot be used as a filter')
    api.setFilterModel({ ...api.getFilterModel(), [colId]: model })
    const byDay = kind === 'date' || kind === 'timestamp' ? ' (by day)' : ''
    say(`${mode === 'equals' ? 'Filtered' : 'Excluded'} ${result.columns[idx]?.name}${byDay}. Clear it from the column's filter menu`)
  }

  function menuItems(m: MenuState): MenuItem[] {
    const api = apiRef.current
    if (!api) return []
    const colIdx = Number(m.from.colId.slice(1))
    const colName = result.columns[colIdx]?.name ?? ''
    const shownIdx = shownColumns(api).indexOf(colIdx)

    if (m.from.kind === 'header') return headerItems(api, m.from.colId, colIdx, colName, shownIdx)

    // Right-click scope: the selection when it holds more than one cell. The toolbar button means every shown row.
    const plan = m.from.kind === 'cell' ? currentPlan() : null
    const useSelection = plan !== null && plan.rows.length * plan.cols.length > 1
    const scopeTable = () => (useSelection && plan ? readPlan(api, result, plan) : readAll(api, result))
    const scopeLabel = useSelection && plan ? `${describePlan(plan, dims())} selected` : 'all shown rows'
    // Column of the clicked cell inside the scope's table (the first one when the selection does not include it).
    const inTable = useSelection && plan ? plan.cols.indexOf(shownIdx) : shownIdx
    const formats: MenuItem[] = [
      { kind: 'title', label: `Copy as: ${scopeLabel}` },
      ...FORMATS.map((f): MenuItem => ({
        kind: 'format',
        label: COPY_FORMAT_LABELS[f],
        run: (headers) => {
          const t = scopeTable()
          void copy(formatTable(t, f, { headers }), `${rowsLabel(t.rows.length)} as ${COPY_FORMAT_LABELS[f]}`)
        },
      })),
      {
        kind: 'format',
        label: `SQL IN list (${colName})`,
        headerLabel: `${colName} IN`,
        run: (headers) => {
          const t = scopeTable()
          void copy(formatTable(t, 'sql-in', { headers, column: Math.max(0, inTable) }), `IN list of ${colName}`)
        },
      },
    ]
    if (m.from.kind === 'toolbar') return formats
    const { rowIndex, colId } = m.from
    const raw = api.getDisplayedRowAtIndex(rowIndex)?.data?.[colId] ?? null
    const type = columnTypeName(result.columns[colIdx] ?? { type: '' })
    return [
      {
        kind: 'action',
        label: 'Copy value',
        run: () => void copy(cellText(raw), 'value'),
      },
      {
        kind: 'action',
        label: 'Copy row',
        run: () => {
          const data = api.getDisplayedRowAtIndex(rowIndex)?.data
          void copy(rowText(shownColumns(api).map((i) => data?.[`c${i}`] ?? null)), 'row')
        },
      },
      {
        kind: 'action',
        label: `Copy column (${colName})`,
        run: () => {
          const t = readAll(api, result)
          void copy(columnText(t, Math.max(0, shownIdx)), `column ${colName}`)
        },
      },
      { kind: 'separator' },
      { kind: 'action', label: 'Filter grid to this value', run: () => filterValue(colId, raw, 'equals') },
      { kind: 'action', label: 'Exclude this value', run: () => filterValue(colId, raw, 'notEqual') },
      { kind: 'action', label: 'Copy as WHERE col = value', run: () => void copy(whereEquals(colName, type, raw), 'WHERE clause') },
      { kind: 'separator' },
      ...formats,
    ]
  }

  function headerItems(api: GridApi<Row>, colId: string, colIdx: number, colName: string, shownIdx: number): MenuItem[] {
    const pinned = api.getColumn(colId)?.getPinned()
    const hidden = (api.getColumns() ?? []).filter((c) => DATA_COLUMN.test(c.getColId()) && !c.isVisible()).map((c) => c.getColId())
    const items: MenuItem[] = [
      { kind: 'action', label: 'Copy name', run: () => void copy(colName, 'column name') },
      {
        kind: 'action',
        label: 'Copy values (shown rows)',
        run: () => void copy(columnText(readAll(api, result), Math.max(0, shownIdx)), `values of ${colName}`),
      },
      { kind: 'separator' },
      { kind: 'action', label: 'Hide column', run: () => api.setColumnsVisible([colId], false) },
      { kind: 'action', label: pinned ? 'Unpin' : 'Pin left', run: () => api.setColumnsPinned([colId], pinned ? null : 'left') },
      {
        kind: 'action',
        label: 'Autosize',
        run: () => {
          api.autoSizeColumns([colId])
          const w = api.getColumnState().find((c) => c.colId === colId)?.width ?? 0
          if (w > MAX_AUTO_WIDTH) api.setColumnWidths([{ key: colId, newWidth: MAX_AUTO_WIDTH }])
        },
      },
    ]
    if (hidden.length) {
      items.push({ kind: 'action', label: `Show hidden columns (${hidden.length})`, run: () => api.setColumnsVisible(hidden, true) })
    }
    if (onOpenQuery) {
      items.push({ kind: 'separator' })
      items.push(
        sourceSql
          ? {
              kind: 'action',
              label: 'Value counts in new query window',
              run: () => onOpenQuery(valueCountsSql(sourceSql, result.columns[colIdx]?.name ?? colName)),
            }
          : { kind: 'title', label: 'Value counts: needs a single statement' },
      )
    }
    return items
  }

  function openToolbarMenu(button: HTMLElement) {
    const rect = button.getBoundingClientRect()
    const first = sel.colIdsRef.current[sel.selRef.current.active?.col ?? 0]
    setMenu({ x: rect.left, y: rect.bottom + 2, from: { kind: 'toolbar', colId: first ?? 'c0' } })
  }

  function exportCsv() {
    const api = apiRef.current
    if (!api) return
    api.exportDataAsCsv({
      fileName: 'results.csv',
      // Raw values, not the display formatting: NULL is empty, timestamps keep their exact text.
      processCellCallback: (p) => cellText(p.value as Cell),
      // The row-number column is not data.
      columnKeys: shownColumns(api).map((i) => `c${i}`),
    })
  }

  return (
    <div className="qw-grid-wrap">
      <div className="qw-grid-bar nodrag">
        <button onClick={(e) => openToolbarMenu(e.currentTarget)} title="Copy all rows after filters and sort">
          Copy all as…
        </button>
        <button onClick={exportCsv} title="Download the rows after filters and sort as a CSV file">
          Export CSV
        </button>
        {message && (
          <span className="hint" role="status">
            {message}
          </span>
        )}
        {stats && <StatsBar stats={stats} />}
      </div>
      <div className="qw-grid nodrag" ref={wrapRef} tabIndex={-1}>
        <GridUiContext.Provider value={sel.uiValue}>
          <AgGridReact<Row>
            // A new result gets a new grid, so columns are autosized again for it.
            key={result.statement_id}
            theme={resultsTheme}
            columnDefs={columnDefs}
            rowData={rowData}
            defaultColDef={defaultColDef}
            // Selection is ours (see useGridSelection), so the grid keeps no cell focus, row selection or
            // text selection of its own. A double-click opens the value viewer.
            suppressCellFocus
            // The right-click menus are ours.
            preventDefaultOnContextMenu
            onCellContextMenu={onCellContextMenu}
            onCellDoubleClicked={onCellDoubleClicked}
            onGridReady={onGridReady}
            onDisplayedColumnsChanged={syncColumns}
            onSortChanged={onViewChanged}
            onFilterChanged={onViewChanged}
            // Autosizing only measures rendered columns, so render all of them (rows are still virtualized).
            suppressColumnVirtualisation
            onFirstDataRendered={autosize}
          />
        </GridUiContext.Provider>
      </div>
      {menu && <CopyMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={closeMenu} />}
      {viewer && <CellViewer x={viewer.x} y={viewer.y} title={viewer.title} value={viewer.value} onClose={closeViewer} />}
    </div>
  )
}
