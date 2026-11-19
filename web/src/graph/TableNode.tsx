import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { useEffect } from 'react'
import { CertBadge } from '../concepts/CertBadge'
import { useGraphActions } from './actions'
import { columnHandleId, visibleColumns } from './columns'
import { isPlaceholder, nodeFill } from './format'
import { useGraphStore } from './graphStore'
import { GrainLine, LateDot, SizeBadge } from './NodeFacts'
import type { FlowNode } from './types'

/** Table, view, or streaming node. Same look as the legacy Cytoscape style. It can list its columns, each with its own handles. */
export function TableNode({ id, data, selected }: NodeProps<FlowNode>) {
  const actions = useGraphActions()
  const updateInternals = useUpdateNodeInternals()
  const classes = [
    'tbl-node',
    data.focus && 'is-focus',
    data.external && 'is-external',
    data.missing && 'is-missing',
    selected && 'is-selected',
    data.faded && 'is-faded',
    data.showColumns && 'with-columns',
  ]
    .filter(Boolean)
    .join(' ')

  const rows = data.showColumns && data.columns ? visibleColumns(data.columns, data.involved ?? [], !!data.allColumns) : []
  const hiddenCount = data.showColumns && data.columns ? data.columns.length - rows.length : 0
  const shown = rows.map((c) => c.name).join('\u0000')

  // Column rows add and remove handles, so React Flow has to read the node's handles again.
  useEffect(() => {
    updateInternals(id)
  }, [id, shown, updateInternals])

  // Four handles per side. The edge picks the pair that matches its direction (see handlesFor in derive.ts).
  return (
    <div className={classes} style={{ background: data.missing ? 'transparent' : nodeFill(data.kind) }}
      title={data.missing ? `Does not exist${data.missingReason ? `: ${data.missingReason}` : ''}` : undefined}>
      <Handle type="target" position={Position.Left} id="tgt-l" className="tbl-handle" />
      <Handle type="target" position={Position.Right} id="tgt-r" className="tbl-handle" />
      <Handle type="target" position={Position.Top} id="tgt-t" className="tbl-handle" />
      <Handle type="target" position={Position.Bottom} id="tgt-b" className="tbl-handle" />
      <Handle type="source" position={Position.Left} id="src-l" className="tbl-handle" />
      <Handle type="source" position={Position.Right} id="src-r" className="tbl-handle" />
      <Handle type="source" position={Position.Top} id="src-t" className="tbl-handle" />
      <Handle type="source" position={Position.Bottom} id="src-b" className="tbl-handle" />
      <div className="tbl-name">
        <LateDot facts={data.facts} />
        {data.selfRef && '↻ '}
        {data.name}
        {data.certification && <CertBadge status={data.certification} />}
        <SizeBadge facts={data.facts} />
      </div>
      <GrainLine facts={data.facts} />
      {data.showSchema && <div className="tbl-sub">{data.schema}</div>}
      {data.via && <div className="tbl-sub">via {data.via}</div>}
      {!isPlaceholder(id) && !data.missing && (
        <button
          className="tbl-cols-btn nodrag"
          title={data.showColumns ? 'Hide columns' : 'Show columns, with column lineage and mined joins'}
          aria-pressed={!!data.showColumns}
          onClick={(e) => {
            e.stopPropagation()
            actions.toggleColumns(id)
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {data.showColumns ? '▾ cols' : '▸ cols'}
        </button>
      )}
      {rows.length > 0 && (
        <div className="tbl-cols">
          {rows.map((c) => (
            <div className="tbl-col" key={c.name} title={`${c.name} ${c.type}`}>
              <Handle type="target" position={Position.Left} id={columnHandleId('t', 'l', c.name)} className="tbl-col-handle" />
              <Handle type="source" position={Position.Left} id={columnHandleId('s', 'l', c.name)} className="tbl-col-handle" />
              <Handle type="target" position={Position.Right} id={columnHandleId('t', 'r', c.name)} className="tbl-col-handle" />
              <Handle type="source" position={Position.Right} id={columnHandleId('s', 'r', c.name)} className="tbl-col-handle" />
              <span className="tbl-col-name">{c.name}</span>
              <span className="tbl-col-type">{c.type}</span>
            </div>
          ))}
          {(hiddenCount > 0 || data.allColumns) && (
            <button
              className="tbl-more nodrag"
              onClick={(e) => {
                e.stopPropagation()
                useGraphStore.getState().setAllColumns(id, !data.allColumns)
                setTimeout(() => useGraphStore.getState().requestLayout(), 250)
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {data.allColumns ? 'show fewer' : `+${hiddenCount} more`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
