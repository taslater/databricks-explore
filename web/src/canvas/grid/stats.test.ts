import { describe, expect, it } from 'vitest'
import { computeStats, formatStat, parseNumber } from './stats'

describe('parseNumber', () => {
  it('reads plain numbers and nothing else', () => {
    expect(parseNumber('12')).toBe(12)
    expect(parseNumber(' -3.5 ')).toBe(-3.5)
    expect(parseNumber('1e3')).toBe(1000)
    expect(parseNumber('.5')).toBe(0.5)
    expect(parseNumber('')).toBeNull()
    expect(parseNumber('0x10')).toBeNull()
    expect(parseNumber('NaN')).toBeNull()
    expect(parseNumber('Infinity')).toBeNull()
    expect(parseNumber('12abc')).toBeNull()
    expect(parseNumber(null)).toBeNull()
  })
})

describe('computeStats', () => {
  it('counts cells, distinct values and NULLs', () => {
    const s = computeStats(['a', 'b', 'a', null, ''], false)
    expect(s).toEqual({ count: 5, distinct: 3, nulls: 1, numeric: null })
  })
  it('adds sum, average, min and max for numbers', () => {
    const s = computeStats(['1', '2.5', null, '10'], true)
    expect(s.count).toBe(4)
    expect(s.nulls).toBe(1)
    expect(s.numeric).toEqual({ n: 3, sum: 13.5, avg: 4.5, min: 1, max: 10 })
  })
  it('skips values that are not numbers', () => {
    const s = computeStats(['1', 'x', '3'], true)
    expect(s.numeric?.n).toBe(2)
    expect(s.numeric?.sum).toBe(4)
  })
  it('has no numeric stats when no cell is a number', () => {
    expect(computeStats([null, 'x'], true).numeric).toBeNull()
  })
})

describe('formatStat', () => {
  it('drops float noise and groups thousands', () => {
    expect(formatStat(0.1 + 0.2)).toBe('0.3')
    expect(formatStat(1234567.891)).toBe('1,234,567.891')
    expect(formatStat(-42)).toBe('-42')
    expect(formatStat(0)).toBe('0')
  })
  it('uses exponent form for huge and tiny values', () => {
    expect(formatStat(1.5e20)).toBe('1.5e+20')
    expect(formatStat(2e-12)).toBe('2e-12')
  })
  it('does not print more than about 12 significant digits', () => {
    expect(formatStat(1 / 3)).toBe('0.333333333333'.slice(0, 12))
  })
})
