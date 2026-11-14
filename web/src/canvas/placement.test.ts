import { describe, expect, it } from 'vitest'
import { findFreePosition, PLACEMENT_GAP, type Rect } from './placement'

const size = { w: 300, h: 200 }
const visible: Rect = { x: 0, y: 0, w: 1200, h: 800 }
const keepOut: Rect[] = [
  { x: 0, y: 0, w: 600, h: 110 },
  { x: 0, y: 0, w: 72, h: 800 },
]

function hits(a: Rect, b: Rect) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}
const rectAt = (p: { x: number; y: number }, s = size): Rect => ({ ...p, ...s })

describe('findFreePosition', () => {
  it('keeps the desired spot when nothing is in the way', () => {
    expect(findFreePosition({ desired: { x: 400, y: 300 }, size, obstacles: [], visible, keepOut })).toEqual({ x: 400, y: 300 })
  })

  it('keeps a free desired spot outside the view (a window placed beside a card off screen)', () => {
    const p = findFreePosition({ desired: { x: 5000, y: 5000 }, size, obstacles: [], visible, keepOut })
    expect(p).toEqual({ x: 5000, y: 5000 })
  })

  it('moves off an existing window, with a gap, and into the view', () => {
    const existing: Rect = { x: 400, y: 300, w: 300, h: 200 }
    const p = findFreePosition({ desired: { x: 410, y: 310 }, size, obstacles: [existing], visible, keepOut })
    expect(hits(rectAt(p), existing)).toBe(false)
    expect(p.x + size.w).toBeLessThanOrEqual(visible.w)
    expect(p.y + size.h).toBeLessThanOrEqual(visible.h)
    expect(p.x).toBeGreaterThanOrEqual(0)
  })

  it('stays clear of the toolbar and palette strips', () => {
    const p = findFreePosition({ desired: { x: 0, y: 0 }, size, obstacles: [], visible, keepOut })
    for (const k of keepOut) expect(hits(rectAt(p), k)).toBe(false)
  })

  it('does not overlap any of several windows', () => {
    const obstacles: Rect[] = [
      { x: 100, y: 150, w: 300, h: 200 },
      { x: 450, y: 150, w: 300, h: 200 },
      { x: 100, y: 400, w: 300, h: 200 },
    ]
    const p = findFreePosition({ desired: { x: 120, y: 160 }, size, obstacles, visible, keepOut })
    for (const o of obstacles) expect(hits(rectAt(p), o)).toBe(false)
  })

  it('falls back to beside a node when the view has no room (window larger than the view)', () => {
    const big = { w: 2000, h: 1500 }
    const existing: Rect = { x: 200, y: 200, w: 500, h: 400 }
    const p = findFreePosition({ desired: { x: 210, y: 210 }, size: big, obstacles: [existing], visible, keepOut })
    expect(hits(rectAt(p, big), existing)).toBe(false)
  })

  it('works without knowing the visible area', () => {
    const existing: Rect = { x: 0, y: 0, w: 300, h: 200 }
    const p = findFreePosition({ desired: { x: 0, y: 0 }, size, obstacles: [existing] })
    expect(hits(rectAt(p), existing)).toBe(false)
    expect(p.x === existing.x + existing.w + PLACEMENT_GAP || p.y === existing.y + existing.h + PLACEMENT_GAP).toBe(true)
  })

  it('always finds a place when everything nearby is full', () => {
    const obstacles: Rect[] = []
    for (let x = 0; x < 1200; x += 300) for (let y = 0; y < 800; y += 200) obstacles.push({ x, y, w: 300, h: 200 })
    const p = findFreePosition({ desired: { x: 100, y: 100 }, size, obstacles, visible, keepOut })
    for (const o of obstacles) expect(hits(rectAt(p), o)).toBe(false)
  })
})
