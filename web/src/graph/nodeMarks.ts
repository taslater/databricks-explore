// Markers for facts about a node itself: a self-reference (the ↻ before the name) and a table loaded from files.
// The mark says that something is there; the Details panel says what (see NodeMarkDetails.tsx).
import type { FileUpstream } from '../api/types'
import type { TableNodeData } from './types'

/** Text beside the name when the table is loaded from files. Empty otherwise. */
export const FROM_FILES = 'files'

export const hasFiles = (d: Pick<TableNodeData, 'files'>): boolean => (d.files?.length ?? 0) > 0

/** The name line as drawn: the ↻ for any self-reference (lineage or foreign key), then the name, then the files mark. */
export function nameLine(d: Pick<TableNodeData, 'name' | 'selfRef' | 'files'>): string {
  return `${d.selfRef ? '↻ ' : ''}${d.name}${hasFiles(d) ? ` ${FROM_FILES}` : ''}`
}

/** Hover text of the files mark. */
export function filesTitle(files: FileUpstream[]): string {
  const visible = files.filter((f) => f.readable && f.path).length
  const hidden = files.length - visible
  const parts = [visible ? `${visible} file source${visible === 1 ? '' : 's'}` : '', hidden ? `${hidden} path not visible to you` : '']
  return `Loaded from files: ${parts.filter(Boolean).join(', ')}`
}

/** Why a node carries the ↻: its lineage reads its own data, and the foreign keys that point at itself. */
export function selfRefReasons(d: Pick<TableNodeData, 'selfRef' | 'selfRefLastSeen' | 'selfRefFks'>): {
  lineage: boolean
  keys: Array<{ columns: string[]; parentColumns: string[]; constraint?: string }>
} {
  const keys = (d.selfRefFks ?? []).map((k) => ({
    columns: k.columns,
    parentColumns: k.parent_columns,
    ...(k.constraint ? { constraint: k.constraint } : {}),
  }))
  // A diagram saved before foreign keys counted had only lineage; so a mark with no key is lineage.
  return { lineage: !!d.selfRef && (!!d.selfRefLastSeen || keys.length === 0), keys }
}
