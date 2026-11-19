import { MarkerType, type Edge } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import { anchorEdges } from './anchors'

const arrow = { type: MarkerType.ArrowClosed }
const e = (id: string, source: string, target: string, sh: string, th: string, markerEnd: unknown = arrow, markerStart: unknown = null): Edge =>
  ({ id, source, target, sourceHandle: sh, targetHandle: th, markerEnd, markerStart }) as Edge

describe('anchorEdges', () => {
  it('moves the ends that share a side with an opposite one to the in and out anchors', () => {
    // b receives on its right from c (arrowhead at b) and sends from its right to d.
    const out = anchorEdges([e('1', 'c', 'b', 'l', 'r'), e('2', 'b', 'd', 'r', 'l')])
    expect(out[0].targetHandle).toBe('r-in')
    expect(out[1].sourceHandle).toBe('r-out')
    expect(out[0].sourceHandle).toBe('l') // c has no edge in the other direction on that side
    expect(out[1].targetHandle).toBe('l')
  })
  it('leaves a side with edges in one direction only, and edges with no arrowhead, as saved', () => {
    const one = [e('1', 'a', 'b', 'r', 'l'), e('2', 'a', 'c', 'r', 'l')]
    expect(anchorEdges(one)).toEqual(one)
    const plain = [e('1', 'a', 'b', 'r', 'l', null), e('2', 'c', 'a', 'r', 'r', null)]
    expect(anchorEdges(plain)).toEqual(plain)
  })
  it('reads the direction from the arrowheads, not from source and target', () => {
    // The arrowhead is at the source end (a reversed connector): that end flows in.
    const out = anchorEdges([e('1', 'a', 'b', 'r', 'l', null, arrow), e('2', 'a', 'c', 'r', 'l')])
    expect(out[0].sourceHandle).toBe('r-in')
    expect(out[1].sourceHandle).toBe('r-out')
  })
  it('keeps edges without a handle id as they are', () => {
    const none = [{ id: '1', source: 'a', target: 'b', markerEnd: arrow } as Edge]
    expect(anchorEdges(none)).toEqual(none)
  })
})
