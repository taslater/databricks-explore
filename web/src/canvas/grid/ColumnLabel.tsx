import { createContext, useContext, useEffect, useState } from 'react'
import type { IHeaderParams, SortDirection } from 'ag-grid-community'

/** What the headers need to know about the selection. Provided by ResultsGrid; AG Grid renders headers inside its tree. */
export const GridUiContext = createContext<{ selectedCols: ReadonlySet<string> }>({ selectedCols: new Set() })

const NEXT_SORT: Record<string, SortDirection> = { none: 'asc', asc: 'desc', desc: null }

/**
 * Header label: the column name with its type underneath, and a small sort button. Clicking the header
 * selects the column, so sorting lives in the button: it shows on hover and stays while the column is sorted,
 * and each click goes ascending, descending, off. Plugged into AG Grid's default header via innerHeaderComponent.
 */
export function ColumnLabel(props: IHeaderParams & { typeText?: string }) {
  const { displayName, typeText, column, setSort } = props
  const { selectedCols } = useContext(GridUiContext)
  const [sort, setSortState] = useState<SortDirection>(column.getSort() ?? null)

  useEffect(() => {
    const update = () => setSortState(column.getSort() ?? null)
    update()
    column.addEventListener('sortChanged', update)
    return () => column.removeEventListener('sortChanged', update)
  }, [column])

  const sortable = props.enableSorting !== false
  return (
    <span className={`qw-colhead${selectedCols.has(column.getColId()) ? ' sel' : ''}`}>
      <span className="qw-colhead-text">
        <span className="qw-colname">{displayName}</span>
        {typeText && <span className="qw-coltype">{typeText}</span>}
      </span>
      {sortable && (
        <button
          type="button"
          className={`qw-sortbtn${sort ? ' on' : ''}`}
          title={sort === 'asc' ? 'Sorted ascending. Click for descending' : sort === 'desc' ? 'Sorted descending. Click to clear' : 'Sort ascending'}
          aria-label={`Sort ${displayName}`}
          onClick={(e) => {
            e.stopPropagation()
            setSort(NEXT_SORT[sort ?? 'none'])
          }}
        >
          {sort === 'asc' ? '▲' : sort === 'desc' ? '▼' : '▲▼'}
        </button>
      )}
    </span>
  )
}
