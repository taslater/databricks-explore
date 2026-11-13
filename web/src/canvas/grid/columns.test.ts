import { describe, expect, it } from 'vitest'
import {
  buildColumnDefs,
  cellClasses,
  columnKind,
  compareNumeric,
  compareText,
  dateFilterComparator,
  displayValue,
  filterNumber,
  formatTimestamp,
  headerMinWidth,
  MAX_AUTO_WIDTH,
} from './columns'

describe('columnKind', () => {
  it('maps warehouse type names to kinds', () => {
    expect(['LONG', 'INT', 'SHORT', 'BYTE', 'DECIMAL', 'DOUBLE', 'FLOAT'].map(columnKind)).toEqual(Array(7).fill('number'))
    expect(columnKind('DATE')).toBe('date')
    expect(columnKind('TIMESTAMP')).toBe('timestamp')
    expect(columnKind('timestamp_ntz')).toBe('timestamp')
    expect(columnKind('BOOLEAN')).toBe('boolean')
    expect(['STRING', 'ARRAY', 'STRUCT', 'MAP', 'BINARY', undefined].map(columnKind)).toEqual(Array(6).fill('text'))
  })
})

describe('formatTimestamp', () => {
  it('drops the T and an all-zero fraction, keeps the zone', () => {
    expect(formatTimestamp('2026-03-01T12:34:56.000Z')).toBe('2026-03-01 12:34:56Z')
    expect(formatTimestamp('2026-03-01T12:34:56.000000Z')).toBe('2026-03-01 12:34:56Z')
    expect(formatTimestamp('2026-03-01T12:34:56Z')).toBe('2026-03-01 12:34:56Z')
  })
  it('keeps a real fraction exactly, including trailing zeros', () => {
    expect(formatTimestamp('2026-03-01T12:34:56.789Z')).toBe('2026-03-01 12:34:56.789Z')
    expect(formatTimestamp('2026-03-01T12:34:56.120Z')).toBe('2026-03-01 12:34:56.120Z')
  })
  it('does not convert time zones', () => {
    expect(formatTimestamp('2026-03-01T23:59:59.5+02:00')).toBe('2026-03-01 23:59:59.5+02:00')
  })
  it('passes unrecognized text through', () => {
    expect(formatTimestamp('not a timestamp')).toBe('not a timestamp')
  })
})

describe('displayValue', () => {
  it('shows NULL for null and nothing for an empty string', () => {
    expect(displayValue(null, 'text')).toBe('NULL')
    expect(displayValue(undefined, 'number')).toBe('NULL')
    expect(displayValue('', 'text')).toBe('')
    expect(displayValue('NULL', 'text')).toBe('NULL') // the text "NULL" looks the same; the dim style tells them apart
  })
  it('does not touch numbers', () => {
    expect(displayValue('99999999999999999999.123456789012', 'number')).toBe('99999999999999999999.123456789012')
    expect(displayValue('1.50', 'number')).toBe('1.50')
  })
})

describe('cellClasses', () => {
  it('marks NULL and numbers', () => {
    expect(cellClasses(null, 'number')).toEqual(['qw-null', 'qw-num'])
    expect(cellClasses('', 'text')).toEqual([])
    expect(cellClasses('5', 'number')).toEqual(['qw-num'])
  })
})

describe('compareNumeric', () => {
  const sorted = (xs: (string | null)[]) => [...xs].sort(compareNumeric)
  it('sorts numerically, not as text', () => {
    expect(sorted(['10', '9', '100', '-3', '2.5'])).toEqual(['-3', '2.5', '9', '10', '100'])
  })
  it('is exact beyond double precision', () => {
    expect(compareNumeric('99999999999999999999.123456789012', '99999999999999999999.123456789011')).toBe(1)
    expect(compareNumeric('9007199254740993', '9007199254740992')).toBe(1)
  })
  it('treats trailing zeros and signs sensibly', () => {
    expect(compareNumeric('1.50', '1.5')).toBe(0)
    expect(compareNumeric('-0.0', '0')).toBe(0)
    expect(compareNumeric('-5', '-10')).toBe(1)
    expect(compareNumeric('007', '7')).toBe(0)
  })
  it('handles exponent forms and NaN as numbers or text', () => {
    expect(compareNumeric('1E3', '999')).toBe(1)
    expect(compareNumeric('NaN', '5')).not.toBe(0)
  })
  it('puts NULL lowest', () => {
    expect(sorted(['3', null, '-1'])).toEqual([null, '-1', '3'])
    expect(compareNumeric(null, null)).toBe(0)
  })
})

describe('compareText', () => {
  it('orders ISO dates chronologically with NULL lowest', () => {
    expect([...['2026-03-01', null, '2025-12-31']].sort(compareText)).toEqual([null, '2025-12-31', '2026-03-01'])
  })
})

describe('filterNumber', () => {
  it('reads numbers and returns null otherwise', () => {
    expect(filterNumber('12.50')).toBe(12.5)
    expect(filterNumber('1E3')).toBe(1000)
    expect(filterNumber(null)).toBeNull()
    expect(filterNumber('')).toBeNull()
    expect(filterNumber('abc')).toBeNull()
  })
})

describe('dateFilterComparator', () => {
  const day = new Date(2026, 2, 1) // March 1, local midnight
  it('compares the calendar date only', () => {
    expect(dateFilterComparator(day, '2026-02-28')).toBe(-1)
    expect(dateFilterComparator(day, '2026-03-01')).toBe(0)
    expect(dateFilterComparator(day, '2026-03-01T23:59:59.999Z')).toBe(0)
    expect(dateFilterComparator(day, '2026-03-02T00:00:00Z')).toBe(1)
  })
  it('sorts NULL and junk before the picked day', () => {
    expect(dateFilterComparator(day, null)).toBe(-1)
    expect(dateFilterComparator(day, 'oops')).toBe(-1)
  })
})

describe('headerMinWidth', () => {
  it('fits the name plus icons, within limits', () => {
    expect(headerMinWidth('id')).toBe(80)
    expect(headerMinWidth('customer_id')).toBe(11 * 8 + 64)
    expect(headerMinWidth('x'.repeat(200))).toBe(MAX_AUTO_WIDTH)
  })
})

describe('buildColumnDefs', () => {
  const defs = buildColumnDefs([
    { name: 'id', type: 'LONG' },
    { name: 'a.b', type: 'DECIMAL' },
    { name: 'day', type: 'DATE' },
    { name: 'ts', type: 'TIMESTAMP' },
    { name: 'label', type: 'STRING' },
  ])
  it('keys fields by position so dotted names are safe', () => {
    expect(defs.map((d) => d.field)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4'])
    expect(defs[1].headerName).toBe('a.b')
  })
  it('picks a filter per kind', () => {
    expect(defs.map((d) => d.filter)).toEqual([
      'agNumberColumnFilter',
      'agNumberColumnFilter',
      'agDateColumnFilter',
      'agDateColumnFilter',
      undefined,
    ])
  })
  it('gives number columns a numeric comparator and a numeric filter value', () => {
    expect(defs[0].comparator).toBe(compareNumeric)
    const getter = defs[0].filterValueGetter as (p: { data: Record<string, string | null> }) => number | null
    expect(getter({ data: { c0: '42' } })).toBe(42)
  })
})
