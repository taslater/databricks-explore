import { describe, expect, it } from 'vitest'
import { findFreePosition, PLACEMENT_GAP, type Rect, revealViewport } from './placement'

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

describe('revealViewport', () => {
  const screen = { w: 1200, h: 800 }
  const vp = { x: 0, y: 0, zoom: 1 }

  it('leaves the view alone when the node is already fully visible', () => {
    expect(revealViewport({ x: 200, y: 200, w: 300, h: 200 }, vp, screen)).toBeNull()
  })

  it('pans a node below the view into the middle of the free space, at the same zoom', () => {
    const next = revealViewport({ x: 200, y: 1500, w: 300, h: 200 }, vp, screen)
    expect(next).not.toBeNull()
    const { x, y, zoom } = next!
    expect(zoom).toBe(1)
    // On screen the node now sits between the margins: left 88, top 120, right 24, bottom 80.
    const sx = 200 + x
    const sy = 1500 + y
    expect(sx).toBeGreaterThanOrEqual(88)
    expect(sy).toBeGreaterThanOrEqual(120)
    expect(sx + 300).toBeLessThanOrEqual(1200 - 24)
    expect(sy + 200).toBeLessThanOrEqual(800 - 80)
  })

  it('shows a node too big for the space from its top-left corner, so the title bar is visible', () => {
    const next = revealViewport({ x: 5000, y: 5000, w: 3000, h: 3000 }, { x: 0, y: 0, zoom: 0.5 }, screen)!
    expect(5000 * 0.5 + next.x).toBe(88)
    expect(5000 * 0.5 + next.y).toBe(120)
    expect(next.zoom).toBe(0.5)
  })

  it('counts a node under the palette or toolbars as not visible', () => {
    expect(revealViewport({ x: 10, y: 10, w: 100, h: 100 }, vp, screen)).not.toBeNull()
  })
})
