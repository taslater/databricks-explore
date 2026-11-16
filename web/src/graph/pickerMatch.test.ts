import { describe, expect, it } from 'vitest'
import { compileFilter, highlightParts, matchName, rankItems, regexError } from './pickerMatch'

const names = ['customer', 'dim_customer', 'my_cust_x', 'orders', 'Customers_raw', 'xcustx']

describe('matchName', () => {
  it('ranks by prefix, then _ part prefix, then substring, ignoring case', () => {
    const c = compileFilter('CUST')
    expect(matchName(c, 'customer')).toEqual({ rank: 1, ranges: [[0, 4]] })
    expect(matchName(c, 'dim_customer')).toEqual({ rank: 2, ranges: [[4, 8]] })
    expect(matchName(c, 'xcustx')).toEqual({ rank: 3, ranges: [[1, 5]] })
    expect(matchName(c, 'orders')).toBeNull()
  })

  it('matches everything for blank text', () => {
    expect(matchName(compileFilter('  '), 'anything')).toEqual({ rank: 1, ranges: [] })
  })

  it('treats * and ? as a glob that must match the whole name', () => {
    const c = compileFilter('cust*')
    expect(matchName(c, 'Customer')).toEqual({ rank: 1, ranges: [[0, 4]] })
    expect(matchName(c, 'dim_customer')).toBeNull()
    expect(matchName(compileFilter('*cust*'), 'dim_customer')?.ranges).toEqual([[4, 8]])
    expect(matchName(compileFilter('o?ders'), 'orders')?.ranges).toEqual([
      [0, 1],
      [2, 6],
    ])
    expect(matchName(compileFilter('o?ders'), 'oders')).toBeNull()
  })

  it('takes regex characters in a glob literally', () => {
    expect(matchName(compileFilter('a.b*'), 'a.bc')).not.toBeNull()
    expect(matchName(compileFilter('a.b*'), 'axbc')).toBeNull()
  })

  it('uses an unanchored, case-insensitive regex when asked', () => {
    const c = compileFilter('cust(omer)?$', true)
    expect(matchName(c, 'dim_Customer')).toEqual({ rank: 2, ranges: [[4, 12]] })
    expect(matchName(c, 'customers')).toBeNull()
    expect(matchName(compileFilter('^dim', true), 'dim_x')?.rank).toBe(1)
    expect(matchName(compileFilter('x', true), 'abx')?.rank).toBe(3)
  })

  it('reports an invalid regex and filters nothing out', () => {
    const c = compileFilter('(', true)
    expect(c.kind).toBe('invalid')
    expect(regexError('(')).toBeTruthy()
    expect(regexError('a+')).toBeNull()
    expect(matchName(c, 'whatever')).not.toBeNull()
  })
})

describe('rankItems', () => {
  it('puts ranks 1 and 2 first, alphabetical, and rank 3 apart', () => {
    const { primary, rest } = rankItems(names, compileFilter('cust'), (n) => n)
    expect(primary.map((r) => r.item)).toEqual(['customer', 'Customers_raw', 'dim_customer', 'my_cust_x'])
    expect(rest.map((r) => r.item)).toEqual(['xcustx'])
  })

  it('keeps the given order when there is no filter', () => {
    const { primary, rest } = rankItems(names, compileFilter(''), (n) => n)
    expect(primary.map((r) => r.item)).toEqual(names)
    expect(rest).toEqual([])
  })

  it('sorts glob matches alphabetically', () => {
    const { primary } = rankItems(['b1', 'a2', 'a1'], compileFilter('?1'), (n) => n)
    expect(primary.map((r) => r.item)).toEqual(['a1', 'b1'])
  })
})

describe('highlightParts', () => {
  it('splits a name around its matches', () => {
    expect(highlightParts('dim_customer', [[4, 8]])).toEqual([
      { text: 'dim_', hit: false },
      { text: 'cust', hit: true },
      { text: 'omer', hit: false },
    ])
    expect(highlightParts('abc', [])).toEqual([{ text: 'abc', hit: false }])
  })
})
