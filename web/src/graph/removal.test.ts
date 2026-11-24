import { beforeEach, describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode } from '../api/types'
import { useGraphStore } from './graphStore'
import { removalTargets, removeFromGraph, removeSelected } from './removal'

const T = (n: string) => `c.s.${n}`
const node = (n: string, focus = false): GraphNode => ({ id: T(n), label: n, kind: 'table', ...(focus ? { focus: true } : {}) })
const edge = (a: string, b: string): GraphEdge => ({ id: `lineage:${T(a)}->${T(b)}`, source: T(a), target: T(b), kind: 'lineage' }) as GraphEdge

const s = () => useGraphStore.getState()
const ids = () => s().nodes.map((n) => n.id).sort()

beforeEach(() => {
  s().clear()
  // a -> b -> c, with d hanging off b
  s().mergeRelations({ nodes: [node('b', true), node('a'), node('c'), node('d')], edges: [edge('a', 'b'), edge('b', 'c'), edge('b', 'd')], errors: [] })
})

describe('removalTargets', () => {
  it('takes the ticked tables, or else the one whose details are open', () => {
    expect(removalTargets(s().nodes, { kind: 'node', id: T('c') })).toEqual([T('c')])
    expect(removalTargets(s().nodes, { kind: 'edge', id: 'x' })).toEqual([])
    const ticked = s().nodes.map((n) => (n.id === T('a') || n.id === T('d') ? { ...n, selected: true } : n))
    expect(removalTargets(ticked, { kind: 'node', id: T('c') }).sort()).toEqual([T('a'), T('d')])
  })
})

describe('removeFromGraph', () => {
  it('takes the table and its edges off, and says so', () => {
    expect(removeFromGraph([T('b')])).toBe(1)
    expect(ids()).toEqual([T('a'), T('c'), T('d')])
    expect(s().edges).toEqual([])
    expect(s().status.text).toBe(`removed ${T('b')} from the graph`)
  })

  it('ignores ids that are not stored tables', () => {
    expect(removeFromGraph(['concept:x', 'summary:g', T('nope')])).toBe(0)
    expect(ids()).toHaveLength(4)
  })

  it('clears a selection, hover or expansion that named a removed table', () => {
    s().setSelection({ kind: 'edge', id: `lineage:${T('b')}->${T('c')}` })
    s().setHover(T('c'))
    s().recordExpansion(`${T('c')}|down`, [T('x')])
    s().recordExpansion(`${T('b')}|down`, [T('c'), T('d')])
    removeFromGraph([T('c')])
    expect(s().selection).toBeNull()
    expect(s().hoverId).toBeNull()
    expect(s().expansions).toEqual({ [`${T('b')}|down`]: [T('d')] })
  })

  it('keeps a selection that still stands', () => {
    s().setSelection({ kind: 'node', id: T('a') })
    removeFromGraph([T('d')])
    expect(s().selection).toEqual({ kind: 'node', id: T('a') })
  })
})

describe('removeSelected', () => {
  it('removes every ticked table at once', () => {
    useGraphStore.setState({ nodes: s().nodes.map((n) => (n.id === T('a') || n.id === T('c') ? { ...n, selected: true } : n)) })
    expect(removeSelected()).toBe(2)
    expect(ids()).toEqual([T('b'), T('d')])
    expect(s().status.text).toBe('removed 2 tables from the graph')
  })
})
