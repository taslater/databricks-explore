import { describe, expect, it, vi } from 'vitest'
import { focusAtEnd, keepInputFocus } from './pickerFocus'

describe('keepInputFocus', () => {
  it('cancels the mouse down, which is what moves focus to the clicked row', () => {
    const e = { preventDefault: vi.fn() }
    keepInputFocus(e)
    expect(e.preventDefault).toHaveBeenCalledOnce()
  })
})

describe('focusAtEnd', () => {
  it('focuses the box with the caret after the path', () => {
    const input = { value: 'dev.hr.', focus: vi.fn(), setSelectionRange: vi.fn() }
    focusAtEnd(input)
    expect(input.focus).toHaveBeenCalledOnce()
    expect(input.setSelectionRange).toHaveBeenCalledWith(7, 7)
  })
  it('does nothing without a box', () => {
    expect(() => focusAtEnd(null)).not.toThrow()
  })
})
