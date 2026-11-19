import { describe, expect, it } from 'vitest'
import { sizesAgree, untilSteady } from './measured'

const node = (id: string, w?: number, h?: number) => ({ id, measured: w ? { width: w, height: h } : undefined })

describe('sizesAgree', () => {
  const drawn = (id: string) => ({ a: { width: 100, height: 50 }, b: { width: 120, height: 60 } })[id as 'a' | 'b'] ?? null
  const ids = new Set(['a', 'b'])

  it('is true when every shown node was measured at the size it is drawn', () => {
    expect(sizesAgree([node('a', 100, 50), node('b', 120.5, 60)], ids, drawn)).toBe(true)
  })

  it('is false for a node still measured at the size of another lens', () => {
    expect(sizesAgree([node('a', 100, 50), node('b', 204, 136)], ids, drawn)).toBe(false)
  })

  it('is false for a node not measured yet or not drawn, and ignores the nodes it was not asked about', () => {
    expect(sizesAgree([node('a', 100, 50), node('b')], ids, drawn)).toBe(false)
    expect(sizesAgree([node('a', 100, 50), node('c', 1, 1)], new Set(['a', 'c']), drawn)).toBe(false)
    expect(sizesAgree([node('a', 100, 50), node('c', 1, 1)], new Set(['a']), drawn)).toBe(true)
  })
})

describe('untilSteady', () => {
  it('waits for the condition to hold several checks in a row', async () => {
    let calls = 0
    await untilSteady(() => ++calls >= 3 && calls !== 5, () => false, { every: 1, steady: 3 })
    expect(calls).toBe(8) // 3 and 4 hold, 5 breaks the run, 6 to 8 hold
  })

  it('gives up at the limit and ends when told to stop', async () => {
    const t = Date.now()
    await untilSteady(() => false, () => false, { every: 5, limitMs: 40 })
    expect(Date.now() - t).toBeLessThan(500)
    let n = 0
    await untilSteady(() => false, () => ++n > 2, { every: 1 })
    expect(n).toBe(3)
  })
})
