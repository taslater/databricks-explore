// What the Graph draws for collapsing: a collapsed group's node, the box round an open group, and the pill on a merged edge.
import { EdgeLabelRenderer, type Node, type NodeProps } from '@xyflow/react'
import { countText, BOX_PREFIX, type CollapseView } from './collapse'
import { nodeSize } from './derive'
import { useGraphStore } from './graphStore'
import { TableHandles } from './TableHandles'
import type { FlowNode, MergedEdge } from './types'

/** Space round the nodes in a group's box: the top holds its name. The layout reserves the same (elkLayout.ts). */
const PAD = { top: 26, side: 14, bottom: 14 }

export type GroupBoxData = { key: string; label: string; count: number; noun: string }
export type GroupBoxFlowNode = Node<GroupBoxData, 'groupbox'>

const toggle = (key: string, collapsed: boolean) => useGraphStore.getState().setGroupCollapsed(key, collapsed)

/** The node of a collapsed group: "bronze · 14 tables". Click for its details, double-click or the arrow to open it. */
export function GroupSummary({ data, split }: { data: NonNullable<FlowNode['data']['summary']>; split: ReadonlySet<string> }) {
  const selected = useGraphStore((s) => s.selection?.kind === 'node' && s.selection.id === `summary:${data.key}`)
  return (
    <div className={`tbl-node group-summary${selected ? ' is-selected' : ''}`} data-testid={`group-summary-${data.key}`} title={`${data.key}: ${countText(data.count, data.noun)} collapsed. Double-click to open.`}>
      <TableHandles split={split} />
      <div className="tbl-name">
        <button className="group-toggle nodrag" aria-label={`Open ${data.label}`} onClick={(e) => { e.stopPropagation(); toggle(data.key, false) }} onDoubleClick={(e) => e.stopPropagation()}>
          ▸
        </button>
        {data.label} · {countText(data.count, data.noun)}
      </div>
    </div>
  )
}

/** The box round an open group, with its name and a button that collapses it. It never takes a click that is meant for the graph. */
export function GroupBoxNode({ data }: NodeProps<GroupBoxFlowNode>) {
  return (
    <div className="group-box" data-testid={`group-box-${data.key}`}>
      <button className="group-toggle nodrag" aria-label={`Collapse ${data.label}`} title={`Collapse ${data.key} to one node`} onClick={() => toggle(data.key, true)}>
        ▾
      </button>
      <span className="group-box-name">
        {data.label} · {countText(data.count, data.noun)}
      </span>
    </div>
  )
}

/** One box per open group, round the members that are drawn. */
export function groupBoxNodes(view: CollapseView, drawn: FlowNode[]): GroupBoxFlowNode[] {
  const byId = new Map(drawn.filter((n) => !n.hidden).map((n) => [n.id, n]))
  const out: GroupBoxFlowNode[] = []
  for (const g of view.groups) {
    if (!g.boxed) continue
    const members = [...view.boxOf].filter(([, key]) => key === g.key).map(([id]) => byId.get(id)).filter((n): n is FlowNode => !!n)
    if (members.length === 0) continue
    let left = Infinity
    let top = Infinity
    let right = -Infinity
    let bottom = -Infinity
    for (const n of members) {
      const size = nodeSize(n, null, undefined)
      left = Math.min(left, n.position.x)
      top = Math.min(top, n.position.y)
      right = Math.max(right, n.position.x + size.width)
      bottom = Math.max(bottom, n.position.y + size.height)
    }
    out.push({
      id: BOX_PREFIX + g.key,
      type: 'groupbox',
      position: { x: left - PAD.side, y: top - PAD.top },
      width: right - left + 2 * PAD.side,
      height: bottom - top + PAD.top + PAD.bottom,
      data: { key: g.key, label: g.label, count: g.members.length, noun: g.noun },
      selectable: false,
      draggable: false,
      focusable: false,
      zIndex: -1,
    })
  }
  return out
}

/** The pill on an edge that stands for others: "via 2 views" for a chain (click to draw them), "3 edges" for a group's. */
export function MergedEdgeLabel({ id, merged, x, y, faded }: { id: string; merged: MergedEdge; x: number; y: number; faded?: boolean }) {
  const chain = merged.chain !== undefined
  if (!chain && merged.count < 2) return null
  const text = chain ? `via ${countText(merged.views, 'view')}` : countText(merged.count, 'edge')
  const title = chain ? `${merged.viaNodes?.join(' → ')}. Click to draw them.` : `Stands for ${countText(merged.parts.length, 'edge')}. Click for the list.`
  return (
    <EdgeLabelRenderer>
      <button
        className="edge-glyph merged nodrag nopan"
        data-testid="edge-merged"
        style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`, opacity: faded ? 0.2 : 1 }}
        title={title}
        onClick={() => (chain ? useGraphStore.getState().showChain(merged.chain!) : useGraphStore.getState().setSelection({ kind: 'edge', id }))}
      >
        {text}
      </button>
    </EdgeLabelRenderer>
  )
}
