import { useUpdateNodeInternals, type NodeProps } from '@xyflow/react'
import { useEffect } from 'react'
import { CertBadge } from '../concepts/CertBadge'
import { useGraphActions } from './actions'
import { columnLevel, rowsOf } from './columns'
import { ColumnRows } from './ColumnRows'
import { isPlaceholder, nodeFill } from './format'
import { FilesMark } from './FilesMark'
import { GrainLine, LateDot, SizeBadge } from './NodeFacts'
import { NeighborCounts } from './NeighborCounts'
import { TableHandles } from './TableHandles'
import type { FlowNode } from './types'

const LEVEL_LABEL = { none: '▸ cols', keys: '▾ keys', all: '▾ all' }
const LEVEL_TITLE = {
  none: 'Show the key columns and the columns with an edge (click again for all columns)',
  keys: 'Show all columns (click again to hide them)',
  all: 'Hide columns',
}

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

  const level = columnLevel(data)
  const shown = rowsOf(data).map((c) => c.name).join('|')

  // The sides that carry edges both ways anchor them at different points (graph/anchors.ts), so the handles move.
  const split = new Set(data.anchorSplit)
  const splitKey = [...split].join('|')

  // Column rows add and remove handles, and a split moves them, so React Flow has to read the node's handles again.
  useEffect(() => {
    updateInternals(id)
  }, [id, shown, splitKey, updateInternals])

  // Four handles per side. The edge picks the pair that matches its direction (see handlesFor in derive.ts).
  return (
    <div className={classes} style={{ background: data.missing ? 'transparent' : nodeFill(data.kind) }}
      title={data.missing ? `Does not exist${data.missingReason ? `: ${data.missingReason}` : ''}` : undefined}>
      <TableHandles split={split} />
      <div className="tbl-name">
        <LateDot facts={data.facts} />
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
          title={LEVEL_TITLE[level]}
          aria-pressed={level !== 'none'}
          onClick={(e) => {
            e.stopPropagation()
            actions.cycleColumns(id)
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {LEVEL_LABEL[level]}
        </button>
      )}
      <ColumnRows id={id} data={data} split={split} />
    </div>
  )
}
