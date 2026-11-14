import { QueryClient } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JoinKey, JoinsResponse } from '../../api/types'
import { compareKeys, flipKey, keyDetail, rankKeys, tier } from './joinKeys'
import { joinCompletions, joinOptions, type JoinsOf } from './joinCompletion'
import { joinContext, resolveRefs } from './sqlRefs'

const RT = 'demo.sales.returns'
const OI = 'demo.sales.order_items'
const OR = 'demo.sales.orders'
const SKU = 'demo.sales.skus'

function key(over: Omit<Partial<JoinKey>, 'pairs'> & { pairs: Array<[string, string]> }): JoinKey {
  const { pairs, ...rest } = over
  return {
    pairs: pairs.map(([here, there]) => ({ here, there })),
    source: 'mined',
    status: 'proposed',
    runs: null,
    name: null,
    ...rest,
  }
}

const single = key({ pairs: [['order_id', 'order_id']], runs: 37 })
const composite = key({
  pairs: [
    ['order_id', 'order_id'],
    ['line_no', 'line_no'],
  ],
  runs: 20,
})

describe('ranking', () => {
  it('puts FK and accepted first, then manual, then proposed by runs, and never rejected', () => {
    const fk = key({ pairs: [['a', 'a']], source: 'fk', status: 'derived' })
    const accepted = key({ pairs: [['b', 'b']], status: 'accepted', runs: 2 })
    const manual = key({ pairs: [['c', 'c']], source: 'manual', status: 'accepted' })
    const few = key({ pairs: [['d', 'd']], runs: 3 })
    const many = key({ pairs: [['e', 'e']], runs: 30 })
    const rejected = key({ pairs: [['f', 'f']], status: 'rejected', runs: 999 })
    const order = rankKeys([few, rejected, manual, many, accepted, fk]).map((k) => k.pairs[0].here)
    expect(order).toEqual(['a', 'b', 'c', 'e', 'd'])
    expect([fk, accepted, manual, many].map(tier)).toEqual([0, 0, 1, 2])
  })

  it('prefers the larger key among equals in the top tier, runs among proposed', () => {
    const a = key({ pairs: [['x', 'x']], status: 'accepted', runs: 50 })
    const b = key({ pairs: [['x', 'x'], ['y', 'y']], status: 'accepted', runs: 5 })
    expect(compareKeys(b, a)).toBeLessThan(0)
    expect(compareKeys(single, composite)).toBeLessThan(0)
  })

  it('keeps one copy of a key seen from both tables, in its better form', () => {
    const fk = key({ pairs: [['a', 'a']], source: 'fk', status: 'derived' })
    const mined = key({ pairs: [['a', 'a']], runs: 9 })
    expect(rankKeys([mined, fk])).toEqual([fk])
  })

  it('drops keys with no columns', () => {
    expect(rankKeys([key({ pairs: [], source: 'manual', status: 'accepted' })])).toEqual([])
  })

  it('describes the source', () => {
    expect(keyDetail(key({ pairs: [['a', 'a']], source: 'fk', status: 'derived' }))).toBe('FK')
    expect(keyDetail(single)).toBe('mined: 37 runs')
    expect(keyDetail(key({ pairs: [['a', 'a']], runs: 1 }))).toBe('mined: 1 run')
    expect(keyDetail(key({ pairs: [['a', 'a']], runs: 4, status: 'accepted' }))).toBe('mined: 4 runs, accepted')
    expect(keyDetail(key({ pairs: [['a', 'a']], source: 'manual', status: 'accepted' }))).toBe('manual')
  })

  it('flips a key to the other table side', () => {
    expect(flipKey(key({ pairs: [['a', 'b']] })).pairs).toEqual([{ here: 'b', there: 'a' }])
  })
})

/** What the route would say about each table. */
const KNOWN: Record<string, JoinsResponse['joins']> = {
  [RT]: [{ table: OI, keys: [single, composite] }],
  [OI]: [
    { table: RT, keys: [flipKey(single), flipKey(composite)] },
    { table: OR, keys: [key({ pairs: [['order_id', 'order_id']], source: 'fk', status: 'derived', name: 'fk_o' })] },
    { table: SKU, keys: [key({ pairs: [['sku', 'sku']], status: 'rejected', runs: 12 })] },
  ],
}
const joinsOf: JoinsOf = (t) => KNOWN[t]

function options(sql: string, known: JoinsOf = joinsOf) {
  const ctx = joinContext(sql)!
  return joinOptions(ctx, resolveRefs(ctx.refs), known)
}

describe('conditions after ON', () => {
  const sql = 'SELECT * FROM demo.sales.returns r JOIN demo.sales.order_items oi ON '

  it('offers the known keys with the aliases the user wrote, best first, with the source', () => {
    expect(options(sql).map((o) => [o.label, o.detail])).toEqual([
      ['r.order_id = oi.order_id', 'mined: 37 runs'],
      ['r.order_id = oi.order_id AND r.line_no = oi.line_no', 'mined: 20 runs'],
    ])
  })

  it('uses the last part of the name when there is no alias, quoting odd names', () => {
    const labels = options('FROM demo.sales.returns JOIN demo.sales.order_items ON ').map((o) => o.label)
    expect(labels[0]).toBe('returns.order_id = order_items.order_id')
    const odd: JoinsOf = () => [{ table: OI, keys: [key({ pairs: [['order-id', 'order id']], source: 'fk', status: 'derived' })] }]
    expect(options(sql, odd)[0].label).toBe('r.`order-id` = oi.`order id`')
  })

  it('works from either table having the answer, and leaves a rejected key out', () => {
    const onlyOi: JoinsOf = (t) => (t === OI ? KNOWN[OI] : undefined)
    expect(options(sql, onlyOi)).toHaveLength(2)
    const rejected: JoinsOf = () => [{ table: OI, keys: [key({ pairs: [['a', 'a']], status: 'rejected', runs: 5 })] }]
    expect(options(sql, rejected)).toEqual([])
  })

  it('ranks FK above mined and boosts in order', () => {
    const fk = key({ pairs: [['order_id', 'order_id']], source: 'fk', status: 'derived' })
    const both: JoinsOf = (t) => (t === RT ? [{ table: OI, keys: [single, fk] }] : undefined)
    const out = options(sql, both)
    expect(out.map((o) => o.detail)).toEqual(['FK'])
    const two: JoinsOf = () => [{ table: OI, keys: [single, composite, key({ pairs: [['z', 'z']], source: 'fk', status: 'derived' })] }]
    const ranked = options(sql, two)
    expect(ranked[0].detail).toBe('FK')
    expect(ranked[0].boost).toBeGreaterThan(ranked[1].boost)
  })

  it('offers conditions against every earlier table for a third join', () => {
    const labels = options('FROM demo.sales.returns r JOIN demo.sales.order_items oi ON r.a = oi.a JOIN demo.sales.orders o ON ').map(
      (o) => o.label,
    )
    // order_items declares the FK to orders: the earlier table `oi` is the left side.
    expect(labels).toEqual(['oi.order_id = o.order_id'])
  })

  it('self joins list the table own keys once', () => {
    const self: JoinsOf = () => [{ table: OR, keys: [key({ pairs: [['parent_id', 'id']], source: 'fk', status: 'derived' })] }]
    expect(options('FROM demo.sales.orders e JOIN demo.sales.orders m ON ', self).map((o) => o.label)).toEqual([
      'e.parent_id = m.id',
    ])
  })

  it('offers nothing for a derived table or unknown tables', () => {
    expect(options('FROM (SELECT 1) d JOIN demo.sales.order_items oi ON ')).toEqual([])
    expect(options('FROM x.y.nothing n JOIN demo.sales.order_items oi ON ')).toEqual([])
  })

  it('resolves short names against the tables written in full', () => {
    const labels = options('FROM demo.sales.returns r JOIN order_items oi ON ').map((o) => o.label)
    expect(labels[0]).toBe('r.order_id = oi.order_id')
  })
})

describe('USING and JOIN', () => {
  it('offers shared column lists in USING, and single columns after a comma', () => {
    const sql = 'FROM demo.sales.returns r JOIN demo.sales.order_items oi USING ('
    expect(options(sql).map((o) => o.label)).toEqual(['order_id', 'order_id, line_no'])
    expect(options(`${sql}order_id, `).map((o) => o.label)).toEqual(['order_id', 'line_no'])
  })

  it('leaves out keys whose columns are named differently', () => {
    const renamed: JoinsOf = () => [{ table: OI, keys: [key({ pairs: [['a', 'b']], source: 'fk', status: 'derived' })] }]
    expect(options('FROM demo.sales.returns r JOIN demo.sales.order_items oi USING (', renamed)).toEqual([])
  })

  it('offers tables known to join to the ones in FROM, best first, not those already there or rejected', () => {
    const out = options('SELECT * FROM demo.sales.order_items oi JOIN ')
    expect(out.map((o) => [o.label, o.detail])).toEqual([
      ['demo.sales.orders', 'FK · joins order_items'],
      ['demo.sales.returns', 'mined: 37 runs · joins order_items'],
    ])
    const withReturns = options('SELECT * FROM demo.sales.order_items oi JOIN demo.sales.returns r JOIN ')
    expect(withReturns.map((o) => o.label)).toEqual(['demo.sales.orders'])
  })
})

describe('joinCompletions', () => {
  let qc: QueryClient
  beforeEach(() => {
    qc = new QueryClient()
    vi.restoreAllMocks()
  })

  it('reads the keys through the cache, once per table, and replaces the typed text', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const table = new URL(url, 'http://x').searchParams.get('table')!
        calls.push(table)
        return new Response(JSON.stringify({ table, joins: KNOWN[table] ?? [], errors: [] }), { status: 200 })
      }),
    )
    const doc = 'SELECT * FROM demo.sales.returns r JOIN demo.sales.order_items oi ON r.o'
    const first = await joinCompletions(qc, 'p', doc, doc.length)
    expect(first?.from).toBe(doc.length - 3)
    expect(first?.options[0].label).toBe('r.order_id = oi.order_id')
    await joinCompletions(qc, 'p', doc, doc.length)
    expect(calls.sort()).toEqual([OI, RT])
  })

  it('answers null when not connected, not at a join, or when the fetch fails', async () => {
    const doc = 'SELECT * FROM demo.sales.returns r JOIN demo.sales.order_items oi ON '
    expect(await joinCompletions(qc, null, doc, doc.length)).toBeNull()
    expect(await joinCompletions(qc, 'p', 'SELECT 1', 8)).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"x"}', { status: 500 })))
    expect(await joinCompletions(qc, 'p', doc, doc.length)).toBeNull()
  })
})
