import { Position } from '@xyflow/react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Cardinality, GraphEdge, RelationshipProfile } from '../api/types'
import { OrphanTick } from './OrphanTick'
import { anyOrphans, hasOrphans, orphanText, percent, profilableEdges, tickPlace } from './relProfile'
import type { FlowEdge } from './types'

const edge = (info: Partial<GraphEdge> & Pick<GraphEdge, 'id' | 'kind'>): FlowEdge => ({
  id: info.id,
  source: info.source ?? 'a.b.orders',
  target: info.target ?? 'a.b.customers',
  data: { info: { source: 'a.b.orders', target: 'a.b.customers', ...info } },
})

const profile = (over: Partial<RelationshipProfile> = {}): RelationshipProfile => ({
  source: 'a.b.orders',
  target: 'a.b.customers',
  pairs: [['customer_id', 'id']],
  a_rows: 282_000,
  a_null_rows: 0,
  a_distinct_keys: 90,
  b_rows: 100,
  b_distinct_keys: 100,
  b_repeated_keys: 0,
  orphan_rows: 3410,
  orphan_keys: 212,
  unused_keys: 0,
  max_fanout: 40,
  p95_fanout: 20,
  measured_at: '2026-11-18T10:00:00+00:00',
  sql_hash: 'x',
  ...over,
})
const cardinality = (p?: RelationshipProfile): Cardinality => ({ source: null, target: null, sentence: '', profile: p })

describe('which edges can be profiled', () => {
  const edges = [
    edge({ id: 'fk', kind: 'fk' }),
    edge({ id: 'lineage', kind: 'lineage' }),
    edge({ id: 'col', kind: 'join_mined', source_column: 'x', target_column: 'y' }),
    edge({ id: 'self', kind: 'fk', source: 'a.b.t', target: 'a.b.T' }),
    edge({ id: 'other', kind: 'manual', source: 'a.b.lines', target: 'a.b.orders' }),
  ]
  it('takes table-level reference edges, not flow, column-level or self-referencing ones', () => {
    expect(profilableEdges(edges).map((e) => e.id)).toEqual(['fk', 'other'])
  })
  it('with ticked tables takes only the edges between two of them', () => {
    expect(profilableEdges(edges, new Set(['a.b.orders', 'a.b.customers'])).map((e) => e.id)).toEqual(['fk'])
    expect(profilableEdges(edges, new Set()).map((e) => e.id)).toEqual(['fk', 'other'])
  })
})

describe('the words and the marks of orphans', () => {
  it('says how much of the source has no match, in the same words as the server', () => {
    expect(orphanText(profile())).toBe('1.2% of orders (3,410 rows, 212 keys) have no match in customers')
    expect(orphanText(profile({ orphan_rows: 0 }))).toBeNull()
    expect(orphanText(undefined)).toBeNull()
    expect([percent(1, 10_000_000), percent(30, 100), percent(0, 0), percent(5, 100)]).toEqual(['<0.1%', '30%', '0%', '5.0%'])
  })
  it('marks only a relationship that was measured and has orphans', () => {
    expect(hasOrphans(cardinality(profile()))).toBe(true)
    expect(hasOrphans(cardinality(profile({ orphan_rows: 0 })))).toBe(false)
    expect(hasOrphans(cardinality())).toBe(false)
    expect(hasOrphans(null)).toBe(false)
    expect(anyOrphans({ a: cardinality(), b: cardinality(profile()) })).toBe(true)
    expect(anyOrphans({ a: null })).toBe(false)
    expect(anyOrphans(undefined)).toBe(false)
  })
  it('turns the tick to run away from the side of the referenced table', () => {
    expect([Position.Right, Position.Left, Position.Bottom, Position.Top].map((s) => tickPlace(10, 20, s).rotate)).toEqual([0, 180, 90, -90])
    expect(tickPlace(10, 20, Position.Top)).toMatchObject({ x: 10, y: 20 })
  })
  it('draws a red tick that says so on hover', () => {
    const html = renderToStaticMarkup(
      <svg>
        <OrphanTick x={5} y={7} side={Position.Left} profile={profile()} />
      </svg>,
    )
    expect(html).toContain('data-testid="orphan-tick"')
    expect(html).toContain('translate(5 7) rotate(180)')
    expect(html).toContain('var(--edge-orphan)')
    expect(html).toContain('1.2% of orders (3,410 rows, 212 keys) have no match in customers')
  })
})
