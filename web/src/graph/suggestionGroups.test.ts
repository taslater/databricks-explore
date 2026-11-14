import { describe, expect, it } from 'vitest'
import type { Relationship } from '../api/types'
import { pairLabel } from './mining'
import { shortestNames } from './names'
import { groupSuggestions } from './suggestionGroups'

describe('shortestNames', () => {
  it('uses the table name when it is unique in the list', () => {
    const name = shortestNames(['main.sales.orders', 'main.sales.customers'])
    expect(name('main.sales.orders')).toBe('orders')
    expect(name('main.sales.customers')).toBe('customers')
  })
  it('adds the schema when the table name repeats across schemas', () => {
    const name = shortestNames(['main.sales.orders', 'main.hr.orders', 'main.sales.customers'])
    expect(name('main.sales.orders')).toBe('sales.orders')
    expect(name('main.hr.orders')).toBe('hr.orders')
    expect(name('main.sales.customers')).toBe('customers')
  })
  it('adds the catalog when schema.table repeats across catalogs', () => {
    const name = shortestNames(['dev.sales.orders', 'prod.sales.orders', 'prod.hr.orders'])
    expect(name('dev.sales.orders')).toBe('dev.sales.orders')
    expect(name('prod.sales.orders')).toBe('prod.sales.orders')
    expect(name('prod.hr.orders')).toBe('hr.orders')
  })
  it('counts a name once however often it is listed, and ignores case', () => {
    const name = shortestNames(['main.sales.orders', 'MAIN.SALES.ORDERS', 'main.sales.orders'])
    expect(name('main.sales.orders')).toBe('orders')
    expect(shortestNames(['a.b.t', 'A.C.T'])('a.b.t')).toBe('b.t')
  })
  it('handles names with fewer than three parts and names it was not given', () => {
    const name = shortestNames(['orders', 'x.orders'])
    expect(name('orders')).toBe('orders')
    expect(name('x.orders')).toBe('x.orders')
    expect(name('main.sales.other')).toBe('other')
  })
})

const A = 'main.sales.lineitem'
const B = 'main.sales.partsupp'
const C = 'main.sales.orders'

type Together = { columns: [string, string][]; runs: number }

function edge(
  id: string,
  s: [string, string],
  t: [string, string],
  runs: number,
  together: Together[] = [],
  last = '2026-11-10',
  users = 1,
): Relationship {
  return {
    id,
    kind: 'join_mined',
    source: { table: s[0], column: s[1] },
    target: { table: t[0], column: t[1] },
    directed: false,
    provenance: { origin: 'query_history' },
    evidence: { runs, users, first_seen: '2026-10-01', last_seen: last, sample_refs: [`stmt-${id}`], together } as never,
    status: 'proposed',
    note: '',
    created_at: '',
    updated_at: '',
  }
}

const BOTH: [string, string][] = [
  ['l_partkey', 'ps_partkey'],
  ['l_suppkey', 'ps_suppkey'],
]

describe('groupSuggestions', () => {
  it('leaves pairs with no siblings as single rows in the order given', () => {
    const rows = groupSuggestions([edge('a', [A, 'x'], [B, 'x'], 5), edge('b', [C, 'y'], [B, 'y'], 2)])
    expect(rows.map((r) => [r.key, r.ids, r.composite])).toEqual([
      ['a', ['a'], false],
      ['b', ['b'], false],
    ])
  })

  it('groups the halves of a composite key into one row with every column pair', () => {
    const together = [{ columns: BOTH, runs: 4 }]
    const rows = groupSuggestions([
      edge('p', [A, 'l_partkey'], [B, 'ps_partkey'], 4, together),
      edge('s', [A, 'l_suppkey'], [B, 'ps_suppkey'], 4, together),
    ])
    expect(rows).toHaveLength(1)
    const [r] = rows
    expect(r.composite).toBe(true)
    expect(r.ids.sort()).toEqual(['p', 's'])
    expect(r.columns).toEqual(BOTH)
    expect(r.source).toBe(A)
    expect(r.target).toBe(B)
    expect(r.runs).toBe(4)
  })

  it('keeps a pair that also appears on its own as its own row next to the composite row', () => {
    const together = [{ columns: BOTH, runs: 3 }]
    const rows = groupSuggestions([
      edge('p', [A, 'l_partkey'], [B, 'ps_partkey'], 7, together),
      edge('s', [A, 'l_suppkey'], [B, 'ps_suppkey'], 3, together),
    ])
    expect(rows.map((r) => [r.composite, r.ids.slice().sort(), r.runs])).toEqual([
      [false, ['p'], 7],
      [true, ['p', 's'], 3],
    ])
  })

  it('shows the group even when only some of its pairs are in the list (another status, or a declared key)', () => {
    const rows = groupSuggestions([edge('p', [A, 'l_partkey'], [B, 'ps_partkey'], 4, [{ columns: BOTH, runs: 4 }])])
    expect(rows).toHaveLength(1)
    expect(rows[0].composite).toBe(true)
    expect(rows[0].columns).toHaveLength(2)
    expect(rows[0].ids).toEqual(['p'])
  })

  it('keeps separate groups for different table pairs and different column sets', () => {
    const t1 = [{ columns: BOTH, runs: 2 }]
    const t2 = [{ columns: [['a', 'a'], ['b', 'b']] as [string, string][], runs: 2 }]
    const rows = groupSuggestions([
      edge('p', [A, 'l_partkey'], [B, 'ps_partkey'], 2, t1),
      edge('s', [A, 'l_suppkey'], [B, 'ps_suppkey'], 2, t1),
      edge('x', [C, 'a'], [B, 'a'], 2, t2),
      edge('y', [C, 'b'], [B, 'b'], 2, t2),
    ])
    expect(rows.map((r) => r.ids.slice().sort())).toEqual([['p', 's'], ['x', 'y']])
  })

  it('puts a pair in each composite it belongs to', () => {
    const abc: [string, string][] = [['a', 'a'], ['b', 'b'], ['c', 'c']]
    const ab: [string, string][] = [['a', 'a'], ['b', 'b']]
    const together = [{ columns: abc, runs: 2 }, { columns: ab, runs: 1 }]
    const rows = groupSuggestions([
      edge('a', [A, 'a'], [B, 'a'], 3, together),
      edge('b', [A, 'b'], [B, 'b'], 3, together),
      edge('c', [A, 'c'], [B, 'c'], 2, [{ columns: abc, runs: 2 }]),
    ])
    expect(rows.map((r) => [r.columns.length, r.runs])).toEqual([[3, 2], [2, 1]])
  })

  it('orders rows by runs, most first, and takes users and last seen from the members', () => {
    const together = [{ columns: BOTH, runs: 9 }]
    const rows = groupSuggestions([
      edge('z', [C, 'q'], [B, 'q'], 20),
      edge('p', [A, 'l_partkey'], [B, 'ps_partkey'], 9, together, '2026-11-01', 2),
      edge('s', [A, 'l_suppkey'], [B, 'ps_suppkey'], 9, together, '2026-11-09', 3),
    ])
    expect(rows.map((r) => r.runs)).toEqual([20, 9])
    expect(rows[1].users).toBe(3)
    expect(rows[1].lastSeen).toBe('2026-11-09')
  })

  it('treats an edge with no evidence as a single row', () => {
    const e = edge('n', [A, 'x'], [B, 'x'], 1)
    e.evidence = null
    expect(groupSuggestions([e]).map((r) => r.composite)).toEqual([false])
  })
})

describe('pairLabel with a name function', () => {
  it('uses the given names for both tables', () => {
    const e = edge('a', [A, 'x'], [B, 'y'], 1)
    expect(pairLabel(e, (t) => `s.${t.split('.').pop()}`)).toBe('s.lineitem.x ↔ s.partsupp.y')
    expect(pairLabel(e)).toBe('lineitem.x ↔ partsupp.y')
  })
})
