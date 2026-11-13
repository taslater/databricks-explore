import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { AgGridReact } from 'ag-grid-react'
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type CellContextMenuEvent,
  type ColDef,
  type FirstDataRenderedEvent,
  type GridApi,
  type GridReadyEvent,
  type RowSelectionOptions,
} from 'ag-grid-community'
import type { QueryResult } from '../api/types'
import { MAX_AUTO_WIDTH, buildColumnDefs, type Cell, type Row } from './grid/columns'
import { writeClipboard } from './grid/clipboard'
import { CopyMenu, type MenuItem } from './grid/CopyMenu'
import {
  COPY_FORMAT_LABELS,
  cellText,
  columnText,
  formatTable,
  rowText,
  type CopyFormat,
  type CopyTable,
} from './grid/copy'

// Community modules only. Do not register any Enterprise module here.
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
const DEFAULT_COL_DEF: ColDef<Row> = { sortable: true, filter: true, resizable: true, minWidth: 80 }

// Rows are picked with the checkbox column. A click on a cell only focuses it, so Ctrl/Cmd+C can mean
// "the focused cell" until rows are selected.
const ROW_SELECTION: RowSelectionOptions<Row> = {
  mode: 'multiRow',
  checkboxes: true,
  headerCheckbox: true,
  selectAll: 'filtered',
  enableClickSelection: false,
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

/** Indexes (into result.columns) of the data columns in the order they are shown. The checkbox column is skipped. */
function shownColumns(api: GridApi<Row>): number[] {
  return api
    .getAllDisplayedColumns()
    .map((c) => c.getColId())
    .filter((id) => DATA_COLUMN.test(id))
    .map((id) => Number(id.slice(1)))
}

/** The rows shown after filters and sort (`selectedOnly`: just the checked ones), as the shown columns. */
function readTable(api: GridApi<Row>, result: QueryResult, selectedOnly: boolean): CopyTable {
  const cols = shownColumns(api)
  const rows: Cell[][] = []
  api.forEachNodeAfterFilterAndSort((node) => {
    if (selectedOnly && !node.isSelected()) return
    rows.push(cols.map((i) => node.data?.[`c${i}`] ?? null))
  })
  return { columns: cols.map((i) => result.columns[i]), rows }
}

interface MenuState {
  x: number
  y: number
  /** Where the menu was opened: a cell (right-click) or the toolbar button. */
  from: { kind: 'cell'; rowIndex: number; colId: string } | { kind: 'toolbar'; colId: string }
}

const FORMATS: CopyFormat[] = ['tsv', 'csv', 'markdown', 'json']

/**
 * Rows are positional arrays from the API. Each cell is keyed `c<index>` so column
 * names that contain dots are not read as nested paths.
 */
export function ResultsGrid({ result }: { result: QueryResult }) {
  const apiRef = useRef<GridApi<Row> | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const messageTimer = useRef<number | undefined>(undefined)

  const columnDefs = useMemo(() => buildColumnDefs(result.columns), [result.columns])

  const rowData = useMemo<Row[]>(
    () => result.rows.map((r) => Object.fromEntries(r.map((v, i) => [`c${i}`, v]))),
    [result.rows],
  )

  const closeMenu = useCallback(() => setMenu(null), [])
  const onGridReady = useCallback((e: GridReadyEvent<Row>) => {
    apiRef.current = e.api
  }, [])

  const onCellContextMenu = useCallback((e: CellContextMenuEvent<Row>) => {
    const ev = e.event as MouseEvent | null
    if (!ev || !DATA_COLUMN.test(e.column.getColId())) return
    setMenu({
      x: ev.clientX,
      y: ev.clientY,
      from: { kind: 'cell', rowIndex: e.rowIndex ?? 0, colId: e.column.getColId() },
    })
  }, [])

  function say(text: string) {
    setMessage(text)
    window.clearTimeout(messageTimer.current)
    messageTimer.current = window.setTimeout(() => setMessage(null), 2500)
  }

  async function copy(text: string, what: string) {
    say((await writeClipboard(text)) ? `Copied ${what}` : 'Copy failed: the browser blocked clipboard access')
  }

  const rowsLabel = (n: number) => `${n} ${n === 1 ? 'row' : 'rows'}`

  /** Ctrl/Cmd+C: the checked rows as TSV with headers, otherwise the focused cell. Selected text copies natively. */
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'c') return
    if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return
    if (window.getSelection()?.toString()) return
    const api = apiRef.current
    if (!api) return
    if (api.getSelectedNodes().length > 0) {
      e.preventDefault()
      const t = readTable(api, result, true)
      void copy(formatTable(t, 'tsv', { headers: true }), rowsLabel(t.rows.length))
      return
    }
    const focused = api.getFocusedCell()
    const node = focused ? api.getDisplayedRowAtIndex(focused.rowIndex) : undefined
    if (focused && node && DATA_COLUMN.test(focused.column.getColId())) {
      e.preventDefault()
      void copy(cellText(node.data?.[focused.column.getColId()]), 'value')
    }
  }

  function menuItems(m: MenuState): MenuItem[] {
    const api = apiRef.current
    if (!api) return []
    const colIdx = Number(m.from.colId.slice(1))
    const colName = result.columns[colIdx]?.name ?? ''
    const fromCell = m.from.kind === 'cell'
    // Right-click scope: the checked rows when there are any. The toolbar button always means every shown row.
    const useSelected = fromCell && api.getSelectedNodes().length > 0
    const scope = () => readTable(api, result, useSelected)
    const shownIdx = shownColumns(api).indexOf(colIdx)
    const formats: MenuItem[] = [
      { kind: 'title', label: `Copy as: ${useSelected ? `${rowsLabel(api.getSelectedNodes().length)} selected` : 'all shown rows'}` },
      ...FORMATS.map((f): MenuItem => ({
        kind: 'format',
        label: COPY_FORMAT_LABELS[f],
        run: (headers) => {
          const t = scope()
          void copy(formatTable(t, f, { headers }), `${rowsLabel(t.rows.length)} as ${COPY_FORMAT_LABELS[f]}`)
        },
      })),
      {
        kind: 'format',
        label: `SQL IN list (${colName})`,
        headerLabel: `${colName} IN`,
        run: (headers) => {
          const t = scope()
          void copy(formatTable(t, 'sql-in', { headers, column: Math.max(0, shownIdx) }), `IN list of ${colName}`)
        },
      },
    ]
    if (m.from.kind === 'toolbar') return formats
    const { rowIndex } = m.from
    return [
      {
        kind: 'action',
        label: 'Copy value',
        run: () => void copy(cellText(api.getDisplayedRowAtIndex(rowIndex)?.data?.[`c${colIdx}`]), 'value'),
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
          const t = readTable(api, result, false)
          void copy(columnText(t, Math.max(0, shownIdx)), `column ${colName}`)
        },
      },
      { kind: 'separator' },
      ...formats,
    ]
  }

  function openToolbarMenu(button: HTMLElement) {
    const rect = button.getBoundingClientRect()
    const focused = apiRef.current?.getFocusedCell()?.column.getColId()
    setMenu({
      x: rect.left,
      y: rect.bottom + 2,
      from: { kind: 'toolbar', colId: focused && DATA_COLUMN.test(focused) ? focused : 'c0' },
    })
  }

  function exportCsv() {
    apiRef.current?.exportDataAsCsv({
      fileName: 'results.csv',
      // Raw values, not the display formatting: NULL is empty, timestamps keep their exact text.
      processCellCallback: (p) => cellText(p.value as Cell),
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
      </div>
      <div className="qw-grid nodrag" onKeyDown={onKeyDown}>
        <AgGridReact<Row>
          // A new result gets a new grid, so columns are autosized again for it.
          key={result.statement_id}
          theme={resultsTheme}
          columnDefs={columnDefs}
          rowData={rowData}
          defaultColDef={DEFAULT_COL_DEF}
          rowSelection={ROW_SELECTION}
          // Text in cells can be selected with the mouse and copied; the DOM order keeps it in row order.
          enableCellTextSelection
          ensureDomOrder
          // The right-click menu is ours.
          preventDefaultOnContextMenu
          onCellContextMenu={onCellContextMenu}
          onGridReady={onGridReady}
          // Autosizing only measures rendered columns, so render all of them (rows are still virtualized).
          suppressColumnVirtualisation
          onFirstDataRendered={autosize}
        />
      </div>
      {menu && <CopyMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={closeMenu} />}
    </div>
  )
}
