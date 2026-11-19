// The logic that lives twice, in TypeScript here and in Python for agents, run on the same JSON fixtures as tests/test_parity.py.
// The Python side is named in the comment above each runner; a fixture's `expected` is what both sides must give.
import { describe, expect, it } from 'vitest'
import type { GraphEdge, Relationship } from './api/types'
import { collapseGraph, parseGrouping } from './graph/collapse'
import { DEFAULT_FILTERS } from './graph/graphStore'
import { FAMILY_OF, familyOf } from './graph/edgeStyles'
import { pictureLegend } from './graph/exportPicture'
import { estimateSize, layoutGraph, type LayoutEdge, type LayoutNode } from './graph/layout'
import { presetFilters, rolesOf } from './graph/lens'
import { toGraphEdges } from './graph/relationships'
import type { FlowEdge, FlowNode } from './graph/types'

interface Case {
  name: string
  input: Record<string, any>
  expected?: any
}
const files = import.meta.glob('../../tests/fixtures/parity/*.json', { eager: true, import: 'default' }) as Record<string, { cases: Case[] }>
const fixture = (stem: string): Case[] => {
  const found = Object.entries(files).find(([path]) => path.endsWith('/' + stem + '.json'))
  if (!found) throw new Error('no parity fixture ' + stem)
  return found[1].cases
}

/** Without nulls and undefined, floats to one decimal: the two languages leave different things unset. */
function clean(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(clean)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null && x !== undefined).map(([k, x]) => [k, clean(x)]))
  return typeof v === 'number' ? Math.round(v * 10) / 10 : v
}

type Sizes = Record<string, [number, number]>
const layoutNodes = (sizes: Sizes, focus?: string | null): LayoutNode[] =>
  Object.entries(sizes).map(([id, [width, height]]) => ({ id, width, height, focus: id === focus, x: 0, y: 0 }))
const layoutEdges = (edges: Array<{ source: string; target: string; kind: string }>): LayoutEdge[] => edges.map(({ source, target, kind }) => ({ source, target, kind }))

/** The rules of a layout that do not hold: overlaps, and the spec's left_of and below pairs. The same function is in tests/test_parity.py. */
function brokenRules(positions: Map<string, { x: number; y: number }>, sizes: Sizes, spec: { left_of?: string[][]; below?: string[][] }): string[] {
  const box = (id: string) => ({ l: positions.get(id)!.x, t: positions.get(id)!.y, r: positions.get(id)!.x + sizes[id][0], b: positions.get(id)!.y + sizes[id][1] })
  const ids = Object.keys(sizes)
  const out: string[] = []
  for (const a of ids) for (const b of ids) if (a < b && box(a).l < box(b).r && box(b).l < box(a).r && box(a).t < box(b).b && box(b).t < box(a).b) out.push(`${a} overlaps ${b}`)
  for (const [a, b] of spec.left_of ?? []) if (box(a).r > box(b).l) out.push(`${a} is not left of ${b}`)
  for (const [a, b] of spec.below ?? []) if (box(a).t < box(b).b) out.push(`${a} is not below ${b}`)
  return out
}

const SHARED_LEGEND = new Set(['data flows', 'key reference', 'dashed: inferred or proposed', 'ends: || exactly one, o| zero or one, o< zero or more'])
const node = (id: string, extra: Record<string, unknown> = {}): FlowNode => {
  const parts = id.split('.')
  return { id, type: 'table', position: { x: 0, y: 0 }, data: { name: parts[parts.length - 1], schema: parts.slice(0, -1).join('.'), kind: 'table', focus: false, selfRef: false, ...extra } } as FlowNode
}
const flowEdge = (info: GraphEdge): FlowEdge => ({ id: info.id, source: info.source, target: info.target, data: { info } })

describe('parity with the Python twins', () => {
  // graphs.graph_edges
  it.each(fixture('graph_edges'))('graph edges: $name', ({ input, expected }) => {
    expect(clean(toGraphEdges(input.relationships as Relationship[]))).toEqual(expected)
  })

  // edge_families.family_of
  it.each(fixture('edge_families'))('edge families: $name', ({ input, expected }) => {
    expect(clean(Object.fromEntries((input.kinds as string[]).map((k) => [k, familyOf(k as GraphEdge['kind']) ?? null])))).toEqual(clean(expected))
    expect(Object.keys(FAMILY_OF).sort()).toEqual([...input.kinds].sort()) // a kind added to the page is added to the fixture, and so to Python
  })

  // graph_lens.roles
  it.each(fixture('roles'))('roles: $name', ({ input, expected }) => {
    expect(clean(Object.fromEntries(rolesOf(input.ids, input.edges)))).toEqual(expected)
  })

  // graph_lens.model_layout
  it.each(fixture('model_layout'))('model layout: $name', async ({ input, expected }) => {
    const positions = (await layoutGraph(layoutNodes(input.sizes), layoutEdges(input.edges), { lens: 'model' })).positions
    const left = Math.min(...[...positions.values()].map((p) => p.x))
    const top = Math.min(...[...positions.values()].map((p) => p.y))
    expect(clean(Object.fromEntries([...positions].map(([id, p]) => [id, [p.x - left, p.y - top]])))).toEqual(expected)
  })

  // graphs.estimate_size
  it.each(fixture('estimate_size'))('size estimate: $name', ({ input, expected }) => {
    const s = estimateSize(input.lines)
    expect([s.width, s.height]).toEqual(expected)
  })

  // graph_export.legend (lens flow is the page's All lens)
  it.each(fixture('legend'))('legend: $name', ({ input, expected }) => {
    const edges = input.edges as GraphEdge[]
    const ids = [...new Set(edges.flatMap((e) => [e.source, e.target]))]
    const items = pictureLegend({
      edges,
      filters: { ...DEFAULT_FILTERS, ...presetFilters(input.lens === 'model' ? 'model' : 'all') },
      ends: input.cards,
      nodes: ids.map((id) => node(id)),
      colorBy: 'type',
      colors: null,
    })
    expect(items.map((i) => i.text).filter((t) => SHARED_LEGEND.has(t))).toEqual(expected)
  })

  // graph_collapse.plan
  it.each(fixture('collapse'))('collapse: $name', ({ input, expected }) => {
    const nodes = (input.nodes as Array<{ id: string; kind: string; focus?: boolean; pinned?: boolean }>).map((n) => node(n.id, { kind: n.kind, focus: !!n.focus, ...(n.pinned ? { pinned: true } : {}) }))
    const view = collapseGraph({
      nodes,
      edges: (input.edges as GraphEdge[]).map(flowEdge),
      filters: DEFAULT_FILTERS,
      grouping: parseGrouping(input.grouping),
      groupTags: input.tags ?? {},
    })
    expect(
      clean({
        groups: view.groups.map((g) => ({ key: g.key, label: g.label, tables: g.members, collapsed: g.collapsed, default_collapsed: g.defaultCollapsed })),
        chains: view.chains.filter((c) => c.elided).map((c) => ({ id: c.id, source: c.source, target: c.target, views: c.views, edges: c.edges })),
      }),
    ).toEqual(expected)
  })

  // graphs.layout_positions (ELK here, so the rules and not the positions are shared)
  it.each(fixture('flow_layout'))('flow layout: $name', async ({ input, expected }) => {
    const positions = (await layoutGraph(layoutNodes(input.sizes, input.focus), layoutEdges(input.edges))).positions
    expect(brokenRules(positions, input.sizes, expected ?? {})).toEqual([])
  })
})
