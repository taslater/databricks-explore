import { describe, expect, it } from 'vitest'
import type { JoinKey, JoinsResponse } from '../api/types'
import { aliasesFor, joinSql, planJoins, type JoinPlan, type LoadJoins } from './joinQuery'

const A = 'demo.sales.returns'
const B = 'demo.sales.order_items'
const C = 'demo.sales.orders'
const D = 'demo.sales.customers'
const E = 'demo.sales.islands'

function key(pairs: Array<[string, string]>, over: Partial<JoinKey> = {}): JoinKey {
  return {
    pairs: pairs.map(([here, there]) => ({ here, there })),
    source: 'mined',
    status: 'proposed',
    runs: 5,
    name: null,
    ...over,
  }
}
const fk = (pairs: Array<[string, string]>) => key(pairs, { source: 'fk', status: 'derived', runs: null })

/** What each table's route says. B declares an FK to C, C to D, as Unity Catalog would. */
const DATA: Record<string, JoinsResponse['joins']> = {
  [A]: [
    {
      table: B,
      keys: [
        key([['order_id', 'order_id']], { runs: 37 }),
        key(
          [
            ['order_id', 'order_id'],
            ['line_no', 'line_no'],
          ],
          { runs: 20 },
        ),
      ],
    },
  ],
  [B]: [{ table: C, keys: [fk([['order_id', 'order_id']])] }],
  [C]: [{ table: D, keys: [fk([['customer_id', 'customer_id']])] }],
  [D]: [],
  [E]: [],
}
const loads: string[] = []
const load: LoadJoins = async (t) => {
  loads.push(t)
  return DATA[t] ?? []
}

function ok(plan: JoinPlan) {
  if (!plan.ok) throw new Error(plan.message)
  return plan
}

describe('planJoins', () => {
  it('one table is a plain select', async () => {
    const plan = ok(await planJoins([A], load))
    expect(plan.steps).toEqual([])
    expect(joinSql(plan)).toBe('SELECT *\nFROM demo.sales.returns r\nLIMIT 100')
  })

  it('joins two related tables on the best key, composite keys ANDed', async () => {
    const plan = ok(await planJoins([A, B], load))
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0].table).toBe(B)
    expect(plan.added).toEqual([])
    expect(joinSql(plan)).toBe(
      'SELECT *\nFROM demo.sales.returns r\nJOIN demo.sales.order_items oi\n  ON r.order_id = oi.order_id\nLIMIT 100',
    )
  })

  it('finds a relationship declared by the other table, with the columns read the right way round', async () => {
    const plan = ok(await planJoins([C, B], load))
    expect(joinSql(plan)).toContain('JOIN demo.sales.order_items oi\n  ON o.order_id = oi.order_id')
  })

  it('goes through a table in between and says it added it', async () => {
    const plan = ok(await planJoins([A, C], load))
    expect(plan.steps.map((s) => s.table)).toEqual([B, C])
    expect(plan.added).toEqual([B])
    const sql = joinSql(plan)
    expect(sql).toContain('JOIN demo.sales.order_items oi\n  ON r.order_id = oi.order_id')
    expect(sql).toContain('JOIN demo.sales.orders o\n  ON oi.order_id = o.order_id')
  })

  it('uses the nearest table already in the query for the next one', async () => {
    const plan = ok(await planJoins([A, B, D], load))
    expect(plan.steps.map((s) => [s.table, s.to])).toEqual([
      [B, A],
      [C, B],
      [D, C],
    ])
    expect(plan.added).toEqual([C])
  })

  it('ANDs a composite key', async () => {
    const composite: Record<string, JoinsResponse['joins']> = {
      [A]: [{ table: B, keys: [fk([['a', 'x'], ['b', 'y']])] }],
    }
    const plan = ok(await planJoins([A, B], async (t) => composite[t] ?? []))
    expect(joinSql(plan)).toContain('  ON r.a = oi.x\n  AND r.b = oi.y')
  })

  it('says so when there is no path, and writes no cross join', async () => {
    const plan = await planJoins([A, E], load)
    expect(plan.ok).toBe(false)
    expect(!plan.ok && plan.message).toContain('No known relationship path joins islands to returns')
  })

  it('does not follow a rejected relationship', async () => {
    const rejected: Record<string, JoinsResponse['joins']> = {
      [A]: [{ table: B, keys: [key([['a', 'a']], { status: 'rejected' })] }],
    }
    expect((await planJoins([A, B], async (t) => rejected[t] ?? [])).ok).toBe(false)
  })

  it('gives up after a few hops and does not read tables forever', async () => {
    const chain = async (t: string): Promise<JoinsResponse['joins']> => {
      const n = Number(t.split('.').pop()!.slice(1))
      return [{ table: `c.s.t${n + 1}`, keys: [fk([['id', 'id']])] }]
    }
    let reads = 0
    const plan = await planJoins(['c.s.t0', 'c.s.t99'], async (t) => {
      reads++
      return chain(t)
    })
    expect(plan.ok).toBe(false)
    expect(reads).toBeLessThanOrEqual(30)
  })

  it('treats a table named twice, in any case, as one', async () => {
    const plan = ok(await planJoins([A, A.toUpperCase(), B], load))
    expect(plan.steps).toHaveLength(1)
  })

  it('asks for a table when none is given', async () => {
    expect((await planJoins([], load)).ok).toBe(false)
  })
})

describe('aliasesFor', () => {
  it('uses initials, and stays distinct and clear of keywords', () => {
    const a = aliasesFor(['c.s.order_items', 'c.s.returns', 'c.s.orders', 'c.s.owners', 'c.s.on', 'c.s.x-ray'])
    expect(a.get('c.s.order_items')).toBe('oi')
    expect(a.get('c.s.returns')).toBe('r')
    expect(a.get('c.s.orders')).toBe('o')
    expect(new Set(a.values()).size).toBe(6)
    expect([...a.values()]).not.toContain('on')
  })
})
