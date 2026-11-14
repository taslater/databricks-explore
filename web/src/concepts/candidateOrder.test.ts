import { describe, expect, it } from 'vitest'
import { candidateKey, inFirstOrder } from './candidateOrder'

const hit = (table: string, column: string | null = null, linked = false) => ({ table, column, linked })

describe('inFirstOrder', () => {
  const first = [hit('a.b.orders'), hit('a.b.orders', 'customer_id'), hit('a.b.returns')]

  it('keeps the server order when there is no earlier order', () => {
    expect(inFirstOrder(first, null)).toBe(first)
  })

  it('keeps a linked row where it was, although the server now sorts it last', () => {
    const order = first.map(candidateKey)
    const refetched = [hit('a.b.orders', 'customer_id'), hit('a.b.returns'), hit('a.b.orders', null, true)]
    expect(inFirstOrder(refetched, order).map(candidateKey)).toEqual(['a.b.orders#', 'a.b.orders#customer_id', 'a.b.returns#'])
  })

  it('puts a new hit at the end and ignores one that is gone', () => {
    const order = first.map(candidateKey)
    const next = [hit('a.b.new'), hit('a.b.returns'), hit('a.b.orders')]
    expect(inFirstOrder(next, order).map(candidateKey)).toEqual(['a.b.orders#', 'a.b.returns#', 'a.b.new#'])
  })
})
