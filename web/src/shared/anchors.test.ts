import { describe, expect, it } from 'vitest'
import { anchorPercent, anchorStyle, splitSides } from './anchors'

describe('splitSides', () => {
  it('splits a side that has an incoming and an outgoing end, and only that side', () => {
    const out = splitSides([
      { node: 'a', key: 'r', role: 'in' },
      { node: 'a', key: 'r', role: 'out' },
      { node: 'a', key: 'l', role: 'out' },
      { node: 'b', key: 'l', role: 'in' },
    ])
    expect([...out]).toEqual([['a', ['r']]])
  })
  it('lets several edges in one direction share a point', () => {
    expect(splitSides([{ node: 'a', key: 'r', role: 'out' }, { node: 'a', key: 'r', role: 'out' }]).size).toBe(0)
  })
})

describe('anchorPercent and anchorStyle', () => {
  it('centers an unsplit side and puts in above or left of out', () => {
    expect(anchorPercent('in', false)).toBe(50)
    expect(anchorPercent('out', false)).toBe(50)
    expect(anchorPercent('in', true)).toBeLessThan(anchorPercent('out', true))
    expect(anchorPercent('in', true)).not.toBe(anchorPercent('out', true))
  })
  it('moves left and right handles vertically, top and bottom ones horizontally', () => {
    expect(anchorStyle('r', 35)).toEqual({ top: '35%' })
    expect(anchorStyle('t', 65)).toEqual({ left: '65%' })
  })
})
