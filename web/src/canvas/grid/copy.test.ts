import { describe, expect, it } from 'vitest'
import {
  cellText,
  columnText,
  csvField,
  formatTable,
  jsonValue,
  markdownField,
  rowText,
  sqlIdentifier,
  sqlLiteral,
  tsvField,
  type CopyTable,
} from './copy'

const table: CopyTable = {
  columns: [
    { name: 'id', type: 'LONG' },
    { name: 'note', type: 'STRING' },
    { name: 'amount', type: 'DECIMAL' },
  ],
  rows: [
    ['1', 'plain', '10.50'],
    ['2', null, '99999999999999999999.123456789012'],
    ['3', '', null],
  ],
}

describe('field quoting', () => {
  it('tsvField quotes tabs, newlines and quotes, and treats NULL and empty alike', () => {
    expect(tsvField('a b')).toBe('a b')
    expect(tsvField('a\tb')).toBe('"a\tb"')
    expect(tsvField('line1\nline2')).toBe('"line1\nline2"')
    expect(tsvField('carriage\rreturn')).toBe('"carriage\rreturn"')
    expect(tsvField('say "hi"')).toBe('"say ""hi"""')
    expect(tsvField(null)).toBe('')
    expect(tsvField('')).toBe('')
  })

  it('csvField quotes commas, quotes and line breaks, and keeps NULL apart from the empty string', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('a\nb')).toBe('"a\nb"')
    expect(csvField('tab\there')).toBe('tab\there')
    expect(csvField(null)).toBe('')
    expect(csvField('')).toBe('""')
  })

  it('markdownField escapes pipes and backslashes and flattens line breaks and tabs', () => {
    expect(markdownField('a|b')).toBe('a\\|b')
    expect(markdownField('a\\b')).toBe('a\\\\b')
    expect(markdownField('a\nb\r\nc')).toBe('a<br>b<br>c')
    expect(markdownField('a\tb')).toBe('a b')
    expect(markdownField(null)).toBe('')
  })

  it('cellText gives the empty string for NULL', () => {
    expect(cellText(null)).toBe('')
    expect(cellText('x')).toBe('x')
  })
})

describe('jsonValue', () => {
  it('keeps number text exact and falls back to a string for invalid JSON numbers', () => {
    expect(jsonValue('10.50', 'DECIMAL')).toBe('10.50')
    expect(jsonValue('99999999999999999999.123456789012', 'DECIMAL')).toBe('99999999999999999999.123456789012')
    expect(jsonValue('1E3', 'DOUBLE')).toBe('1E3')
    expect(jsonValue('007', 'LONG')).toBe('"007"')
    expect(jsonValue('NaN', 'DOUBLE')).toBe('"NaN"')
  })
  it('handles booleans, NULL and escaping', () => {
    expect(jsonValue('true', 'BOOLEAN')).toBe('true')
    expect(jsonValue(null, 'STRING')).toBe('null')
    expect(jsonValue('', 'STRING')).toBe('""')
    expect(jsonValue('a\t"b"\n', 'STRING')).toBe('"a\\t\\"b\\"\\n"')
    expect(jsonValue('5', 'STRING')).toBe('"5"')
  })
})

describe('SQL helpers', () => {
  it('sqlLiteral escapes for Databricks and leaves numbers bare', () => {
    expect(sqlLiteral("it's", 'STRING')).toBe("'it\\'s'")
    expect(sqlLiteral('back\\slash', 'STRING')).toBe("'back\\\\slash'")
    expect(sqlLiteral('12.50', 'DECIMAL')).toBe('12.50')
    expect(sqlLiteral('12abc', 'LONG')).toBe("'12abc'")
    expect(sqlLiteral('2026-03-01', 'DATE')).toBe("'2026-03-01'")
    expect(sqlLiteral('true', 'BOOLEAN')).toBe('true')
    expect(sqlLiteral(null, 'STRING')).toBe('NULL')
    expect(sqlLiteral('a\nb', 'STRING')).toBe("'a\nb'")
  })
  it('sqlIdentifier backticks anything that is not a plain identifier', () => {
    expect(sqlIdentifier('order_id')).toBe('order_id')
    expect(sqlIdentifier('order id')).toBe('`order id`')
    expect(sqlIdentifier('a`b')).toBe('`a``b`')
    expect(sqlIdentifier('1abc')).toBe('`1abc`')
  })
})

describe('formatTable', () => {
  it('tsv with and without headers', () => {
    expect(formatTable(table, 'tsv', { headers: true })).toBe(
      'id\tnote\tamount\n1\tplain\t10.50\n2\t\t99999999999999999999.123456789012\n3\t\t',
    )
    expect(formatTable(table, 'tsv', { headers: false })).toBe(
      '1\tplain\t10.50\n2\t\t99999999999999999999.123456789012\n3\t\t',
    )
  })

  it('tsv keeps rows intact when values hold tabs and newlines', () => {
    const t: CopyTable = { columns: [{ name: 'a', type: 'STRING' }, { name: 'b', type: 'STRING' }], rows: [['x\ty', 'l1\nl2']] }
    expect(formatTable(t, 'tsv', { headers: false })).toBe('"x\ty"\t"l1\nl2"')
  })

  it('csv', () => {
    expect(formatTable(table, 'csv', { headers: true })).toBe(
      'id,note,amount\n1,plain,10.50\n2,,99999999999999999999.123456789012\n3,"",',
    )
    expect(formatTable(table, 'csv', { headers: false }).split('\n')).toHaveLength(3)
  })

  it('csv quotes header names too', () => {
    const t: CopyTable = { columns: [{ name: 'a,b', type: 'STRING' }], rows: [['1']] }
    expect(formatTable(t, 'csv', { headers: true })).toBe('"a,b"\n1')
  })

  it('markdown aligns numbers right; without headers the header row is empty', () => {
    expect(formatTable(table, 'markdown', { headers: true })).toBe(
      '| id | note | amount |\n| ---: | --- | ---: |\n| 1 | plain | 10.50 |\n' +
        '| 2 |  | 99999999999999999999.123456789012 |\n| 3 |  |  |',
    )
    expect(formatTable(table, 'markdown', { headers: false }).split('\n')[0]).toBe('|  |  |  |')
  })

  it('json objects with headers, arrays without, numbers exact, NULL as null', () => {
    expect(formatTable(table, 'json', { headers: true })).toBe(
      '[\n  {"id": 1, "note": "plain", "amount": 10.50},\n' +
        '  {"id": 2, "note": null, "amount": 99999999999999999999.123456789012},\n' +
        '  {"id": 3, "note": "", "amount": null}\n]',
    )
    expect(JSON.parse(formatTable(table, 'json', { headers: false }))[0]).toEqual([1, 'plain', 10.5])
    expect(formatTable({ ...table, rows: [] }, 'json', { headers: true })).toBe('[]')
  })

  it('json makes repeated column names unique', () => {
    const t: CopyTable = { columns: [{ name: 'a', type: 'LONG' }, { name: 'a', type: 'LONG' }], rows: [['1', '2']] }
    expect(JSON.parse(formatTable(t, 'json', { headers: true }))).toEqual([{ a: 1, a_2: 2 }])
  })

  it('sql-in lists the clicked column, drops NULL and repeats, escapes quotes', () => {
    const t: CopyTable = {
      columns: [{ name: 'name', type: 'STRING' }],
      rows: [["O'Brien"], ['x'], [null], ['x'], ['']],
    }
    expect(formatTable(t, 'sql-in', { headers: false })).toBe("('O\\'Brien', 'x', '')")
    expect(formatTable(t, 'sql-in', { headers: true })).toBe("name IN ('O\\'Brien', 'x', '')")
    expect(formatTable(table, 'sql-in', { headers: true, column: 0 })).toBe('id IN (1, 2, 3)')
    expect(formatTable(table, 'sql-in', { headers: false, column: 2 })).toBe('(10.50, 99999999999999999999.123456789012)')
  })
})

describe('columnText and rowText', () => {
  it('column: one value per line, NULL as an empty line', () => {
    expect(columnText(table, 1)).toBe('plain\n\n')
  })
  it('row: tab separated with quoting', () => {
    expect(rowText(['1', 'a\tb', null])).toBe('1\t"a\tb"\t')
  })
})
