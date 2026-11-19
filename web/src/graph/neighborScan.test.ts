import { describe, expect, it } from 'vitest'
import { DEFAULT_FILTERS } from './graphStore'
import { neighborSet } from './neighbors'
import { unscanned, withNeighborCounts } from './neighborScan'
import type { FlowNode } from './types'

const node = (id: string, extra: Partial<FlowNode['data']> = {}): FlowNode => ({
  id,
  type: 'table',
  position: { x: 0, y: 0 },
  data: { name: id, schema: 'c.s', kind: 'table', focus: false, selfRef: false, ...extra },
})
const lineage = (source: string, target: string) => ({ id: `lineage:${source}<->${target}`, source, target, kind: 'lineage' as const })

describe('withNeighborCounts', () => {
  const set = neighborSet({ nodes: [], edges: [lineage('a', 'b'), lineage('b', 'c'), lineage('b', 'd')], errors: [] }, 'b')
  it('sets the counts on a node with neighbors off the graph and leaves the others alone', () => {
    const out = withNeighborCounts([node('b'), node('c'), node('z')], { b: set }, DEFAULT_FILTERS)
    expect(out[0].data.more).toEqual({ up: 1, down: 1 })
    expect(out[1].data.more).toBeUndefined()
    expect(out[2]).toBe(out[2])
  })
  it('sets nothing once everything is on the graph', () => {
    const nodes = ['a', 'b', 'c', 'd'].map((id) => node(id))
    expect(withNeighborCounts(nodes, { b: set }, DEFAULT_FILTERS)[1].data.more).toBeUndefined()
  })
})

describe('unscanned', () => {
  it('lists real tables whose neighbors have not been read, and skips placeholders and missing ones', () => {
    const nodes = [node('c.s.a'), node('c.s.b'), node('ph:1'), node('c.s.gone', { missing: true })]
    expect(unscanned(nodes, { 'c.s.a': { up: [], down: [] } })).toEqual(['c.s.b'])
  })
})
