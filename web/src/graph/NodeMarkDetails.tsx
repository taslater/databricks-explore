import { fmtAge } from './format'
import { selfRefReasons } from './nodeMarks'
import type { TableNodeData } from './types'

/** Details for the markers on a node: why it has a ↻, and which files it is loaded from. */
export function NodeMarkDetails({ data }: { data: TableNodeData }) {
  const self = selfRefReasons(data)
  const files = data.files ?? []
  return (
    <>
      {data.selfRef && (
        <div>
          {self.lineage && <p>↻ Reads its own data (e.g. MERGE). Last seen {fmtAge(data.selfRefLastSeen)}</p>}
          {self.keys.map((k, i) => (
            <p key={i}>
              ↻ Foreign key to itself: {k.columns.join(', ')} → {k.parentColumns.join(', ')}
              {k.constraint ? ` (${k.constraint})` : ''}
            </p>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div>
          <h4>Loaded from files</h4>
          <ul className="constraints">
            {files.map((f, i) => (
              <li key={i}>
                {f.readable && f.path ? f.path : 'path not visible to you'}
                {f.last_seen ? ` · ${fmtAge(f.last_seen)}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}
