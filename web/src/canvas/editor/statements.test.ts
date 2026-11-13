import { describe, expect, it } from 'vitest'
import { planRun, splitStatements, statementAt } from './statements'

const texts = (sql: string) => splitStatements(sql).map((s) => s.text)

describe('splitStatements', () => {
  it('splits on semicolons and trims', () => {
    expect(texts('select 1;\n  select 2 ;select 3')).toEqual(['select 1', 'select 2', 'select 3'])
  })

  it('returns offsets of the trimmed text and the end after the semicolon', () => {
    const sql = 'select 1;  select 2'
    const [a, b] = splitStatements(sql)
    expect(sql.slice(a.from, a.to)).toBe('select 1')
    expect(a.end).toBe(9)
    expect(sql.slice(b.from, b.to)).toBe('select 2')
    expect(b.end).toBe(sql.length)
  })

  it('ignores semicolons in strings, with escapes and doubled quotes', () => {
    expect(texts("select 'a;b'; select \"c;d\"")).toEqual(["select 'a;b'", 'select "c;d"'])
    expect(texts("select 'it\\'s;ok'; select 2")).toEqual(["select 'it\\'s;ok'", 'select 2'])
    expect(texts("select 'it''s;ok'; select 2")).toEqual(["select 'it''s;ok'", 'select 2'])
  })

  it('treats r-prefixed strings as raw (a backslash does not escape)', () => {
    expect(texts("select r'C:\\'; select 2")).toEqual(["select r'C:\\'", 'select 2'])
    // not raw: the word before the quote is a longer identifier
    expect(texts("select bar'x\\'; y'; select 2")).toEqual(["select bar'x\\'; y'", 'select 2'])
  })

  it('ignores semicolons in quoted identifiers', () => {
    expect(texts('select `a;b` from t; select 2')).toEqual(['select `a;b` from t', 'select 2'])
    expect(texts('select `a``;b` from t; select 2')).toEqual(['select `a``;b` from t', 'select 2'])
  })

  it('ignores semicolons in line and block comments, including nested ones', () => {
    expect(texts('select 1 -- a; b\n; select 2')).toEqual(['select 1 -- a; b', 'select 2'])
    expect(texts('select /* a; b */ 1; select 2')).toEqual(['select /* a; b */ 1', 'select 2'])
    expect(texts('select /* a /* x; */ y; */ 1; select 2')).toEqual(['select /* a /* x; */ y; */ 1', 'select 2'])
  })

  it('does not read comment markers inside strings', () => {
    expect(texts("select '-- not a comment'; select '/* nor this'; select 3")).toEqual([
      "select '-- not a comment'",
      "select '/* nor this'",
      'select 3',
    ])
  })

  it('keeps leading comments with their statement and drops comment-only segments', () => {
    expect(texts('-- first\nselect 1;\n/* x */\n-- y\nselect 2; -- trailing')).toEqual([
      '-- first\nselect 1',
      '/* x */\n-- y\nselect 2',
    ])
  })

  it('drops empty statements', () => {
    expect(texts(';;  ;\n')).toEqual([])
    expect(texts('')).toEqual([])
    expect(texts('select 1;;; select 2;')).toEqual(['select 1', 'select 2'])
  })

  it('keeps unterminated strings and comments to the end instead of failing', () => {
    expect(texts("select 'oops; select 2")).toEqual(["select 'oops; select 2"])
    expect(texts('select 1 /* oops; select 2')).toEqual(['select 1 /* oops; select 2'])
  })

  it('leaves {{title}} references alone', () => {
    expect(texts('select * from {{orders}}; select * from {{a b}}')).toEqual([
      'select * from {{orders}}',
      'select * from {{a b}}',
    ])
  })

  it('handles CRLF line endings', () => {
    expect(texts('select 1;\r\nselect 2;\r\n')).toEqual(['select 1', 'select 2'])
  })
})

describe('statementAt', () => {
  const sql = 'select 1;\n\nselect 2;\n\nselect 3'
  const stmts = splitStatements(sql)
  const at = (pos: number) => statementAt(stmts, pos)?.text

  it('finds the statement containing the cursor', () => {
    expect(at(3)).toBe('select 1')
    expect(at(sql.indexOf('select 2') + 4)).toBe('select 2')
    expect(at(sql.length)).toBe('select 3')
  })

  it('counts the position right after the semicolon as that statement', () => {
    expect(at(9)).toBe('select 1')
  })

  it('uses the previous statement in a gap, and the first before everything', () => {
    expect(at(10)).toBe('select 1')
    expect(statementAt(splitStatements('\n\nselect 1'), 0)?.text).toBe('select 1')
  })

  it('is null when there is nothing to run', () => {
    expect(statementAt([], 0)).toBeNull()
  })
})

describe('planRun', () => {
  const doc = 'select 1;\nselect 2;\nselect 3;'

  it('current: the statement under the cursor, with its range', () => {
    const plan = planRun(doc, 12, 12, 'current')
    expect(plan.sqls).toEqual(['select 2'])
    expect(doc.slice(plan.ranges[0].from, plan.ranges[0].to)).toBe('select 2')
  })

  it('current: a selection wins over the cursor statement', () => {
    const from = doc.indexOf('select 1')
    const to = from + 'select 1;\nselect 2'.length
    const plan = planRun(doc, from, to, 'current')
    expect(plan.sqls).toEqual(['select 1', 'select 2'])
    expect(plan.ranges.map((r) => doc.slice(r.from, r.to))).toEqual(['select 1', 'select 2'])
  })

  it('current: a selection of part of a statement runs exactly that part', () => {
    const from = doc.indexOf('select 2')
    expect(planRun(doc, from, from + 6, 'current').sqls).toEqual(['select'])
  })

  it('current: nothing to run on a blank document or comment-only selection', () => {
    expect(planRun('  \n', 1, 1, 'current').sqls).toEqual([])
    expect(planRun('-- hi\nselect 1', 0, 5, 'current').sqls).toEqual([])
  })

  it('all: every statement in order', () => {
    const plan = planRun(doc, 0, 0, 'all')
    expect(plan.sqls).toEqual(['select 1', 'select 2', 'select 3'])
    expect(plan.ranges).toHaveLength(3)
  })
})
