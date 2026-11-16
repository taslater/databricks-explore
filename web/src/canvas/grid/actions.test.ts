import { describe, expect, it } from 'vitest'
import { prettyJson, valueCountsSql, valueFilterModel, viewerCopyText, viewerText, whereEquals } from './actions'

describe('whereEquals', () => {
  it('quotes strings and escapes quotes', () => {
    expect(whereEquals('region', 'STRING', 'EU')).toBe("WHERE region = 'EU'")
    expect(whereEquals('name', 'STRING', "O'Brien")).toBe("WHERE name = 'O\\'Brien'")
  })
  it('leaves numbers and booleans bare', () => {
    expect(whereEquals('qty', 'LONG', '42')).toBe('WHERE qty = 42')
    expect(whereEquals('ok', 'BOOLEAN', 'true')).toBe('WHERE ok = true')
  })
  it('quotes a number column value that is not a JSON number', () => {
    expect(whereEquals('qty', 'LONG', '007')).toBe("WHERE qty = '007'")
  })
  it('uses IS NULL for NULL', () => {
    expect(whereEquals('region', 'STRING', null)).toBe('WHERE region IS NULL')
  })
  it('puts a column that is not a plain identifier in backticks', () => {
    expect(whereEquals('order total', 'DOUBLE', '1.5')).toBe('WHERE `order total` = 1.5')
    expect(whereEquals('a`b', 'STRING', 'x')).toBe("WHERE `a``b` = 'x'")
  })
})

describe('prettyJson and viewerText', () => {
  it('pretty prints objects and arrays', () => {
    expect(prettyJson('{"a":1,"b":[2,3]}')).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}')
    expect(prettyJson(' [1] ')).toBe('[\n  1\n]')
  })
  it('leaves everything else alone', () => {
    expect(prettyJson('plain')).toBeNull()
    expect(prettyJson('{not json}')).toBeNull()
    expect(prettyJson('42')).toBeNull()
    expect(prettyJson(null)).toBeNull()
  })
  it('shows and copies values', () => {
    expect(viewerText(null)).toBe('NULL')
    expect(viewerCopyText(null)).toBe('')
    expect(viewerText('abc')).toBe('abc')
    expect(viewerCopyText('{"a":1}')).toBe('{\n  "a": 1\n}')
  })
})

describe('valueFilterModel', () => {
  it('text equals and notEqual', () => {
    expect(valueFilterModel('EU', 'text', 'equals')).toEqual({ filterType: 'text', type: 'equals', filter: 'EU' })
    expect(valueFilterModel('EU', 'boolean', 'notEqual')).toEqual({ filterType: 'text', type: 'notEqual', filter: 'EU' })
  })
  it('numbers compare as numbers', () => {
    expect(valueFilterModel('42.5', 'number', 'equals')).toEqual({ filterType: 'number', type: 'equals', filter: 42.5 })
    expect(valueFilterModel('abc', 'number', 'equals')).toBeNull()
  })
  it('dates compare by day', () => {
    expect(valueFilterModel('2024-05-06 07:08:09', 'timestamp', 'equals')).toEqual({
      filterType: 'date',
      type: 'equals',
      dateFrom: '2024-05-06 00:00:00',
      dateTo: null,
    })
    expect(valueFilterModel('nope', 'date', 'equals')).toBeNull()
  })
  it('NULL uses the blank filters', () => {
    expect(valueFilterModel(null, 'text', 'equals')).toEqual({ filterType: 'text', type: 'blank' })
    expect(valueFilterModel(null, 'number', 'notEqual')).toEqual({ filterType: 'number', type: 'notBlank' })
    expect(valueFilterModel(null, 'date', 'equals')).toEqual({ filterType: 'date', type: 'blank' })
  })
})

describe('valueCountsSql', () => {
  it('wraps the statement and groups by the column', () => {
    expect(valueCountsSql('SELECT * FROM t;', 'region')).toBe(
      'SELECT region, count(*) AS n\nFROM (\nSELECT * FROM t\n)\nGROUP BY region\nORDER BY n DESC',
    )
  })
  it('strips repeated trailing semicolons and keeps a trailing comment from eating the bracket', () => {
    const sql = valueCountsSql('SELECT 1 AS x -- note\n;;  ', 'x')
    expect(sql).toContain('SELECT 1 AS x -- note\n)')
  })
  it('backticks an awkward column name', () => {
    expect(valueCountsSql('SELECT 1', 'my col')).toContain('SELECT `my col`, count(*) AS n')
  })
})
