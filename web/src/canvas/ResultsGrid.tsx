import { useMemo } from 'react'
import { AgGridReact } from 'ag-grid-react'
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type FirstDataRenderedEvent,
} from 'ag-grid-community'
import type { QueryResult } from '../api/types'
import { MAX_AUTO_WIDTH, buildColumnDefs, type Row } from './grid/columns'

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

/** Fit every column to its content, then cap the width so one long text column cannot fill the window. */
function autosize(e: FirstDataRenderedEvent<Row>) {
  e.api.autoSizeAllColumns()
  const capped = e.api
    .getColumnState()
    .filter((c) => (c.width ?? 0) > MAX_AUTO_WIDTH)
    .map((c) => ({ key: c.colId, newWidth: MAX_AUTO_WIDTH }))
  if (capped.length) e.api.setColumnWidths(capped)
}

/**
 * Rows are positional arrays from the API. Each cell is keyed `c<index>` so column
 * names that contain dots are not read as nested paths.
 */
export function ResultsGrid({ result }: { result: QueryResult }) {
  const columnDefs = useMemo(() => buildColumnDefs(result.columns), [result.columns])

  const rowData = useMemo<Row[]>(
    () => result.rows.map((r) => Object.fromEntries(r.map((v, i) => [`c${i}`, v]))),
    [result.rows],
  )

  return (
    <div className="qw-grid">
      <AgGridReact<Row>
        // A new result gets a new grid, so columns are autosized again for it.
        key={result.statement_id}
        theme={resultsTheme}
        columnDefs={columnDefs}
        rowData={rowData}
        defaultColDef={DEFAULT_COL_DEF}
        // Autosizing only measures rendered columns, so render all of them (rows are still virtualized).
        suppressColumnVirtualisation
        onFirstDataRendered={autosize}
      />
    </div>
  )
}
