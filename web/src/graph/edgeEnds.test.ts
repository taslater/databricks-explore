import { Position } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import type { Cardinality, GraphEdge } from '../api/types'
import { endCandidates, hasEnds, marksOf, rotationFor, withCardinality } from './EdgeEnds'
import type { FlowEdge } from './types'

const edge = (info: Partial<GraphEdge> & Pick<GraphEdge, 'id' | 'kind'>): FlowEdge => ({
  id: info.id,
  source: 'a.b.orders',
  target: 'a.b.customers',
  data: { info: { source: 'a.b.orders', target: 'a.b.customers', ...info } },
})
const one: Cardinality = { source: { end: 'zero_many', basis: 'constraint', why: '' }, target: { end: 'one', basis: 'constraint', why: '' }, sentence: 's' }

describe("crow's-foot ends", () => {
  it('draws each end with the marks the ERD convention gives it', () => {
    const kinds = (end: Parameters<typeof marksOf>[0]) => marksOf(end).map((m) => Object.keys(m)[0])
    expect(kinds('one')).toEqual(['bar', 'bar'])
    expect(kinds('zero_one')).toEqual(['bar', 'ring'])
    expect(kinds('one_many')).toEqual(['foot', 'bar'])
    expect(kinds('zero_many')).toEqual(['foot', 'ring'])
  })

  it('turns a glyph so it runs away from the side of the node it sits on', () => {
    expect([Position.Right, Position.Left, Position.Bottom, Position.Top].map(rotationFor)).toEqual([0, 180, 90, -90])
  })

  it('asks about table-level reference edges only', () => {
    const edges = [
      edge({ id: 'fk', kind: 'fk' }),
      edge({ id: 'mined', kind: 'join_mined' }),
      edge({ id: 'lineage', kind: 'lineage' }),
      edge({ id: 'col', kind: 'join_mined', source_column: 'x', target_column: 'y' }),
      edge({ id: 'ph', kind: 'manual', target: 'ph:1234' }),
    ]
    expect(endCandidates(edges).map((e) => e.id)).toEqual(['fk', 'mined'])
  })

  it('puts the answer on the edge, falling back to what an agent saved, and leaves unknown edges plain', () => {
    const saved = edge({ id: 'saved', kind: 'fk', cardinality: one })
    const asked = edge({ id: 'asked', kind: 'fk' })
    const plain = edge({ id: 'plain', kind: 'join_mined' })
    const out = withCardinality([saved, asked, plain], { asked: one, plain: null })
    expect(out.map((e) => e.data!.cardinality?.target?.end)).toEqual(['one', 'one', undefined])
    expect(withCardinality([asked], undefined)[0].data!.cardinality).toBeUndefined()
  })

  it('explains the ends in the legend only when some edge has one', () => {
    expect(hasEnds(undefined)).toBe(false)
    expect(hasEnds({ a: null, b: { source: null, target: null, sentence: '' } })).toBe(false)
    expect(hasEnds({ a: one })).toBe(true)
  })
})
