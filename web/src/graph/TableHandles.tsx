import { Handle, Position } from '@xyflow/react'
import { anchorPercent, anchorStyle, ROW_ANCHOR_IN, ROW_ANCHOR_OUT, type AnchorSide } from '../shared/anchors'
import { columnHandleId } from './columns'

const POSITION: Record<AnchorSide, Position> = { l: Position.Left, r: Position.Right, t: Position.Top, b: Position.Bottom }
const SIDES: AnchorSide[] = ['l', 'r', 't', 'b']

/** Four target and four source handles on a table node. A side that carries edges both ways puts the two kinds at different points. */
export function TableHandles({ split }: { split: ReadonlySet<string> }) {
  return (
    <>
      {SIDES.flatMap((side) =>
        (['in', 'out'] as const).map((role) => (
          <Handle
            key={`${role}-${side}`}
            type={role === 'in' ? 'target' : 'source'}
            position={POSITION[side]}
            id={`${role === 'in' ? 'tgt' : 'src'}-${side}`}
            className="tbl-handle"
            style={anchorStyle(side, anchorPercent(role, split.has(side)))}
          />
        )),
      )}
    </>
  )
}

/** The handles of one column row: a target and a source on each side, split like the node's own. */
export function ColumnHandles({ column, split }: { column: string; split: ReadonlySet<string> }) {
  return (
    <>
      {(['l', 'r'] as const).flatMap((side) =>
        (['t', 's'] as const).map((role) => (
          <Handle
            key={`${role}-${side}`}
            type={role === 't' ? 'target' : 'source'}
            position={POSITION[side]}
            id={columnHandleId(role, side, column)}
            className="tbl-col-handle"
            style={anchorStyle(side, anchorPercent(role === 't' ? 'in' : 'out', split.has(`${side}:${column}`), ROW_ANCHOR_IN, ROW_ANCHOR_OUT))}
          />
        )),
      )}
    </>
  )
}
