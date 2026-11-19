import { describe, expect, it } from 'vitest'
import { columnHandleId } from './columns'
import { endAt, graphSplits } from './anchors'

const edge = (source: string, target: string, sourceHandle: string, targetHandle: string, hidden = false) => ({
  source,
  target,
  sourceHandle,
  targetHandle,
  hidden,
})

describe('endAt', () => {
  it('reads a table handle and a column handle, and ignores anything else', () => {
    expect(endAt('a', 'src-r')).toEqual({ node: 'a', key: 'r', role: 'out' })
    expect(endAt('a', 'tgt-t')).toEqual({ node: 'a', key: 't', role: 'in' })
    expect(endAt('a', columnHandleId('s', 'r', 'id'))).toEqual({ node: 'a', key: 'r:id', role: 'out' })
    expect(endAt('a', columnHandleId('t', 'l', 'id'))).toEqual({ node: 'a', key: 'l:id', role: 'in' })
    expect(endAt('a', 'nonsense')).toBeNull()
    expect(endAt('a', null)).toBeNull()
  })
})

describe('graphSplits', () => {
  it('splits the right side of a node with one edge in and one out there', () => {
    // a -> b, and c -> b arriving at b's left; b -> d leaves b's right; e -> b arrives b's right
    const s = graphSplits([edge('a', 'b', 'src-r', 'tgt-l'), edge('b', 'd', 'src-r', 'tgt-l'), edge('e', 'b', 'src-l', 'tgt-r')])
    expect(s.get('b')).toEqual(['r'])
    expect(s.has('a')).toBe(false)
    expect(s.has('d')).toBe(false)
  })
  it('keeps a side with edges in one direction only at the center', () => {
    expect(graphSplits([edge('a', 'b', 'src-r', 'tgt-l'), edge('c', 'b', 'src-r', 'tgt-l')]).size).toBe(0)
  })
  it('gives a self-loop two separate points', () => {
    expect(graphSplits([edge('a', 'a', 'src-r', 'tgt-r')]).get('a')).toEqual(['r'])
  })
  it('does not count hidden edges', () => {
    expect(graphSplits([edge('a', 'b', 'src-r', 'tgt-l'), edge('c', 'a', 'src-r', 'tgt-r', true)]).size).toBe(0)
  })
  it('splits a column row on its own', () => {
    const s = graphSplits([
      edge('a', 'b', columnHandleId('s', 'r', 'id'), columnHandleId('t', 'l', 'a_id')),
      edge('c', 'a', columnHandleId('s', 'r', 'x'), columnHandleId('t', 'r', 'id')),
      edge('c', 'a', columnHandleId('s', 'r', 'x'), columnHandleId('t', 'r', 'other')),
    ])
    expect(s.get('a')).toEqual(['r:id'])
  })
})
