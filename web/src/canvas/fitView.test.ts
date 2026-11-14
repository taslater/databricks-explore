import { describe, expect, it } from 'vitest'
import { contentBounds, fitViewport, insetsFor } from './fitView'

const wrap = { left: 0, top: 100, right: 1000, bottom: 700 }
const none = { top: 0, right: 0, bottom: 0, left: 0 }

describe('contentBounds', () => {
  it('is null with no boxes and spans all boxes otherwise', () => {
    expect(contentBounds([])).toBeNull()
    expect(
      contentBounds([
        { x: 0, y: 0, w: 100, h: 50 },
        { x: 300, y: -20, w: 100, h: 50 },
      ]),
    ).toEqual({ x: 0, y: -20, w: 400, h: 70 })
  })
})

describe('insetsFor', () => {
  it('measures how far each panel reaches into the canvas, plus a gap', () => {
    const insets = insetsFor(wrap, [
      { side: 'top', rect: { left: 600, top: 108, right: 990, bottom: 148 } },
      { side: 'left', rect: { left: 8, top: 300, right: 48, bottom: 500 } },
      { side: 'bottom', rect: { left: 400, top: 640, right: 600, bottom: 690 } },
    ])
    expect(insets).toEqual({ top: 48 + 12, left: 48 + 12, bottom: 60 + 12, right: 0 })
  })

  it('keeps the largest of several panels on one side and skips empty ones', () => {
    const insets = insetsFor(wrap, [
      { side: 'top', rect: { left: 0, top: 100, right: 200, bottom: 130 } },
      { side: 'top', rect: { left: 500, top: 100, right: 900, bottom: 160 } },
      { side: 'left', rect: { left: 0, top: 0, right: 0, bottom: 0 } },
    ])
    expect(insets.top).toBe(60 + 12)
    expect(insets.left).toBe(0)
  })
})

describe('fitViewport', () => {
  const size = { width: 1000, height: 600 }

  it('does not zoom past 100% for small content, and centers it', () => {
    const vp = fitViewport({ x: 0, y: 0, w: 200, h: 100 }, size, none)
    expect(vp.zoom).toBe(1)
    expect(vp.x).toBeCloseTo(500 - 100)
    expect(vp.y).toBeCloseTo(300 - 50)
  })

  it('shrinks large content to fit and never below the minimum', () => {
    const vp = fitViewport({ x: 0, y: 0, w: 4000, h: 1000 }, size, none)
    expect(vp.zoom).toBeCloseTo((1000 - 48) / 4000)
    expect(fitViewport({ x: 0, y: 0, w: 1e6, h: 1e6 }, size, none).zoom).toBe(0.1)
  })

  it('centers the content in the area the toolbars leave free', () => {
    const insets = { top: 60, right: 0, bottom: 0, left: 80 }
    const vp = fitViewport({ x: 0, y: 0, w: 200, h: 100 }, size, insets)
    // Free area: x from 80 to 1000, y from 60 to 600.
    expect(vp.x + 100 * vp.zoom).toBeCloseTo(80 + 920 / 2)
    expect(vp.y + 50 * vp.zoom).toBeCloseTo(60 + 540 / 2)
  })

  it('keeps the content out of the inset bands when it fills the view', () => {
    const insets = { top: 60, right: 0, bottom: 72, left: 80 }
    const bounds = { x: 0, y: 0, w: 3000, h: 2000 }
    const vp = fitViewport(bounds, size, insets)
    expect(vp.x).toBeGreaterThanOrEqual(80)
    expect(vp.y).toBeGreaterThanOrEqual(60)
    expect(vp.x + bounds.w * vp.zoom).toBeLessThanOrEqual(1000)
    expect(vp.y + bounds.h * vp.zoom).toBeLessThanOrEqual(600 - 72)
  })

  it('ignores the insets when they leave almost no room', () => {
    const vp = fitViewport({ x: 0, y: 0, w: 200, h: 100 }, { width: 300, height: 300 }, { top: 0, right: 0, bottom: 0, left: 250 })
    expect(vp.x + 100 * vp.zoom).toBeCloseTo(150)
  })
})
