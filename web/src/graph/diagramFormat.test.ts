// Every field a saved graph carries goes through fromDiagram and toDiagramBody and comes out as it went in; a graph saved by 0.9.0 has none of them.
import { describe, expect, it } from 'vitest'
import type { DiagramFile } from '../api/types'
import { fromDiagram, toDiagramBody } from './diagram'

const A = 'demo.sales.orders'
const B = 'demo.sales.customers'
const node = (id: string, x: number, y: number) => ({ data: { id, label: id.split('.')[2], kind: 'managed', external: false }, position: { x, y } })
const file = (extra: object): DiagramFile =>
  ({ name: 'g', saved_at: '2026-11-18T00:00:00Z', focus_schema: 'demo.sales', nodes: [node(A, 100, 100), node(B, 400, 100)], edges: [], ...extra }) as DiagramFile

function again(d: DiagramFile) {
  const p = fromDiagram(d)
  return toDiagramBody('g', { nodes: p.nodes, edges: p.edges, focusSchema: p.focusSchema, colorBy: p.colorBy, grouping: p.grouping, lens: p.lens, lensPositions: p.lensPositions })
}

describe('the saved graph file', () => {
  it('keeps color_by, grouping, lens and the positions of the other lenses', () => {
    const d = file({
      color_by: 'tag:domain',
      grouping: { by: 'tag:domain', collapsed: ['sales'], expanded: ['hr'], chains: false },
      lens: 'model',
      lens_positions: { all: { [A]: { x: 120, y: 80 }, [B]: { x: 420.5, y: 90 } }, flow: { [A]: { x: 5, y: 6 } } },
    })
    const out = again(d) as Record<string, unknown>
    expect(out.color_by).toBe('tag:domain')
    expect(out.grouping).toEqual(d.grouping)
    expect(out.lens).toBe('model')
    const lp = out.lens_positions as Record<string, Record<string, { x: number; y: number }>>
    expect(Object.keys(lp).sort()).toEqual(['all', 'flow'])
    for (const [lens, ids] of Object.entries(d.lens_positions as Record<string, Record<string, { x: number; y: number }>>)) {
      for (const [id, p] of Object.entries(ids)) {
        expect(lp[lens][id].x).toBeCloseTo(p.x, 5)
        expect(lp[lens][id].y).toBeCloseTo(p.y, 5)
      }
    }
  })

  it('writes none of them for a graph saved by 0.9.0, and for a graph in the defaults', () => {
    for (const d of [file({}), file({ color_by: 'type', grouping: {}, lens: 'all', lens_positions: {} })]) {
      const out = again(d) as Record<string, unknown>
      for (const k of ['color_by', 'grouping', 'lens', 'lens_positions']) expect(k in out).toBe(false)
    }
  })

  it('reads the lens and the other fields of a graph written by an agent, and skips what is malformed', () => {
    const p = fromDiagram(file({ color_by: 'bogus', grouping: 'nope', lens: 'wide', lens_positions: { wide: { [A]: { x: 1, y: 1 } }, flow: { gone: { x: 1, y: 1 }, [B]: { x: 'a', y: 1 } } } }))
    expect([p.colorBy, p.lens, p.grouping?.by]).toEqual(['type', 'all', 'schema'])
    expect(p.lensPositions).toEqual({})
  })
})
