// The column rows of a table node: key markers, the base type, and the `+N more` row. Which rows show is columns.ts's call.
import { baseType, rowsOf, type ColumnInfo } from './columns'
import { useGraphStore } from './graphStore'
import { ColumnHandles } from './TableHandles'
import type { TableNodeData } from './types'

/** A small key (primary key) and arrow (foreign key) before a column name; a column that is both gets both. */
export function KeyMarks({ column }: { column: ColumnInfo }) {
  if (!column.pk && !column.fk) return <span className="tbl-col-marks" />
  return (
    <span className="tbl-col-marks">
      {column.pk && (
        <svg className="tbl-key-pk" width="10" height="10" viewBox="0 0 10 10" role="img" aria-label="primary key">
          <title>Primary key</title>
          <circle cx="3" cy="3" r="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M4.5 4.5 L9 9 M7 7 L8.4 5.6 M8.2 8.2 L9.4 7" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )}
      {column.fk && (
        <svg className="tbl-key-fk" width="10" height="10" viewBox="0 0 10 10" role="img" aria-label="foreign key">
          <title>Foreign key</title>
          <path d="M1 5 H9 M6 2 L9 5 L6 8" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      )}
    </span>
  )
}

/** The rows under a node's name at its column level (keys or all), each with its handles, then a row that changes the level. */
export function ColumnRows({ id, data, split }: { id: string; data: TableNodeData; split: ReadonlySet<string> }) {
  if (!data.showColumns || !data.columns) return null
  const rows = rowsOf(data)
  const hidden = data.columns.length - rows.length
  if (rows.length === 0 && hidden === 0) return null
  return (
    <div className="tbl-cols">
      {rows.map((c) => (
        <div className="tbl-col" key={c.name} title={`${c.name} ${c.type}${c.pk ? ' (primary key)' : ''}${c.fk ? ' (foreign key)' : ''}`}>
          <ColumnHandles column={c.name} split={split} />
          <span className="tbl-col-name">
            <KeyMarks column={c} />
            {c.name}
          </span>
          <span className="tbl-col-type">{baseType(c.type)}</span>
        </div>
      ))}
      {(hidden > 0 || data.allColumns) && (
        <button
          className="tbl-more nodrag"
          onClick={(e) => {
            e.stopPropagation()
            const store = useGraphStore.getState()
            store.setAllColumns(id, !data.allColumns)
            store.requestLayoutSoon([id])
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {data.allColumns ? 'show keys only' : `+${hidden} more`}
        </button>
      )}
    </div>
  )
}
