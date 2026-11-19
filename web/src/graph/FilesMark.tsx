import { filesTitle, FROM_FILES, hasFiles } from './nodeMarks'
import type { TableNodeData } from './types'

/** The small "files" mark after a node's name: the table is loaded from files. Nothing for any other table. */
export function FilesMark({ data }: { data: TableNodeData }) {
  if (!hasFiles(data)) return null
  return (
    <span className="tbl-mark" title={filesTitle(data.files ?? [])}>
      {FROM_FILES}
    </span>
  )
}
