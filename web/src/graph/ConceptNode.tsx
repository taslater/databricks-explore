import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { ConceptFlowNode } from './types'

/** A glossary concept on the graph: an amber card with a pointed look, so it cannot be mistaken for a table. Click opens it in the Concepts tab. */
export function ConceptNode({ data }: NodeProps<ConceptFlowNode>) {
  return (
    <div className={`concept-node status-${data.status}`} title={`${data.name} (${data.status}${data.domain ? `, ${data.domain}` : ''})\n${data.targets.join('\n')}`}>
      <Handle type="source" position={Position.Bottom} id="src-b" className="tbl-handle" />
      <Handle type="source" position={Position.Top} id="src-t" className="tbl-handle" />
      <div className="concept-node-kind">concept · {data.status}</div>
      <div className="concept-node-name">{data.name}</div>
    </div>
  )
}
