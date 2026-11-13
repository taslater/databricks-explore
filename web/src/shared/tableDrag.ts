import type { DragEvent } from 'react'

/** MIME type of a table drag. The canvas drop target reads it. The value is the table's full name. */
export const TABLE_DRAG_MIME = 'application/x-explorer-table'

/** Drag-source props for a table row, for example `<li {...tableDragProps(full_name)}>`. */
export function tableDragProps(fullName: string) {
  return {
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.setData(TABLE_DRAG_MIME, fullName)
      e.dataTransfer.setData('text/plain', fullName)
      e.dataTransfer.effectAllowed = 'copy'
    },
  }
}
