import { describe, expect, it } from 'vitest'
import {
  columnList,
  columnNames,
  countSql,
  describeDetailSql,
  hasDeltaLog,
  objectKind,
  quoteFullName,
  quoteIdent,
  selectSql,
  showCreateSql,
} from './scriptAs'

describe('quoteIdent', () => {
  it('leaves plain names alone', () => {
    expect(quoteIdent('order_id')).toBe('order_id')
    expect(quoteIdent('_x1')).toBe('_x1')
  })
  it('quotes names that are not plain identifiers', () => {
    expect(quoteIdent('order id')).toBe('`order id`')
    expect(quoteIdent('1st')).toBe('`1st`')
    expect(quoteIdent('my-catalog')).toBe('`my-catalog`')
    expect(quoteIdent('café')).toBe('`café`')
  })
  it('quotes reserved words, ignoring case', () => {
    expect(quoteIdent('order')).toBe('`order`')
    expect(quoteIdent('Select')).toBe('`Select`')
  })
  it('doubles a backtick inside a name', () => {
    expect(quoteIdent('a`b')).toBe('`a``b`')
  })
})

describe('quoteFullName', () => {
  it('quotes only the parts that need it', () => {
    expect(quoteFullName('dev.crm.dim_customer')).toBe('dev.crm.dim_customer')
    expect(quoteFullName('my-cat.crm.order')).toBe('`my-cat`.crm.`order`')
  })
})

describe('selectSql', () => {
  it('lists one column per line', () => {
    expect(selectSql('dev.crm.t', ['id', 'name'])).toBe('SELECT\n  id,\n  name\nFROM dev.crm.t\nLIMIT 10')
  })
  it('quotes columns that need it', () => {
    expect(selectSql('dev.crm.t', ['id', 'group', 'unit price'])).toContain('  `group`,\n  `unit price`\n')
  })
  it('falls back to * with no columns', () => {
    expect(selectSql('dev.crm.t', [], 100)).toBe('SELECT\n  *\nFROM dev.crm.t\nLIMIT 100')
  })
})

describe('other statements', () => {
  it('writes each one for the quoted name', () => {
    expect(countSql('a.b.c')).toBe('SELECT COUNT(*) AS row_count\nFROM a.b.c')
    expect(describeDetailSql('a.b.c')).toBe('DESCRIBE DETAIL a.b.c')
    expect(showCreateSql('a.b.table')).toBe('SHOW CREATE TABLE a.b.`table`')
  })
  it('lists columns separated by commas', () => {
    expect(columnList(['a', 'b c'])).toBe('a, `b c`')
  })
  it('reads names from a columns payload', () => {
    expect(columnNames([{ name: 'a' }, {}, { name: '' }, { name: 'b' }])).toEqual(['a', 'b'])
    expect(columnNames(undefined)).toEqual([])
  })
})

describe('objectKind', () => {
  it('tells the kinds apart', () => {
    expect(objectKind('MANAGED')).toBe('table')
    expect(objectKind(null)).toBe('table')
    expect(objectKind('VIEW')).toBe('view')
    expect(objectKind('METRIC_VIEW')).toBe('metric_view')
    expect(objectKind('MATERIALIZED_VIEW')).toBe('materialized_view')
    expect(objectKind('STREAMING_TABLE')).toBe('streaming_table')
  })
  it('says which kinds have a Delta log', () => {
    expect(hasDeltaLog('table')).toBe(true)
    expect(hasDeltaLog('streaming_table')).toBe(true)
    expect(hasDeltaLog('view')).toBe(false)
    expect(hasDeltaLog('metric_view')).toBe(false)
  })
})
