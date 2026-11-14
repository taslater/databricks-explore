import { describe, expect, it } from 'vitest'
import { toCanvasName } from './canvasName'

describe('toCanvasName', () => {
  it('turns spaces into dashes and keeps case', () => {
    expect(toCanvasName('Returns tour')).toBe('Returns-tour')
  })
  it('replaces other characters and collapses repeats', () => {
    expect(toCanvasName('a  b / c?? d')).toBe('a-b-c-d')
    expect(toCanvasName('q4 -- plan')).toBe('q4-plan')
  })
  it('trims dashes and spaces at either end', () => {
    expect(toCanvasName('  --draft--  ')).toBe('draft')
    expect(toCanvasName('(wip)')).toBe('wip')
  })
  it('keeps letters, digits, underscore, dot and dash', () => {
    expect(toCanvasName('Sales_v2.1-final')).toBe('Sales_v2.1-final')
  })
  it('is empty when nothing usable is left', () => {
    expect(toCanvasName('   ')).toBe('')
    expect(toCanvasName('???')).toBe('')
  })
  it('is idempotent', () => {
    const once = toCanvasName('Returns tour (v2)')
    expect(toCanvasName(once)).toBe(once)
  })
})
