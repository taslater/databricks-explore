// The Model lens's layout: facts (tables that reference others and are not referenced) in a middle row, left to right; the tables
// they reference above and below, alternating, each centered on the tables that reference it. A table that two facts reference sits
// between them. A dimension of a dimension goes one row further out, on the same side. graph_lens.py keeps the same rules.
import { depthsOf, referencePairs } from './lens'
import type { LayoutEdge, LayoutNode, Point } from './layout'

/** Between facts in the middle row. */
const FACT_GAP = 60
/** Between dimensions in a row. */
const DIM_GAP = 40
/** Between rows: room for the crow's feet. */
const ROW_GAP = 90

/**
 * Top-left positions for the tables of one connected part (every table in `nodes` is reached by an edge in `edges`, or is alone).
 * Only reference edges count. Relative: the caller moves the part to where it belongs.
 */
export function modelPart(nodes: LayoutNode[], edges: LayoutEdge[]): Map<string, Point> {
  const ids = nodes.map((n) => n.id)
  const index = new Map(ids.map((id, i) => [id, i]))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const pairs = referencePairs(edges, new Set(ids))
  const depth = depthsOf(ids, pairs)
  const row = (id: string) => depth.get(id) ?? 0
  const referrers = new Map(ids.map((id) => [id, pairs.filter(([, t]) => t === id).map(([s]) => s)]))
  const cx = new Map<string, number>()
  const cy = new Map<string, number>()
  const facts = ids.filter((id) => row(id) === 0)
  let x = 0
  for (const id of facts) {
    cx.set(id, x + byId.get(id)!.width / 2)
    x += byId.get(id)!.width + FACT_GAP
  }
  const mean = (values: number[]) => (values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0)
  const side = new Map<string, 'up' | 'down'>()
  const cells = new Map<string, string[]>()
  const deepest = Math.max(0, ...ids.map(row))
  for (let d = 1; d <= deepest; d++) {
    const want = new Map<string, number>()
    const level = ids.filter((id) => row(id) === d)
    for (const id of level) want.set(id, mean(referrers.get(id)!.filter((r) => cx.has(r)).map((r) => cx.get(r)!)))
    level.sort((a, b) => want.get(a)! - want.get(b)! || index.get(a)! - index.get(b)!)
    level.forEach((id, k) => {
      if (d === 1) side.set(id, k % 2 === 0 ? 'up' : 'down')
      else {
        const above = referrers.get(id)!.filter((r) => side.has(r)).sort((a, b) => Number(row(a) !== d - 1) - Number(row(b) !== d - 1) || index.get(a)! - index.get(b)!)
        side.set(id, above.length > 0 ? side.get(above[0])! : 'up')
      }
    })
    for (const s of ['up', 'down'] as const) {
      const cell = level.filter((id) => side.get(id) === s)
      if (cell.length === 0) continue
      cells.set(`${s}${d}`, cell)
      let edge: number | null = null
      for (const id of cell) {
        const w = byId.get(id)!.width
        let left = want.get(id)! - w / 2
        if (edge !== null && left < edge + DIM_GAP) left = edge + DIM_GAP
        cx.set(id, left + w / 2)
        edge = left + w
      }
      const shift = mean(cell.map((id) => want.get(id)! - cx.get(id)!))
      for (const id of cell) cx.set(id, cx.get(id)! + shift)
    }
  }
  const factHeight = Math.max(0, ...facts.map((id) => byId.get(id)!.height))
  for (const id of facts) cy.set(id, 0)
  const edge = { up: -factHeight / 2, down: factHeight / 2 }
  for (let d = 1; d <= deepest; d++) {
    for (const [s, sign] of [['up', -1], ['down', 1]] as const) {
      const cell = cells.get(`${s}${d}`)
      if (!cell) continue
      const h = Math.max(...cell.map((id) => byId.get(id)!.height))
      const centre = edge[s] + sign * (ROW_GAP + h / 2)
      edge[s] = centre + sign * (h / 2)
      for (const id of cell) cy.set(id, centre)
    }
  }
  return new Map(nodes.filter((n) => cx.has(n.id)).map((n) => [n.id, { x: cx.get(n.id)! - n.width / 2, y: cy.get(n.id)! - n.height / 2 }]))
}
