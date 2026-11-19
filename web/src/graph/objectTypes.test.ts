import { describe, expect, it } from 'vitest'
import { countText, isFunction, parseTypes, passesTypes, presentGroups, toggleType, typeGroup } from './objectTypes'

describe('typeGroup', () => {
  it('groups table-like types as tables', () => {
    for (const t of ['MANAGED', 'EXTERNAL', 'FOREIGN', 'STREAMING_TABLE', 'BASE TABLE', 'MANAGED_SHALLOW_CLONE', '', null, undefined]) {
      expect(typeGroup(t)).toBe('table')
    }
  })
  it('tells the view kinds apart', () => {
    expect(typeGroup('VIEW')).toBe('view')
    expect(typeGroup('MATERIALIZED_VIEW')).toBe('materialized_view')
    expect(typeGroup('materialized view')).toBe('materialized_view')
    expect(typeGroup('METRIC_VIEW')).toBe('metric_view')
  })
  it('knows functions', () => {
    expect(typeGroup('FUNCTION')).toBe('function')
    expect(isFunction('function')).toBe(true)
    expect(isFunction('VIEW')).toBe(false)
  })
})

describe('filtering and counts', () => {
  it('passes everything when nothing is selected, and only the chosen groups otherwise', () => {
    expect(passesTypes('VIEW', [])).toBe(true)
    expect(passesTypes('VIEW', ['view'])).toBe(true)
    expect(passesTypes('MANAGED', ['view'])).toBe(false)
    expect(passesTypes('FUNCTION', ['view', 'function'])).toBe(true)
  })
  it('lists the groups present', () => {
    expect([...presentGroups(['MANAGED', 'EXTERNAL', 'VIEW', 'FUNCTION'])].sort()).toEqual(['function', 'table', 'view'])
    expect(presentGroups([]).size).toBe(0)
  })
  it('writes the count as "12" or "12 of 80"', () => {
    expect(countText(80, 80)).toBe('80')
    expect(countText(12, 80)).toBe('12 of 80')
    expect(countText(0, 5)).toBe('0 of 5')
  })
})

describe('the saved selection', () => {
  it('reads a JSON array, keeps chip order and drops unknown names', () => {
    expect(parseTypes('["function","view","nope"]')).toEqual(['view', 'function'])
    expect(parseTypes(null)).toEqual([])
    expect(parseTypes('{bad')).toEqual([])
    expect(parseTypes('"view"')).toEqual([])
  })
  it('toggles a group on and off', () => {
    expect(toggleType([], 'function')).toEqual(['function'])
    expect(toggleType(['function'], 'table')).toEqual(['table', 'function'])
    expect(toggleType(['table', 'function'], 'table')).toEqual(['function'])
  })
})
