import { describe, expect, it } from 'vitest'
import type { CanvasWindow } from '../../api/types'
import { tableEdges } from './tableEdges'

function query(id: string, title: string): CanvasWindow {
  return { id, type: 'query', title, position: { x: 0, y: 0 }, size: { w: 100, h: 100 }, sql: '', collapsed: false }
}

function card(id: string, table: string): CanvasWindow {
  return { id, type: 'table', title: table.split('.').pop()!, position: { x: 0, y: 0 }, size: { w: 100, h: 100 }, table }
}

describe('tableEdges', () => {
  it('draws an edge from each card whose table the query reads, to that query', () => {
    const windows = [card('t1', 'main.sales.orders'), card('t2', 'main.sales.customers'), query('q1', 'daily')]
    const edges = tableEdges(windows, { q1: ['main.sales.orders'] })
    expect(edges).toEqual([{ id: 'table:t1>q1', from: 't1', to: 'q1' }])
  })

  it('draws no edge for a table with no card on the canvas', () => {
    const windows = [card('t1', 'main.sales.orders'), query('q1', 'daily')]
    expect(tableEdges(windows, { q1: ['main.sales.returns'] })).toEqual([])
  })

  it('matches table names case-insensitively', () => {
    const windows = [card('t1', 'Main.Sales.Orders'), query('q1', 'daily')]
    expect(tableEdges(windows, { q1: ['main.sales.orders'] })).toEqual([{ id: 'table:t1>q1', from: 't1', to: 'q1' }])
  })

  it('draws one edge per card when several cards show the same table, and none twice', () => {
    const windows = [card('t1', 'main.s.a'), card('t2', 'main.s.a'), query('q1', 'x')]
    const edges = tableEdges(windows, { q1: ['main.s.a', 'MAIN.S.A'] })
    expect(edges.map((e) => e.from)).toEqual(['t1', 't2'])
  })

  it('connects one card to several queries that read its table', () => {
    const windows = [card('t1', 'main.s.a'), query('q1', 'x'), query('q2', 'y')]
    const edges = tableEdges(windows, { q1: ['main.s.a'], q2: ['main.s.a'] })
    expect(edges.map((e) => e.id)).toEqual(['table:t1>q1', 'table:t1>q2'])
  })

  it('ignores query windows with no entry, and table cards with no table', () => {
    const blank: CanvasWindow = { id: 't9', type: 'table', title: 'blank', position: { x: 0, y: 0 }, size: { w: 1, h: 1 } }
    const windows = [blank, query('q1', 'x'), query('q2', 'y')]
    expect(tableEdges(windows, { q1: ['main.s.a'], q2: [] })).toEqual([])
  })

  it('ignores note windows, even if a reads entry has their id', () => {
    const note: CanvasWindow = { id: 'n1', type: 'note', title: 'n', position: { x: 0, y: 0 }, size: { w: 1, h: 1 }, text: '' }
    const windows = [card('t1', 'main.s.a'), note]
    expect(tableEdges(windows, { n1: ['main.s.a'] })).toEqual([])
  })

  it('returns nothing when there are no cards', () => {
    expect(tableEdges([query('q1', 'x')], { q1: ['main.s.a'] })).toEqual([])
  })
})
