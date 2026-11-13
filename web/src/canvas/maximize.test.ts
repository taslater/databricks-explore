import { describe, expect, it } from 'vitest'
import { MAX_INSET, maximizedFrame } from './maximize'

describe('maximizedFrame', () => {
  const box = { width: 1000, height: 700 }

  it('fills the canvas box at zoom 1 with no pan', () => {
    const f = maximizedFrame({ x: 0, y: 0, zoom: 1 }, box)
    expect(f.position).toEqual({ x: MAX_INSET.side, y: MAX_INSET.top })
    expect(f.size).toEqual({ w: 1000 - 2 * MAX_INSET.side, h: 700 - MAX_INSET.top - MAX_INSET.bottom })
  })

  it('follows the pan: the top-left corner lands on the visible top-left', () => {
    const f = maximizedFrame({ x: -300, y: -120, zoom: 1 }, box)
    expect(f.position).toEqual({ x: 300 + MAX_INSET.side, y: 120 + MAX_INSET.top })
  })

  it('scales with zoom so it still fills the screen box', () => {
    const view = { x: -200, y: -100, zoom: 0.5 }
    const f = maximizedFrame(view, box)
    // On screen: position * zoom + pan, size * zoom.
    expect(f.position.x * view.zoom + view.x).toBeCloseTo(MAX_INSET.side)
    expect(f.position.y * view.zoom + view.y).toBeCloseTo(MAX_INSET.top)
    expect(f.size.w * view.zoom).toBeCloseTo(1000 - 2 * MAX_INSET.side)
    expect(f.size.h * view.zoom).toBeCloseTo(700 - MAX_INSET.top - MAX_INSET.bottom)
  })

  it('never goes negative in a tiny box', () => {
    const f = maximizedFrame({ x: 0, y: 0, zoom: 1 }, { width: 10, height: 10 })
    expect(f.size).toEqual({ w: 0, h: 0 })
  })
})
