// The graph as drawn with its collapsed groups and elided chains (graph/collapse.ts), read from the store.
import { useEffect, useMemo } from 'react'
import { useNodeMeta } from '../api/nodeMeta'
import { collapseGraph, type CollapseView } from './collapse'
import { useGraphStore } from './graphStore'
import type { FlowNode } from './types'

/** `nodes` are the graph's nodes with anything the page adds to them (a column trace); the store's by default. */
export function useCollapseView(drawn?: FlowNode[]): CollapseView {
  const stored = useGraphStore((s) => s.nodes)
  const nodes = drawn ?? stored
  const edges = useGraphStore((s) => s.edges)
  const filters = useGraphStore((s) => s.filters)
  const grouping = useGraphStore((s) => s.grouping)
  const groupTags = useGraphStore((s) => s.groupTags)
  const groupPositions = useGraphStore((s) => s.groupPositions)
  return useMemo(() => collapseGraph({ nodes, edges, filters, grouping, groupTags, groupPositions }), [nodes, edges, filters, grouping, groupTags, groupPositions])
}

/** While the graph is grouped by a tag, keeps the store's tag value of each table up to date from the tags read so far. */
export function useGroupTags(): void {
  const by = useGraphStore((s) => s.grouping.by)
  const nodes = useGraphStore((s) => s.nodes)
  const current = useGraphStore((s) => s.groupTags)
  const ids = useMemo(() => nodes.filter((n) => !n.id.startsWith('ph:') && !n.data.missing).map((n) => n.id), [nodes])
  const meta = useNodeMeta(ids, by.startsWith('tag:')).data
  useEffect(() => {
    if (!by.startsWith('tag:')) return
    const key = by.slice(4)
    const next: Record<string, string> = {}
    for (const id of ids) {
      const v = meta?.[id]?.tags?.[key]
      if (v !== undefined) next[id] = v === '' ? '(set)' : v
    }
    if (JSON.stringify(next) !== JSON.stringify(current)) useGraphStore.getState().setGroupTags(next)
  }, [by, ids, meta, current])
}
