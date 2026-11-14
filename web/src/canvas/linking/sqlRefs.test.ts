import { describe, expect, it } from 'vitest'
import { joinContext, quoteName, resolveName, resolveRefs, statementBeforeCursor, tokenize } from './sqlRefs'

const names = (sql: string) => joinContext(sql)?.refs.map((r) => [r.parts?.join('.') ?? null, r.alias])

describe('tokenize', () => {
  it('reads words, backticked names, punctuation and skips comments', () => {
    const { tokens, open } = tokenize('a.`my-b` -- c\n /* d */ = 1')
    expect(open).toBe(false)
    expect(tokens.map((t) => t.text)).toEqual(['a', '.', 'my-b', '=', '1'])
  })

  it('keeps a doubled backtick inside a quoted name', () => {
    expect(tokenize('`a``b`').tokens[0].text).toBe('a`b')
  })

  it('says so when the text ends inside a string, comment or quoted name', () => {
    expect(tokenize("x = 'abc").open).toBe(true)
    expect(tokenize('x /* abc').open).toBe(true)
    expect(tokenize('x `abc').open).toBe(true)
    expect(tokenize("x = 'it\\'s' y").open).toBe(false)
  })
})

describe('joinContext: tables and aliases', () => {
  it('reads aliases written with and without AS, and falls back to the last part of the name', () => {
    expect(names('SELECT * FROM a.b.returns r JOIN a.b.order_items AS oi JOIN a.b.sku ON ')).toEqual([
      ['a.b.returns', 'r'],
      ['a.b.order_items', 'oi'],
      ['a.b.sku', 'sku'],
    ])
  })

  it('reads quoted names and short names', () => {
    expect(names('SELECT 1 FROM `my-cat`.sales.`odd name` o JOIN items ON ')).toEqual([
      ['my-cat.sales.odd name', 'o'],
      ['items', 'items'],
    ])
  })

  it('does not take a join keyword for an alias', () => {
    expect(names('FROM a.b.t LEFT OUTER JOIN a.b.u ON ')).toEqual([
      ['a.b.t', 't'],
      ['a.b.u', 'u'],
    ])
  })

  it('reads a comma list in FROM', () => {
    expect(names('FROM a.b.t x, a.b.u y JOIN a.b.v ON ')).toEqual([
      ['a.b.t', 'x'],
      ['a.b.u', 'y'],
      ['a.b.v', 'v'],
    ])
  })

  it('keeps a derived table as an alias with no name, and ignores its inside', () => {
    expect(names('FROM (SELECT * FROM a.b.inner_t) d JOIN a.b.u ON ')).toEqual([
      [null, 'd'],
      ['a.b.u', 'u'],
    ])
  })

  it('only sees the tables of the SELECT the cursor is in', () => {
    expect(names('SELECT * FROM a.b.t x JOIN (SELECT * FROM a.b.p q JOIN a.b.r s ON ')).toEqual([
      ['a.b.p', 'q'],
      ['a.b.r', 's'],
    ])
    expect(names('SELECT * FROM a.b.t x WHERE x.id IN (SELECT id FROM a.b.p) ORDER BY 1 FROM a.b.z JOIN a.b.w ON ')).toEqual(
      [
        ['a.b.t', 'x'],
        ['a.b.z', 'z'],
        ['a.b.w', 'w'],
      ],
    )
  })

  it('starts over after UNION', () => {
    expect(names('SELECT 1 FROM a.b.t x UNION ALL SELECT 1 FROM a.b.u y JOIN a.b.v z ON ')).toEqual([
      ['a.b.u', 'y'],
      ['a.b.v', 'z'],
    ])
  })

  it('ignores FROM and JOIN inside strings and comments', () => {
    expect(names("SELECT 'FROM x' FROM a.b.t x -- JOIN nope\nJOIN a.b.u y ON ")).toEqual([
      ['a.b.t', 'x'],
      ['a.b.u', 'y'],
    ])
  })
})

describe('joinContext: where the cursor is', () => {
  it('is on right after ON, with partial input typed', () => {
    expect(joinContext('FROM a.b.t x JOIN a.b.u y ON ')?.spot).toBe('on')
    const partial = joinContext('FROM a.b.t x JOIN a.b.u y ON x.o')
    expect(partial?.spot).toBe('on')
    expect(partial?.typed).toBe('x.o')
  })

  it('is not on once a condition has started', () => {
    expect(joinContext('FROM a.b.t x JOIN a.b.u y ON x.id = ')).toBeNull()
    expect(joinContext('FROM a.b.t x JOIN a.b.u y ON x.id = y.id AND ')).toBeNull()
  })

  it('needs two tables for a condition', () => {
    expect(joinContext('FROM a.b.t x ON ')).toBeNull()
  })

  it('is using right after USING (, and after a comma in the list', () => {
    expect(joinContext('FROM a.b.t x JOIN a.b.u y USING (')?.spot).toBe('using')
    expect(joinContext('FROM a.b.t x JOIN a.b.u y USING (id, ')).toMatchObject({ spot: 'using', afterComma: true })
    expect(joinContext('FROM a.b.t x JOIN a.b.u y USING (id)')).toBeNull()
    expect(joinContext('FROM a.b.t x JOIN a.b.u y USING (id ')).toBeNull()
  })

  it('is join after JOIN with a table before it, and not after the first FROM', () => {
    expect(joinContext('SELECT * FROM a.b.t x JOIN ')?.spot).toBe('join')
    expect(joinContext('SELECT * FROM a.b.t x LEFT JOIN ret')).toMatchObject({ spot: 'join', typed: 'ret' })
    expect(joinContext('SELECT * FROM ')).toBeNull()
    expect(joinContext('SELECT * FROM a.b.t x JOIN a.b.')).toBeNull() // a dotted name is the name source's
  })

  it('gives nothing inside a string or comment, or while a keyword is being typed', () => {
    expect(joinContext("SELECT * FROM a.b.t x JOIN a.b.u y ON 'abc")).toBeNull()
    expect(joinContext('SELECT * FROM a.b.t x JOIN a.b.u y ON /* ')).toBeNull()
    expect(joinContext('SELECT * FROM a.b.t x JOIN a.b.u y ON')).toBeNull()
  })

  it('works on the statement the cursor is in', () => {
    const doc = 'SELECT 1 FROM x.y.old o;\nSELECT * FROM a.b.t x JOIN a.b.u y ON '
    expect(joinContext(statementBeforeCursor(doc, doc.length))?.refs).toHaveLength(2)
    expect(statementBeforeCursor('SELECT 1;', 9)).toBe('')
    expect(statementBeforeCursor('', 0)).toBe('')
  })
})

describe('resolveName', () => {
  it('keeps a three-part name, with the case the catalog uses', () => {
    expect(resolveName(['a', 'b', 'T'], [], ['a.b.t'])).toBe('a.b.t')
    expect(resolveName(['a', 'b', 'c'], [])).toBe('a.b.c')
  })

  it('borrows catalog and schema from a table written in full', () => {
    expect(resolveName(['order_items'], ['a.b.returns'])).toBe('a.b.order_items')
    expect(resolveName(['sales', 'order_items'], ['a.b.returns'])).toBe('a.sales.order_items')
  })

  it('needs the cache to choose between several schemas, and refuses to guess otherwise', () => {
    const full = ['a.b.returns', 'a.c.skus']
    expect(resolveName(['t'], full)).toBeNull()
    expect(resolveName(['t'], full, ['a.c.t'])).toBe('a.c.t')
    expect(resolveName(['t'], [])).toBeNull()
    expect(resolveName(['w', 'x', 'y', 'z'], full)).toBeNull()
  })

  it('resolves every ref of a context, derived tables to null', () => {
    const ctx = joinContext('FROM a.b.returns r JOIN order_items oi JOIN (SELECT 1) d JOIN `a`.b.z ON ')!
    expect(resolveRefs(ctx.refs).map((r) => r.table)).toEqual(['a.b.returns', 'a.b.order_items', null, 'a.b.z'])
  })
})

describe('quoteName', () => {
  it('backticks anything that is not a plain identifier', () => {
    expect(quoteName('order_id')).toBe('order_id')
    expect(quoteName('my-col')).toBe('`my-col`')
    expect(quoteName('a`b')).toBe('`a``b`')
  })
})
