import { useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { useEffect } from 'react'
import { CertBadge } from '../concepts/CertBadge'
import { useGraphActions } from './actions'
import { visibleColumns } from './columns'
import { isPlaceholder, nodeFill } from './format'
import { useGraphStore } from './graphStore'
import { FilesMark } from './FilesMark'
import { GrainLine, LateDot, SizeBadge } from './NodeFacts'
import { NeighborCounts } from './NeighborCounts'
import { TypeIcon } from './TypeIcon'
import { ColumnHandles, TableHandles } from './TableHandles'
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

  // The sides that carry edges both ways anchor them at different points (graph/anchors.ts), so the handles move.
  const split = new Set(data.anchorSplit)
  const splitKey = [...split].join('|')

  // Column rows add and remove handles, and a split moves them, so React Flow has to read the node's handles again.
  useEffect(() => {
    updateInternals(id)
  }, [id, shown, splitKey, updateInternals])

  // Four handles per side. The edge picks the pair that matches its direction (see handlesFor in derive.ts).
  return (
    <div className={classes} style={{ background: data.missing ? 'transparent' : (data.fill ?? nodeFill(data.kind)) }}
      title={data.missing ? `Does not exist${data.missingReason ? `: ${data.missingReason}` : ''}` : undefined}>
      <TableHandles split={split} />
      <div className="tbl-name">
        <LateDot facts={data.facts} />
        <TypeIcon kind={data.kind} />
        {data.selfRef && '↻ '}
        {data.name}
        {data.certification && <CertBadge status={data.certification} />}
        <FilesMark data={data} />
        <SizeBadge facts={data.facts} />
      </div>
      <NeighborCounts id={id} more={data.more} />
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
              <ColumnHandles column={c.name} split={split} />
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
