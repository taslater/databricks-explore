import { describe, expect, it } from 'vitest'
import { expansionChange, starAtCursor, starRequest } from './expandStar'

describe('starAtCursor', () => {
  const doc = 'SELECT o.*, count(*) FROM t o'
  it('is true before and after a star, and on its alias', () => {
    const star = doc.indexOf('*')
    expect(starAtCursor(doc, star)).toBe(true)
    expect(starAtCursor(doc, star + 1)).toBe(true)
    expect(starAtCursor(doc, doc.indexOf('o.*'))).toBe(true)
  })
  it('is false away from a star', () => {
    expect(starAtCursor(doc, 2)).toBe(false)
    expect(starAtCursor(doc, doc.indexOf('FROM'))).toBe(false)
    expect(starAtCursor('SELECT a, b FROM t', 8)).toBe(false)
  })
  it('is false on a word that only happens to be followed by a star without a dot', () => {
    expect(starAtCursor('SELECT a*b FROM t', 7)).toBe(false)
  })
})

describe('starRequest and expansionChange', () => {
  it('asks about the statement under the cursor, with offsets inside it', () => {
    const doc = 'SELECT 1;\n-- next\nSELECT * FROM t'
    const pos = doc.indexOf('*')
    const req = starRequest(doc, pos)!
    expect(req.sql).toBe('-- next\nSELECT * FROM t')
    expect(req.sql[req.offset]).toBe('*')
    const change = expansionChange(req, { text: 'a, b', start: req.offset, end: req.offset + 1, count: 2 })
    expect(doc.slice(0, change.from) + change.insert + doc.slice(change.to)).toBe('SELECT 1;\n-- next\nSELECT a, b FROM t')
  })
  it('has no request for an empty editor', () => {
    expect(starRequest('', 0)).toBeNull()
  })
})
