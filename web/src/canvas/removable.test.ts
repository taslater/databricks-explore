import { describe, expect, it } from 'vitest'
import { isEmptyWindow, isRemovableWindow } from './removable'

describe('isRemovableWindow', () => {
  it('removes a note with no text, or only blanks', () => {
    expect(isRemovableWindow({ type: 'note' })).toBe(true)
    expect(isRemovableWindow({ type: 'note', text: '' })).toBe(true)
    expect(isRemovableWindow({ type: 'note', text: ' \n\t' })).toBe(true)
  })

  it('keeps a note that has text', () => {
    expect(isRemovableWindow({ type: 'note', text: 'remember this' })).toBe(false)
  })

  it('removes a query window with no SQL, but keeps one with SQL or a chart', () => {
    expect(isRemovableWindow({ type: 'query', sql: '' })).toBe(true)
    expect(isRemovableWindow({ type: 'query' })).toBe(true)
    expect(isRemovableWindow({ type: 'query', sql: 'SELECT 1' })).toBe(false)
    expect(isRemovableWindow({ type: 'query', sql: '  ', chart: { vega_lite: {} } })).toBe(false)
  })

  it('always removes a table card, which can be fetched again', () => {
    expect(isRemovableWindow({ type: 'table' })).toBe(true)
  })

  it('does not treat a chart window as empty', () => {
    expect(isEmptyWindow({ type: 'chart' })).toBe(false)
    expect(isRemovableWindow({ type: 'chart' })).toBe(false)
  })
})
