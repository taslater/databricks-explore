import { SideHandles } from '../../sketch/nodes/SideHandles'
import { NodeResizer, type Node, type NodeProps } from '@xyflow/react'
import { useObject } from '../../api/hooks'
import type { CanvasWindow } from '../../api/types'
import { useCanvasStore } from '../../store/canvasStore'
import { useUiStore } from '../../store/uiStore'
import { WindowTitle } from './NoteWindow'

export type TableFlowNode = Node<Record<string, unknown>, 'table'>

/** Gap between a card and the query window that "Query this" places beside it. */
const QUERY_GAP = 40

/** The SQL a "Query this" window starts with. */
export function previewSql(fullName: string): string {
  return `SELECT * FROM ${fullName} LIMIT 100`
}

/**
 * Table card: full name, table comment, and the columns with types and comments.
 * Details come from GET /api/object through useObject (cached on the server).
 */
export function TableCard({ id, selected }: NodeProps<TableFlowNode>) {
  const win = useCanvasStore((s) => s.windows.find((w) => w.id === id))
  if (!win) return null
  return <TableBody win={win} selected={selected} />
}

function TableBody({ win, selected }: { win: CanvasWindow; selected: boolean }) {
  const id = win.id
  const collapsed = win.collapsed ?? false
  const fullName = win.table ?? ''
  const profile = useUiStore((s) => s.connectedProfile)
  const detail = useObject(profile !== null && fullName !== '' ? fullName : null)
  const setCollapsed = useCanvasStore((s) => s.setCollapsed)
  const removeWindow = useCanvasStore((s) => s.removeWindow)
  const resizeWindow = useCanvasStore((s) => s.resizeWindow)
  const addQueryWindowWithSql = useCanvasStore((s) => s.addQueryWindowWithSql)

  function queryThis() {
    // Placed to the right of the card, at the same height.
    addQueryWindowWithSql(
      { x: win.position.x + win.size.w + QUERY_GAP, y: win.position.y },
      previewSql(fullName),
    )
  }

  const info = detail.data?.data
  const tableType = typeof info?.table_type === 'string' ? info.table_type : null
  const comment = typeof info?.comment === 'string' && info.comment !== '' ? info.comment : null
  const columns = info?.columns ?? []

  let body
  if (profile === null) {
    body = <p className="hint">Connect to load the columns.</p>
  } else if (detail.isPending) {
    body = <p className="hint">Loading table details...</p>
  } else if (detail.isError) {
    body = <div className="error">{detail.error.message}</div>
  } else {
    body = (
      <>
        {comment && <p className="table-comment">{comment}</p>}
        {columns.length === 0 ? (
          <p className="hint">No columns.</p>
        ) : (
          <table className="table-cols">
            <thead>
              <tr>
                <th>Column</th>
                <th>Type</th>
                <th>Comment</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((c, i) => (
                <tr key={`${c.name ?? ''}-${i}`}>
                  <td className="col-name">{c.name ?? ''}</td>
                  <td className="col-type">{columnType(c)}</td>
                  <td className="col-comment">{typeof c.comment === 'string' ? c.comment : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    )
  }

  return (
    <>
      <div className={`qw-node table-node${selected ? ' selected' : ''}`}>
        <NodeResizer
          isVisible={selected && !collapsed}
          minWidth={240}
          minHeight={140}
          onResize={(_, p) => resizeWindow(id, { x: p.x, y: p.y }, { w: p.width, h: p.height })}
        />

        <div className="qw-header">
          <button
            className="qw-icon nodrag"
            onClick={() => setCollapsed(id, !collapsed)}
            aria-label={collapsed ? 'Expand window' : 'Collapse window'}
            title={collapsed ? 'Expand' : 'Collapse'}
          >
            {collapsed ? '▸' : '▾'}
          </button>
          <WindowTitle id={id} title={win.title} />
          <button
            className="qw-icon nodrag"
            onClick={() => removeWindow(id)}
            aria-label="Delete window"
            title="Delete window"
          >
            ✕
          </button>
        </div>

        {!collapsed && (
          <div className="table-body nodrag nowheel">
            <div className="table-name" title={fullName}>
              <span>{fullName}</span>
              {tableType && <span className="tag">{tableType}</span>}
            </div>
            <div className="table-actions">
              <button onClick={queryThis} disabled={fullName === ''} title={previewSql(fullName)}>
                Query this
              </button>
            </div>
            {body}
          </div>
        )}
      </div>
      <SideHandles />
    </>
  )
}

/** Databricks gives `type_text` (e.g. decimal(10,2)) when available, and `type_name` otherwise. */
function columnType(c: { type_name?: unknown; [key: string]: unknown }): string {
  if (typeof c.type_text === 'string' && c.type_text !== '') return c.type_text
  if (typeof c.type_name === 'string') return c.type_name
  return ''
}
