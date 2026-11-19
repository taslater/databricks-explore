import { describe, expect, it } from 'vitest'
import type { FactsByTable, Grain, TableStats } from '../api/nodeFacts'
import { ago, grainChange, shortBytes, shortCount, sizeBadge, spanLabel, withGrainChanges, withNodeFacts } from './cardFacts'
import type { FlowEdge, FlowNode } from './types'

const grain = (basis: Grain['basis'], columns: string[], label = `per ${columns.join(' × ')}`): Grain => ({ label, columns, basis, source: 's' })
const stats = (over: Partial<TableStats> = {}): TableStats => ({
  fetched_at: null, bytes: null, files: null, rows: null, clustering: [], partitioning: [], last_write: null,
  cadence_seconds: null, late: false, writes: [], history_error: null, ...over,
})

describe('the size badge', () => {
  it('shortens counts and sizes', () => {
    expect([950, 12_000, 1_900_000, 12_100_000, 1_200_000_000].map(shortCount)).toEqual(['950', '12K', '1.9M', '12M', '1.2B'])
    expect([512, 12 * 1024, 3.1 * 1024 ** 3, 480 * 1024 ** 2].map(shortBytes)).toEqual(['512 B', '12 KB', '3.1 GB', '480 MB'])
  })
  it('shows rows when known, else size, else nothing', () => {
    expect(sizeBadge(stats({ rows: 12_100_000, bytes: 5 }))).toBe('12M')
    expect(sizeBadge(stats({ bytes: 3.1 * 1024 ** 3 }))).toBe('3.1 GB')
    expect(sizeBadge(stats())).toBeNull()
    expect(sizeBadge(null)).toBeNull()
  })
  it('says how long ago', () => {
    const now = Date.parse('2026-11-18T12:00:00Z')
    expect([spanLabel(30), spanLabel(5 * 3600), spanLabel(100 * 3600)]).toEqual(['1 min', '5 h', '4 d'])
    expect(ago('2026-11-18T09:00:00Z', now)).toBe('3 h ago')
    expect(ago(null, now)).toBe('unknown')
  })
})

describe('grain change', () => {
  const lines = grain('primary_key', ['order_id', 'line_no'])
  const daily = grain('group_by', ['customer_id', 'order_date'])
  it('names both grains when a GROUP BY target differs from its source', () => {
    expect(grainChange(lines, daily)).toBe('per order_id × line_no → per customer_id × order_date')
  })
  it('is nothing when the grain is the same, in any order and case', () => {
    expect(grainChange(grain('primary_key', ['A', 'b']), grain('group_by', ['b', 'a']))).toBeNull()
  })
  it('is nothing unless the target is a GROUP BY and both grains are known', () => {
    expect(grainChange(lines, grain('dedupe', ['k']))).toBeNull()
    expect(grainChange(lines, grain('primary_key', ['x']))).toBeNull()
    expect(grainChange(null, daily)).toBeNull()
    expect(grainChange(lines, undefined)).toBeNull()
  })
})

const node = (id: string): FlowNode => ({ id, type: 'table', position: { x: 0, y: 0 }, data: { name: id, schema: 's', kind: 'table', focus: false, selfRef: false } })
const edge = (id: string, source: string, target: string, kind: 'view_dep' | 'fk' | 'lineage', extra: object = {}): FlowEdge =>
  ({ id, source, target, data: { info: { id, source, target, kind, status: 'derived', ...extra } } }) as unknown as FlowEdge

describe('overlays', () => {
  const facts: FactsByTable = {
    orders: { grain: grain('primary_key', ['order_id']), stats: null },
    daily: { grain: grain('group_by', ['day']), stats: stats({ rows: 5 }) },
  }
  it('puts facts on the nodes that have them and leaves the rest alone', () => {
    const [a, b] = [node('orders'), node('other')]
    const out = withNodeFacts([a, b], facts)
    expect(out[0].data.facts).toBe(facts.orders)
    expect(out[1]).toBe(b)
    expect(withNodeFacts([a], undefined)).toEqual([a])
  })
  it('marks only flow edges whose target is a GROUP BY of another grain', () => {
    const flow = edge('v', 'orders', 'daily', 'view_dep')
    const lineage = edge('l', 'orders', 'daily', 'lineage')
    const fk = edge('f', 'orders', 'daily', 'fk')
    const backwards = edge('b', 'daily', 'orders', 'view_dep')
    const bidir = edge('d', 'orders', 'daily', 'lineage', { bidir: true })
    const [v, l, f, b, d] = withGrainChanges([flow, lineage, fk, backwards, bidir], facts)
    expect(v.data?.grainChange).toBe('per order_id → per day')
    expect(l.data?.grainChange).toBe('per order_id → per day')
    expect([f.data?.grainChange, b.data?.grainChange, d.data?.grainChange]).toEqual([undefined, undefined, undefined])
  })
})
