import { Position } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import type { EdgeTransform, TransformsAnswer } from '../api/edgeTransforms'
import { glyphSpot, glyphTitle, howLines, isPassThrough, joinKeyText, transformCandidates, withTransforms } from './transformText'
import type { FlowEdge } from './types'

const blank: EdgeTransform = {
  driving: false, joined: null, union: null, filters: [], aggregate: null, dedupe: null, distinct: false, window: false, pivot: false,
  merge: null, glyphs: [], statement: 'select',
}
const t = (over: Partial<EdgeTransform>): EdgeTransform => ({ ...blank, ...over })
const edge = (id: string, source: string, target: string, kind: string, extra: object = {}): FlowEdge =>
  ({ id, source, target, data: { info: { id, source, target, kind, status: 'derived', ...extra } } }) as unknown as FlowEdge

describe('which edges are asked about', () => {
  it('takes table-level, one-way flow edges between real tables', () => {
    const edges = [
      edge('v', 'a.b.x', 'a.b.y', 'view_dep'),
      edge('l', 'a.b.x', 'a.b.z', 'lineage'),
      edge('fk', 'a.b.x', 'a.b.y', 'fk'),
      edge('col', 'a.b.x', 'a.b.y', 'lineage', { source_column: 'c' }),
      edge('both', 'a.b.x', 'a.b.y', 'lineage', { bidir: true }),
      edge('ph', 'ph:1', 'a.b.y', 'lineage'),
      edge('undirected', 'a.b.x', 'a.b.y', 'lineage', { directed: false }),
    ]
    expect(transformCandidates(edges)).toEqual([
      { id: 'v', source: 'a.b.x', target: 'a.b.y' },
      { id: 'l', source: 'a.b.x', target: 'a.b.z' },
    ])
  })
  it('leaves out an edge that no longer holds', () => {
    const gone = { ...edge('s', 'a.b.x', 'a.b.y', 'lineage'), data: { ...edge('s', 'a.b.x', 'a.b.y', 'lineage').data!, superseded: true } } as FlowEdge
    expect(transformCandidates([gone])).toEqual([])
  })
})

describe('drawing the answer', () => {
  const answer: TransformsAnswer = {
    edges: { a: { transform: t({ glyphs: ['aggregate'] }), note: null, error: null }, b: { transform: null, note: 'unread', error: null } },
    origins: {},
  }
  it('puts the transform on the edges that have one and nothing on the rest', () => {
    const [a, b, c] = [edge('a', 'x', 'y', 'view_dep'), edge('b', 'x', 'z', 'lineage'), edge('c', 'x', 'w', 'lineage')]
    const out = withTransforms([a, b, c], answer)
    expect(out[0].data?.transform?.glyphs).toEqual(['aggregate'])
    expect(out[1]).toBe(b)
    expect(out[2]).toBe(c)
    expect(withTransforms([a], undefined)).toEqual([a])
  })
  it('puts glyphs out from the target border, along the edge, on whichever side it enters', () => {
    expect(glyphSpot(100, 50, Position.Left, 0)).toEqual({ x: 70, y: 50 })
    expect(glyphSpot(100, 50, Position.Left, 1)).toEqual({ x: 48, y: 50 })
    expect(glyphSpot(100, 50, Position.Right, 0)).toEqual({ x: 130, y: 50 })
    expect(glyphSpot(100, 50, Position.Top, 0)).toEqual({ x: 100, y: 20 })
    expect(glyphSpot(100, 50, Position.Bottom, 0)).toEqual({ x: 100, y: 80 })
  })
})

describe('the words', () => {
  const customers = t({
    joined: { type: 'left', keys: [{ column: 'customer_id', other: 'demo_lake.silver.orders.customer_id' }] },
    aggregate: { keys: ['region'], functions: ['SUM', 'COUNT'], having: null },
    filters: [{ kind: 'where', sql: 'c.active' }],
    glyphs: ['aggregate', 'join'],
  })
  it('titles each glyph from the facts', () => {
    expect(glyphTitle('aggregate', customers)).toBe('Aggregates: groups by region (SUM, COUNT)')
    expect(glyphTitle('join', customers)).toBe('Left-joined in on customer_id = orders.customer_id')
    expect(glyphTitle('aggregate', t({ aggregate: { keys: [], functions: ['COUNT'], having: null } }))).toBe('Aggregates the whole table (COUNT)')
    expect(glyphTitle('union', t({ union: { branches: 3 } }))).toBe('One of 3 unioned queries')
    expect(glyphTitle('dedupe', t({ dedupe: { keys: ['k', 'j'] } }))).toBe('Keeps one row per k, j')
    expect(glyphTitle('dedupe', t({ distinct: true }))).toBe('Distinct rows only')
    expect(glyphTitle('filter', t({ filters: [{ kind: 'where', sql: 'a > 1' }] }))).toBe('Filtered: a > 1')
    expect(glyphTitle('filter', t({ filters: [{ kind: 'where', sql: 'a' }, { kind: 'anti', sql: 'b' }] }))).toBe('Filtered by 2 conditions')
  })
  it('keeps the last two parts of the other table in a join key', () => {
    expect(joinKeyText(customers.joined!)).toBe('customer_id = orders.customer_id')
    expect(joinKeyText({ type: 'inner', keys: [{ column: 'k', other: null }] })).toBe('k')
  })
  it('says what the query does with the source, one line each', () => {
    expect(howLines(customers)).toEqual(['Left-joined in on customer_id = orders.customer_id.', 'Aggregated: GROUP BY region (SUM, COUNT).'])
    expect(howLines(t({ driving: true, dedupe: { keys: ['k'] } }))).toEqual(['The table the query reads from (FROM).', 'Keeps one row per k (row_number() = 1).'])
    expect(howLines(t({ filters: [{ kind: 'semi', sql: 'EXISTS (...)' }] }))).toEqual(['Only decides which rows stay; none of its columns are in the result.'])
    expect(howLines(t({ driving: true, merge: { keys: ['id'], actions: ['update', 'insert'] } }))[1]).toBe('Merged into the target: update, insert on id.')
    expect(howLines(t({ driving: true, aggregate: { keys: ['a'], functions: [], having: 'n > 1' } }))).toContain('HAVING n > 1')
  })
  it('knows a pass-through from a transform', () => {
    expect(isPassThrough(t({ driving: true }))).toBe(true)
    expect(isPassThrough(t({ driving: true, distinct: true }))).toBe(false)
    expect(isPassThrough(customers)).toBe(false)
  })
})
