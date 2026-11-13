import { Handle, Position, type NodeProps } from '@xyflow/react'
import { nodeFill } from './format'
import type { FlowNode } from './types'

/** Table, view, or streaming node. Same look as the legacy Cytoscape style. */
export function TableNode({ data, selected }: NodeProps<FlowNode>) {
  const classes = [
    'tbl-node',
    data.focus && 'is-focus',
    data.external && 'is-external',
    selected && 'is-selected',
    data.faded && 'is-faded',
  ]
    .filter(Boolean)
    .join(' ')

  // Four handles per side. The edge picks the pair that matches its direction (see handlesFor in derive.ts).
  return (
    <div className={classes} style={{ background: nodeFill(data.kind) }}>
      <Handle type="target" position={Position.Left} id="tgt-l" className="tbl-handle" />
      <Handle type="target" position={Position.Right} id="tgt-r" className="tbl-handle" />
      <Handle type="target" position={Position.Top} id="tgt-t" className="tbl-handle" />
      <Handle type="target" position={Position.Bottom} id="tgt-b" className="tbl-handle" />
      <Handle type="source" position={Position.Left} id="src-l" className="tbl-handle" />
      <Handle type="source" position={Position.Right} id="src-r" className="tbl-handle" />
      <Handle type="source" position={Position.Top} id="src-t" className="tbl-handle" />
      <Handle type="source" position={Position.Bottom} id="src-b" className="tbl-handle" />
      <div className="tbl-name">
        {data.selfRef && '↻ '}
        {data.name}
      </div>
      {data.showSchema && <div className="tbl-sub">{data.schema}</div>}
      {data.via && <div className="tbl-sub">via {data.via}</div>}
    </div>
  )
}
