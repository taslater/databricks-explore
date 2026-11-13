import { useMemo } from 'react'
import { AgGridReact } from 'ag-grid-react'
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from 'ag-grid-community'
import type { QueryResult } from '../api/types'

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
  // Compact rows: Quartz defaults are 42px rows and 48px headers.
  rowHeight: 24,
  headerHeight: 28,
})

type Row = Record<string, string | null>

/**
 * Rows are positional arrays from the API. Each cell is keyed `c<index>` so column
 * names that contain dots are not read as nested paths.
 */
export function ResultsGrid({ result }: { result: QueryResult }) {
  const columnDefs = useMemo<ColDef<Row>[]>(
    () =>
      result.columns.map((c, i) => ({
        field: `c${i}`,
        headerName: c.name,
        headerTooltip: c.type,
      })),
    [result.columns],
  )

  const rowData = useMemo<Row[]>(
    () => result.rows.map((r) => Object.fromEntries(r.map((v, i) => [`c${i}`, v]))),
    [result.rows],
  )

  return (
    <div className="qw-grid">
      <AgGridReact<Row>
        theme={resultsTheme}
        columnDefs={columnDefs}
        rowData={rowData}
        defaultColDef={{ sortable: true, filter: true, resizable: true, minWidth: 80 }}
      />
    </div>
  )
}
