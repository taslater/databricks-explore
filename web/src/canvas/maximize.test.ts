import { describe, expect, it } from 'vitest'
import { MAX_INSET, maximizedFrame } from './maximize'

describe('maximizedFrame', () => {
  const box = { width: 1000, height: 700 }
  const sideSum = MAX_INSET.left + MAX_INSET.right
  const vertSum = MAX_INSET.top + MAX_INSET.bottom

  it('fills the canvas box at zoom 1 with no pan', () => {
    const f = maximizedFrame({ x: 0, y: 0, zoom: 1 }, box)
    expect(f.position).toEqual({ x: MAX_INSET.left, y: MAX_INSET.top })
    expect(f.size).toEqual({ w: 1000 - sideSum, h: 700 - vertSum })
  })

  it('follows the pan: the top-left corner lands on the visible top-left', () => {
    const f = maximizedFrame({ x: -300, y: -120, zoom: 1 }, box)
    expect(f.position).toEqual({ x: 300 + MAX_INSET.left, y: 120 + MAX_INSET.top })
  })

  it('scales with zoom so it still fills the screen box', () => {
    const view = { x: -200, y: -100, zoom: 0.5 }
    const f = maximizedFrame(view, box)
    // On screen: position * zoom + pan, size * zoom.
    expect(f.position.x * view.zoom + view.x).toBeCloseTo(MAX_INSET.left)
    expect(f.position.y * view.zoom + view.y).toBeCloseTo(MAX_INSET.top)
    expect(f.size.w * view.zoom).toBeCloseTo(1000 - sideSum)
    expect(f.size.h * view.zoom).toBeCloseTo(700 - vertSum)
  })

  it('stays clear of a floating panel: the left inset moves the window right and narrows it', () => {
    const insets = { top: 8, right: 8, bottom: 8, left: 60 }
    const f = maximizedFrame({ x: 0, y: 0, zoom: 1 }, box, insets)
    expect(f.position.x).toBe(60)
    expect(f.position.x + f.size.w).toBe(1000 - 8)
  })

  it('never goes negative in a tiny box', () => {
    const f = maximizedFrame({ x: 0, y: 0, zoom: 1 }, { width: 10, height: 10 })
    expect(f.size).toEqual({ w: 0, h: 0 })
  })
})
