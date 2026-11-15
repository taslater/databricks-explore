import { describe, expect, it } from 'vitest'
import type { CanvasConnector, GraphEdge } from '../api/types'
import { DEFAULT_FILTERS } from './graphStore'
import { edgeShown } from './derive'
import { layeredPositions, lineagePath, pathConnectors, planSend, sendSummary } from './sendSelection'

function edge(kind: GraphEdge['kind'], source: string, target: string, extra: Partial<GraphEdge> = {}): GraphEdge {
  return { id: `${kind}:${source}->${target}`, kind, source, target, ...extra }
}

const CHAIN = [edge('lineage', 'a', 'b'), edge('lineage', 'b', 'c'), edge('view_dep', 'c', 'd'), edge('lineage', 'd', 'e')]

describe('lineagePath', () => {
  it('follows lineage and view dependencies downstream, nearest first', () => {
    const p = lineagePath('b', 'downstream', CHAIN)
    expect(p.tables).toEqual(['b', 'c', 'd', 'e'])
    expect(p.edges.map((e) => e.id)).toEqual(['lineage:b->c', 'view_dep:c->d', 'lineage:d->e'])
  })
  it('follows them upstream', () => {
    expect(lineagePath('c', 'upstream', CHAIN).tables).toEqual(['c', 'b', 'a'])
  })
  it('ignores other kinds and self loops', () => {
    const edges = [edge('fk', 'a', 'b'), edge('join_mined', 'a', 'c'), edge('lineage', 'a', 'a'), edge('lineage', 'a', 'd')]
    expect(lineagePath('a', 'downstream', edges).tables).toEqual(['a', 'd'])
  })
  it('ends on a cycle and lists each edge once', () => {
    const edges = [edge('lineage', 'a', 'b'), edge('lineage', 'b', 'c'), edge('lineage', 'c', 'a')]
    const p = lineagePath('a', 'downstream', edges)
    expect(p.tables).toEqual(['a', 'b', 'c'])
    expect(p.edges).toHaveLength(3)
  })
  it('leads either way along an edge lineage saw both ways', () => {
    const edges = [edge('lineage', 'a', 'b', { bidir: true })]
    expect(lineagePath('b', 'downstream', edges).tables).toEqual(['b', 'a'])
    expect(lineagePath('a', 'upstream', edges).tables).toEqual(['a', 'b'])
  })
  it('is just the start when nothing leads away', () => {
    expect(lineagePath('e', 'downstream', CHAIN)).toEqual({ tables: ['e'], edges: [] })
  })
  it('walks only the edges the filters show', () => {
    const hidden = edge('lineage', 'b', 'c', { status: 'rejected' })
    const shown = [CHAIN[0], hidden, CHAIN[2]].filter((e) => edgeShown(e, DEFAULT_FILTERS, 7, Date.now()))
    expect(lineagePath('a', 'downstream', shown).tables).toEqual(['a', 'b'])
    const noLineage = CHAIN.filter((e) => edgeShown(e, { ...DEFAULT_FILTERS, lineage: false }, 7, Date.now()))
    expect(lineagePath('c', 'downstream', noLineage).tables).toEqual(['c', 'd'])
  })
})

describe('pathConnectors', () => {
  it('draws one connector per pair, labeled lineage or view (view wins), source to target', () => {
    const out = pathConnectors([
      edge('lineage', 'a', 'b'),
      edge('view_dep', 'a', 'b'),
      edge('lineage', 'b', 'c'),
      edge('lineage', 'c', 'b'),
      edge('fk', 'x', 'y'),
    ])
    expect(out.map((c) => [c.source, c.target, c.label, c.bidir, c.kinds])).toEqual([
      ['a', 'b', 'view', false, ['view_dep', 'lineage']],
      ['b', 'c', 'lineage', true, ['lineage']],
    ])
    expect(out.every((c) => c.directed && !c.proposed)).toBe(true)
  })
})

describe('layeredPositions', () => {
  const box = (id: string) => ({ id, w: 100, h: 60 })
  it('puts sources left of the tables built from them, one column per hop', () => {
    const pos = layeredPositions([box('c'), box('a'), box('b')], [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ])
    expect(pos.get('a')!.x).toBeLessThan(pos.get('b')!.x)
    expect(pos.get('b')!.x).toBeLessThan(pos.get('c')!.x)
    expect(pos.get('a')).toEqual({ x: 0, y: 0 })
  })
  it('puts a diamond in three columns without overlap', () => {
    const boxes = ['a', 'b', 'c', 'd'].map(box)
    const pos = layeredPositions(boxes, [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c' },
      { source: 'b', target: 'd' },
      { source: 'c', target: 'd' },
    ])
    expect(new Set([...pos.values()].map((p) => p.x)).size).toBe(3)
    const b = pos.get('b')!
    const c = pos.get('c')!
    expect(Math.abs(b.y - c.y)).toBeGreaterThanOrEqual(60)
  })
  it('survives a cycle and ignores unknown ends and duplicates', () => {
    const pos = layeredPositions([box('a'), box('b')], [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
      { source: 'a', target: 'zz' },
      { source: 'a', target: 'b' },
    ])
    expect(pos.size).toBe(2)
    expect(pos.get('a')!.x).not.toBe(pos.get('b')!.x)
  })
  it('stacks boxes with no connectors in one column, and is deterministic', () => {
    const boxes = [box('a'), box('b'), box('c')]
    const one = layeredPositions(boxes, [])
    expect(new Set([...one.values()].map((p) => p.x))).toEqual(new Set([0]))
    expect([...one.values()].map((p) => p.y)).toEqual([...new Set([...one.values()].map((p) => p.y))])
    expect(layeredPositions(boxes, [])).toEqual(one)
    expect(layeredPositions([], []).size).toBe(0)
  })
})

describe('planSend', () => {
  const conn = (source: string, target: string, label = 'lineage'): CanvasConnector => ({
    source,
    target,
    label,
    directed: true,
    proposed: false,
    bidir: false,
    kinds: ['lineage'],
  })
  const size = { w: 320, h: 300 }

  it('adds a card for each new table, laid out left to right from the origin, with the connectors among them', () => {
    const plan = planSend(['x.y.b', 'x.y.a', 'x.y.c'], new Set(), [conn('x.y.a', 'x.y.b'), conn('x.y.b', 'x.y.c'), conn('x.y.c', 'x.y.other')], { x: 1000, y: 50 }, size)
    const at = Object.fromEntries(plan.cards.map((c) => [c.table, c.position]))
    expect(at['x.y.a']).toEqual({ x: 1000, y: 50 })
    expect(at['x.y.b'].x).toBe(1000 + 320 + 80)
    expect(at['x.y.c'].x).toBe(1000 + 2 * (320 + 80))
    expect(plan.links.map((l) => `${l.source}>${l.target}`)).toEqual(['x.y.a>x.y.b', 'x.y.b>x.y.c'])
    expect(plan.existing).toEqual([])
  })
  it('skips tables that already have a card but still connects to them', () => {
    const plan = planSend(['x.y.a', 'X.Y.B'], new Set(['x.y.b']), [conn('x.y.a', 'x.y.b')], { x: 0, y: 0 }, size)
    expect(plan.cards.map((c) => c.table)).toEqual(['x.y.a'])
    expect(plan.existing).toEqual(['X.Y.B'])
    expect(plan.links).toHaveLength(1)
  })
  it('counts a table named twice once', () => {
    const plan = planSend(['x.y.a', 'X.Y.A'], new Set(), [], { x: 0, y: 0 }, size)
    expect(plan.cards).toHaveLength(1)
  })
})

describe('sendSummary', () => {
  const plan = (cards: number, existing: number) => ({
    cards: Array.from({ length: cards }, (_, i) => ({ table: `t${i}`, position: { x: 0, y: 0 } })),
    links: [],
    existing: Array.from({ length: existing }, (_, i) => `e${i}`),
  })
  it('says what was sent', () => {
    expect(sendSummary(plan(1, 0), 0)).toBe('Sent 1 table to the canvas')
    expect(sendSummary(plan(4, 1), 3)).toBe('Sent 4 tables to the canvas with 3 connectors (1 already there)')
    expect(sendSummary(plan(2, 0), 1, { proposed: 2 })).toBe('Sent 2 tables to the canvas with 1 connector (2 proposed joins not drawn)')
  })
  it('says so when nothing was new', () => {
    expect(sendSummary(plan(0, 1), 0)).toBe('That table is already on the canvas')
    expect(sendSummary(plan(0, 3), 2)).toBe('All 3 tables are already on the canvas; added 2 connectors')
  })
})
