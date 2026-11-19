// Where edges attach along a node's side. An incoming and an outgoing edge on one side never share a point: when a side
// has both, incoming ones anchor at IN percent along it and outgoing ones at OUT (above/left in, below/right out, on
// every node, so the reader learns it once). A side with edges in one direction only keeps its center. Pure.
import type { CSSProperties } from 'react'

export type AnchorRole = 'in' | 'out'
export type AnchorSide = 't' | 'r' | 'b' | 'l'

/** Percent along a side where incoming and outgoing edges anchor when the side has both. */
export const ANCHOR_IN = 35
export const ANCHOR_OUT = 65
/** The same for a column row, which is only a few pixels tall: wider apart, so the two points still differ. */
export const ROW_ANCHOR_IN = 25
export const ROW_ANCHOR_OUT = 75

/** Percent along the side for an end: the center unless the side is split. */
export function anchorPercent(role: AnchorRole, split: boolean, inAt = ANCHOR_IN, outAt = ANCHOR_OUT): number {
  if (!split) return 50
  return role === 'in' ? inAt : outAt
}

/** The inline style that moves a handle on `side` to `percent` along it. Left and right sides move vertically, top and bottom horizontally. */
export function anchorStyle(side: AnchorSide, percent: number): CSSProperties {
  return side === 'l' || side === 'r' ? { top: `${percent}%` } : { left: `${percent}%` }
}

/** One end of a visible edge: the node, the side key it attaches on (a side, or `side:column` on a column row) and its role. */
export interface AnchorEnd {
  node: string
  key: string
  role: AnchorRole
}

/** For each node, the side keys that carry both incoming and outgoing edges. Nodes with none are left out. */
export function splitSides(ends: readonly AnchorEnd[]): Map<string, string[]> {
  const seen = new Map<string, Map<string, Set<AnchorRole>>>()
  for (const e of ends) {
    const keys = seen.get(e.node) ?? new Map<string, Set<AnchorRole>>()
    const roles = keys.get(e.key) ?? new Set<AnchorRole>()
    roles.add(e.role)
    keys.set(e.key, roles)
    seen.set(e.node, keys)
  }
  const out = new Map<string, string[]>()
  for (const [node, keys] of seen) {
    const both = [...keys].filter(([, roles]) => roles.size === 2).map(([key]) => key)
    if (both.length) out.set(node, both.sort())
  }
  return out
}
