// Summarize before showing: a schema's tables collapse into one node, and a chain of pass-through views is drawn as one edge.
// Pure: collapseGraph reads the graph and the grouping and returns what to add to it and which nodes to hide.
import type { GraphEdge } from '../api/types'
import type { EdgeTransform, TransformsAnswer } from '../api/edgeTransforms'
import { edgeShown } from './derive'
import { familyOf, type EdgeFamily } from './edgeStyles'
import type { EdgeFilters, FlowEdge, FlowNode, GroupSummaryData, MergedEdge } from './types'

/** What the nodes are grouped by: their schema, a tag's value, or nothing. */
export type GroupBy = 'schema' | 'none' | `tag:${string}`

export interface Grouping {
  by: GroupBy
  /** Group key to collapsed (true) or expanded (false). A group not named here follows the default rule. */
  overrides: Record<string, boolean>
  /** Draw a chain of pass-through views as one edge. */
  chains: boolean
  /** Chains the person opened (by chain id). Not saved. */
  shownChains: string[]
}

export const DEFAULT_GROUPING: Grouping = { by: 'schema', overrides: {}, chains: true, shownChains: [] }
export const NO_GROUPING: Grouping = { by: 'none', overrides: {}, chains: false, shownChains: [] }

/** A group with more members than this starts collapsed, unless it holds the focus or a pinned node. */
export const MAX_OPEN = 8

/** The size of a collapsed group's node: fixed, so the layout knows it before React Flow has drawn it. */
export const SUMMARY_SIZE = { width: 176, height: 46 }

export const SUMMARY_PREFIX = 'summary:'
export const BOX_PREFIX = 'box:'
const MERGED_PREFIX = 'merged:'
const CHAIN_PREFIX = 'chain:'

export const isSummaryId = (id: string): boolean => id.startsWith(SUMMARY_PREFIX)
export const summaryId = (key: string): string => SUMMARY_PREFIX + key
export const isMergedEdgeId = (id: string): boolean => id.startsWith(MERGED_PREFIX) || id.startsWith(CHAIN_PREFIX)

/** The saved form of a graph's grouping (the `grouping` of a diagram), or undefined for the default. */
export interface SavedGrouping {
  by?: string
  collapsed?: string[]
  expanded?: string[]
  chains?: boolean
}

export function parseGrouping(v: unknown): Grouping {
  if (typeof v !== 'object' || v === null) return { ...DEFAULT_GROUPING }
  const s = v as SavedGrouping
  const by: GroupBy = s.by === 'none' ? 'none' : typeof s.by === 'string' && s.by.startsWith('tag:') && s.by.slice(4).trim() !== '' ? (s.by as GroupBy) : 'schema'
  const overrides: Record<string, boolean> = {}
  for (const k of Array.isArray(s.expanded) ? s.expanded : []) if (typeof k === 'string') overrides[k] = false
  for (const k of Array.isArray(s.collapsed) ? s.collapsed : []) if (typeof k === 'string') overrides[k] = true
  return { by, overrides, chains: s.chains !== false, shownChains: [] }
}

/** What a diagram saves of the grouping; undefined while it is the default. */
export function groupingBody(g: Grouping): SavedGrouping | undefined {
  const collapsed = Object.keys(g.overrides).filter((k) => g.overrides[k]).sort()
  const expanded = Object.keys(g.overrides).filter((k) => !g.overrides[k]).sort()
  const body: SavedGrouping = {
    ...(g.by !== 'schema' ? { by: g.by } : {}),
    ...(collapsed.length ? { collapsed } : {}),
    ...(expanded.length ? { expanded } : {}),
    ...(!g.chains ? { chains: false } : {}),
  }
  return Object.keys(body).length > 0 ? body : undefined
}

/** The grouping as text, to tell whether the person changed it since the graph was saved. */
export const groupingSignature = (g: Grouping): string => JSON.stringify(groupingBody(g) ?? null)

export interface GroupInfo {
  key: string
  label: string
  /** The nodes the group holds: shown under the current filters, and not an elided view. */
  members: string[]
  collapsed: boolean
  /** Whether the group is collapsed by the default rule (the saved choice can differ). */
  defaultCollapsed: boolean
  /** Drawn as a box around its members: expanded, with two or more in the flow. */
  boxed: boolean
  noun: string
}

export interface ChainInfo {
  id: string
  source: string
  target: string
  /** The pass-through views, in order from source to target. */
  views: string[]
  /** The flow edges of the chain, in order. */
  edges: string[]
  /** Left out of the drawing (the person has not opened it). */
  elided: boolean
}

export interface CollapseInput {
  nodes: FlowNode[]
  edges: FlowEdge[]
  filters: EdgeFilters
  grouping: Grouping
  /** The tag value of each node, for grouping by tag. */
  groupTags?: Record<string, string>
  /** Where each collapsed group's node is (key to top-left). */
  groupPositions?: Record<string, { x: number; y: number }>
}

export interface CollapseView {
  /** The nodes and edges to draw: what the graph holds, plus a node for each collapsed group and an edge for each merge. */
  nodes: FlowNode[]
  edges: FlowEdge[]
  /** Nodes the drawing leaves out: the members of collapsed groups and the views of elided chains. */
  hidden: Set<string>
  groups: GroupInfo[]
  chains: ChainInfo[]
  /** The group of each node drawn inside a box (the layout keeps them together). */
  boxOf: Map<string, string>
}

const VIEW_KINDS = new Set(['view', 'materialized_view'])
const isFlow = (kind: GraphEdge['kind']): boolean => familyOf(kind) === 'flow'

/** The key a node is grouped under, or null when it belongs to no group (a missing object, a placeholder, a table without the tag). */
export function groupKeyOf(n: FlowNode, by: GroupBy, tags: Record<string, string> = {}): string | null {
  if (by === 'none' || n.data.missing || n.id.startsWith('ph:')) return null
  if (by === 'schema') return n.data.schema
  return tags[n.id] || null
}

/** "bronze" for demo_lake.bronze, unless two groups would then share a name. */
function labelsOf(keys: string[], by: GroupBy): Map<string, string> {
  const short = (k: string) => (by === 'schema' ? (k.split('.').pop() ?? k) : k)
  const count = new Map<string, number>()
  for (const k of keys) count.set(short(k), (count.get(short(k)) ?? 0) + 1)
  return new Map(keys.map((k) => [k, (count.get(short(k)) ?? 0) > 1 ? k : short(k)]))
}

const nounOf = (nodes: FlowNode[]): string => (nodes.every((n) => ['table', 'managed', 'external', 'foreign'].includes(n.data.kind)) ? 'table' : 'object')
export const countText = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

/** What the transforms of several edges add up to: the first join, aggregate, union and dedupe found, every filter, and the glyphs of all. */
export function mergeTransforms(list: EdgeTransform[]): EdgeTransform | undefined {
  if (list.length === 0) return undefined
  const first = <K extends 'joined' | 'union' | 'aggregate' | 'dedupe' | 'merge'>(k: K): EdgeTransform[K] => (list.find((t) => t[k])?.[k] ?? null) as EdgeTransform[K]
  const order = ['aggregate', 'join', 'union', 'dedupe', 'filter'] as const
  const glyphs = order.filter((g) => list.some((t) => t.glyphs.includes(g)))
  return {
    driving: false,
    joined: first('joined'),
    union: first('union'),
    filters: list.flatMap((t) => t.filters),
    aggregate: first('aggregate'),
    dedupe: first('dedupe'),
    distinct: list.some((t) => t.distinct),
    window: list.some((t) => t.window),
    pivot: list.some((t) => t.pivot),
    merge: first('merge'),
    glyphs: glyphs.slice(0, 3),
    statement: list[list.length - 1].statement,
  }
}

/** The edges that stand for others (a chain of views, or a group's edges) with the transforms of the edges they stand for, when those are known. */
export function withMergedTransforms(edges: FlowEdge[], answer: TransformsAnswer | undefined): FlowEdge[] {
  if (!answer) return edges
  return edges.map((e) => {
    const m = e.data?.merged
    if (!m || (m.count > 1 && m.views === 0)) return e
    const found = m.parts.map((id) => answer.edges[id]?.transform).filter((t): t is EdgeTransform => !!t)
    const t = mergeTransforms(found)
    return t && t.glyphs.length > 0 ? { ...e, data: { ...e.data!, transform: t } } : e
  })
}

interface Logical {
  source: string
  target: string
  kind: GraphEdge['kind']
  info: GraphEdge
  parts: string[]
  views: string[]
  chain?: string
  remapped: boolean
}

/** Pass-through chains: views and materialized views with one flow edge in, one out and nothing else, strung together. */
function findChains(nodes: FlowNode[], shown: FlowEdge[], visible: Set<string>, grouping: Grouping): ChainInfo[] {
  if (!grouping.chains) return []
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const touching = new Map<string, FlowEdge[]>()
  for (const e of shown) for (const id of new Set([e.source, e.target])) touching.set(id, [...(touching.get(id) ?? []), e])
  const ends = new Map<string, { in: FlowEdge; out: FlowEdge }>()
  for (const n of nodes) {
    const d = n.data
    if (!VIEW_KINDS.has(d.kind) || d.focus || d.pinned || d.missing || d.showColumns || d.selfRef || !visible.has(n.id)) continue
    const mine = touching.get(n.id) ?? []
    if (mine.length !== 2) continue
    const into = mine.filter((e) => e.target === n.id && e.source !== n.id)
    const out = mine.filter((e) => e.source === n.id && e.target !== n.id)
    const plain = (e: FlowEdge) => isFlow(e.data!.info.kind) && e.data!.info.directed !== false && !e.data!.info.bidir
    if (into.length === 1 && out.length === 1 && plain(into[0]) && plain(out[0])) ends.set(n.id, { in: into[0], out: out[0] })
  }
  const direct = new Set(shown.filter((e) => isFlow(e.data!.info.kind)).map((e) => `${e.source}|${e.target}`))
  const chains: ChainInfo[] = []
  for (const [head, link] of ends) {
    if (ends.has(link.in.source)) continue // not the first view of its chain
    const views: string[] = []
    const edges = [link.in.id]
    let cur = head
    for (;;) {
      if (views.includes(cur)) break
      views.push(cur)
      const out = ends.get(cur)!.out
      edges.push(out.id)
      cur = out.target
      if (!ends.has(cur)) break
    }
    if (ends.has(cur)) continue // a ring of views
    const source = link.in.source
    if (source === cur || direct.has(`${source}|${cur}`) || !byId.has(cur)) continue
    const id = CHAIN_PREFIX + edges[0]
    chains.push({ id, source, target: cur, views, edges, elided: !grouping.shownChains.includes(id) })
  }
  return chains
}

/**
 * The graph with its collapsed groups and elided chains: the nodes and edges to draw (the original ones stay, so the
 * filters see them as before), the nodes to hide, and what each group and chain is. Counts follow the filters.
 */
export function collapseGraph(input: CollapseInput): CollapseView {
  const { nodes, edges, filters, grouping } = input
  const none: CollapseView = { nodes, edges, hidden: new Set(), groups: [], chains: [], boxOf: new Map() }
  if (grouping.by === 'none' && !grouping.chains) return none

  // Which nodes the filters leave on the graph (the same rule as deriveFlow's).
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const anyEdge = new Set<string>()
  const shownEdge = new Set<string>()
  const shown: FlowEdge[] = []
  for (const e of edges) {
    anyEdge.add(e.source).add(e.target)
    if (edgeShown(e.data!.info, filters)) {
      shown.push(e)
      shownEdge.add(e.source).add(e.target)
    }
  }
  const visible = new Set(nodes.filter((n) => n.data.focus || n.data.pinned || !anyEdge.has(n.id) || shownEdge.has(n.id)).map((n) => n.id))

  const chains = findChains(nodes, shown.filter((e) => byId.has(e.source) && byId.has(e.target)), visible, grouping)
  const elidedViews = new Set(chains.filter((c) => c.elided).flatMap((c) => c.views))

  // Groups.
  const tags = input.groupTags ?? {}
  const keyed = new Map<string, FlowNode[]>()
  if (grouping.by !== 'none') {
    for (const n of nodes) {
      const key = visible.has(n.id) && !elidedViews.has(n.id) ? groupKeyOf(n, grouping.by, tags) : null
      if (key !== null) keyed.set(key, [...(keyed.get(key) ?? []), n])
    }
  }
  // A graph in one group has nothing to summarize; a group of one is just a node.
  const active = keyed.size >= 2
  const names = labelsOf([...keyed.keys()], grouping.by)
  const groups: GroupInfo[] = []
  if (active) {
    for (const [key, members] of keyed) {
      if (members.length < 2) continue
      const defaultCollapsed = members.length > MAX_OPEN && !members.some((n) => n.data.focus || n.data.pinned)
      groups.push({ key, label: names.get(key) ?? key, members: members.map((n) => n.id), collapsed: grouping.overrides[key] ?? defaultCollapsed, defaultCollapsed, boxed: false, noun: nounOf(members) })
    }
  }
  const collapsedOf = new Map<string, string>() // member id to group key
  for (const g of groups) if (g.collapsed) for (const id of g.members) collapsedOf.set(id, g.key)
  const hidden = new Set<string>([...elidedViews, ...collapsedOf.keys()])

  // The edges: chains replace their views' edges, collapsed groups take their members' edges. Parallel ones merge per family.
  const inChain = new Set(chains.filter((c) => c.elided).flatMap((c) => c.edges))
  const logical: Logical[] = []
  for (const e of shown) {
    if (inChain.has(e.id) || !byId.has(e.source) || !byId.has(e.target)) continue
    const info = e.data!.info
    logical.push({ source: e.source, target: e.target, kind: info.kind, info, parts: [e.id], views: [], remapped: false })
  }
  const infoOf = new Map(edges.map((e) => [e.id, e.data!.info]))
  for (const c of chains.filter((c) => c.elided)) {
    const info = infoOf.get(c.edges[0])!
    logical.push({ source: c.source, target: c.target, kind: info.kind, info, parts: c.edges, views: c.views, chain: c.id, remapped: false })
  }
  const rep = (id: string) => (collapsedOf.has(id) ? summaryId(collapsedOf.get(id)!) : id)
  const merged = new Map<string, Logical[]>()
  for (const l of logical) {
    const source = rep(l.source)
    const target = rep(l.target)
    const remapped = source !== l.source || target !== l.target
    if (remapped && source === target) continue // inside one collapsed group
    const family: EdgeFamily = familyOf(l.kind)
    const key = `${source}|${target}|${family}`
    merged.set(key, [...(merged.get(key) ?? []), { ...l, source, target, remapped }])
  }
  const outEdges: FlowEdge[] = []
  for (const [key, list] of merged) {
    const one = list[0]
    if (list.length === 1 && !one.remapped && !one.chain) continue // untouched: the original edge draws it
    const parts = list.flatMap((l) => l.parts)
    const views = list.reduce((n, l) => n + l.views.length, 0)
    const id = list.length === 1 && one.chain ? one.chain : MERGED_PREFIX + key
    const statuses = new Set(list.map((l) => l.info.status))
    const info: GraphEdge = {
      id,
      source: one.source,
      target: one.target,
      kind: one.kind,
      ...(statuses.size === 1 && one.info.status ? { status: one.info.status } : {}),
      ...(one.info.directed === false ? { directed: false } : {}),
      ...(list.length === 1 && one.info.bidir ? { bidir: true } : {}),
    }
    const mergedData: MergedEdge = { parts, count: list.length, views, ...(list.length === 1 && one.chain ? { chain: one.chain, viaNodes: one.views } : {}) }
    outEdges.push({ id, source: one.source, target: one.target, data: { info, merged: mergedData } })
  }

  // The node of each collapsed group.
  const summaries: FlowNode[] = groups
    .filter((g) => g.collapsed)
    .map((g) => {
      const summary: GroupSummaryData = { key: g.key, label: g.label, count: g.members.length, noun: g.noun }
      return {
        id: summaryId(g.key),
        type: 'table',
        position: input.groupPositions?.[g.key] ?? { x: 0, y: 0 },
        measured: { ...SUMMARY_SIZE },
        data: { name: g.label, schema: g.key, kind: 'group', focus: false, selfRef: false, summary },
      } as FlowNode
    })

  // Boxes: expanded groups with two or more members in the flow (a node with only references hangs below, outside the box).
  const live = (id: string) => !hidden.has(id)
  const layoutEdges = [...edges, ...outEdges].filter((e) => live(e.source) && live(e.target))
  const hasFlow = new Set<string>()
  const anyLive = new Set<string>()
  for (const e of layoutEdges) {
    anyLive.add(e.source).add(e.target)
    if (isFlow(e.data!.info.kind)) hasFlow.add(e.source).add(e.target)
  }
  const boxOf = new Map<string, string>()
  for (const g of groups) {
    if (g.collapsed) continue
    const inFlow = g.members.filter((id) => {
      const d = byId.get(id)!.data
      return d.focus || d.pinned || !anyLive.has(id) || hasFlow.has(id)
    })
    if (inFlow.length < 2) continue
    g.boxed = true
    for (const id of inFlow) boxOf.set(id, g.key)
  }

  return { nodes: [...nodes, ...summaries], edges: [...edges, ...outEdges], hidden, groups, chains, boxOf }
}
