import { describe, expect, it } from 'vitest'
import { focusFromBlank, onScrollbar } from './focus'

const box = { left: 100, top: 50, clientWidth: 400, clientHeight: 120 }

describe('onScrollbar', () => {
  it('is false inside the text area, including its corners', () => {
    expect(onScrollbar(box, 100, 50)).toBe(false)
    expect(onScrollbar(box, 499, 169)).toBe(false)
    expect(onScrollbar(box, 300, 160)).toBe(false)
  })

  it('is true on the bottom and right scrollbars', () => {
    expect(onScrollbar(box, 300, 170)).toBe(true)
    expect(onScrollbar(box, 500, 100)).toBe(true)
  })
})

describe('focusFromBlank', () => {
  it('does nothing before the editor exists', () => {
    let prevented = false
    const took = focusFromBlank({ target: null, clientX: 0, clientY: 0, preventDefault: () => (prevented = true) }, null)
    expect(took).toBe(false)
    expect(prevented).toBe(false)
  })
})
