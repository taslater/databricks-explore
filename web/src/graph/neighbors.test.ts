import { describe, expect, it } from 'vitest'
import type { GraphEdge, RelationsResponse } from '../api/types'
import { DEFAULT_FILTERS } from './graphStore'
import { collapsible, countMore, neighborSet, shownNeighbors, sliceOf } from './neighbors'

const edge = (source: string, target: string, extra: Partial<GraphEdge> = {}): GraphEdge => ({
  id: `lineage:${[source, target].sort().join('<->')}`,
  source,
  target,
  kind: 'lineage',
  ...extra,
})
const node = (id: string) => ({ id, label: id, kind: 'table' })
const resp = (edges: GraphEdge[]): RelationsResponse => ({
  nodes: [...new Set(edges.flatMap((e) => [e.source, e.target]))].map(node),
  edges,
  errors: [],
})

describe('neighborSet', () => {
  it('splits flow neighbors into upstream and downstream, and leaves keys and joins out', () => {
    const r = resp([edge('a', 'b'), edge('b', 'c'), { ...edge('b', 'd'), kind: 'fk', id: 'fk:b->d' }, edge('b', 'b')])
    const set = neighborSet(r, 'b')
    expect(set.up.map((n) => n.id)).toEqual(['a'])
    expect(set.down.map((n) => n.id)).toEqual(['c'])
  })
  it('counts a lineage edge seen both ways on both sides, and a view dependency as flow', () => {
    const set = neighborSet(resp([edge('a', 'b', { bidir: true }), edge('x', 'b', { kind: 'view_dep', id: 'view_dep:x->b' })]), 'b')
    expect(set.up.map((n) => n.id).sort()).toEqual(['a', 'x'])
    expect(set.down.map((n) => n.id)).toEqual(['a'])
  })
})

describe('countMore', () => {
  const set = neighborSet(resp([edge('a', 'b'), edge('z', 'b', { status: 'superseded' }), edge('b', 'c'), edge('b', 'd')]), 'b')
  it('counts the neighbors that are not on the graph, per side', () => {
    expect(countMore(set, new Set(['b', 'd']), { ...DEFAULT_FILTERS, showSuperseded: true })).toEqual({ up: 2, down: 1 })
  })
  it('follows the filters: superseded edges and switched-off kinds do not count', () => {
    expect(countMore(set, new Set(['b']), DEFAULT_FILTERS)).toEqual({ up: 1, down: 2 })
    expect(countMore(set, new Set(['b']), { ...DEFAULT_FILTERS, lineage: false })).toEqual({ up: 0, down: 0 })
    expect(shownNeighbors(set, 'up', DEFAULT_FILTERS).map((n) => n.id)).toEqual(['a'])
  })
  it('says nothing for a node with no neighbors left', () => {
    expect(countMore(set, new Set(['a', 'b', 'c', 'd', 'z']), DEFAULT_FILTERS)).toEqual({ up: 0, down: 0 })
  })
})

describe('sliceOf', () => {
  it('keeps only the wanted neighbors and the edges that reach them', () => {
    const r = resp([edge('a', 'b'), edge('b', 'c')])
    const set = neighborSet(r, 'b')
    const slice = sliceOf(r, set.down)
    expect(slice.nodes.map((n) => n.id)).toEqual(['c'])
    expect(slice.edges.map((e) => e.id)).toEqual([edge('b', 'c').id])
  })
})

describe('collapsible', () => {
  const link = (source: string, target: string) => ({ source, target })
  it('takes off what only the origin needed', () => {
    expect(collapsible(['c', 'd'], 'b', [link('b', 'c'), link('c', 'd')], new Set()).sort()).toEqual(['c', 'd'])
  })
  it('keeps a table another table on the graph still connects to, and what hangs off it', () => {
    const links = [link('b', 'c'), link('c', 'd'), link('x', 'c')]
    expect(collapsible(['c', 'd'], 'b', links, new Set())).toEqual([])
    // d stays for x, and c is on the way to it.
    expect(collapsible(['c', 'd'], 'b', [link('b', 'c'), link('c', 'd'), link('x', 'd')], new Set())).toEqual([])
    expect(collapsible(['c', 'd', 'e'], 'b', [link('b', 'c'), link('c', 'd'), link('x', 'd'), link('b', 'e')], new Set())).toEqual(['e'])
  })
  it('keeps the focus and pinned tables', () => {
    expect(collapsible(['c', 'd'], 'b', [link('b', 'c'), link('b', 'd')], new Set(['d']))).toEqual(['c'])
  })
})
