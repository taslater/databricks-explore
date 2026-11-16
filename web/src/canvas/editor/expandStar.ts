// Helpers for "Expand * into columns" in the query editor: is a star at the cursor, what to ask the server, and what to change.
import type { StarExpansion } from '../../api/types'
import { splitStatements, statementAt } from './statements'

/** The request for the statement the cursor is in: its text, the cursor's offset in it, and where it starts in the editor. */
export interface StarRequest {
  sql: string
  offset: number
  from: number
}

const WORD = /[A-Za-z0-9_.`]/

/**
 * True when `pos` is on a `*` (before it, after it, or on the `alias.` in front of it). It does not check that the star
 * is in a SELECT list: the server says so for a COUNT(*) or a multiplication.
 */
export function starAtCursor(doc: string, pos: number): boolean {
  if (doc[pos] === '*' || doc[pos - 1] === '*') return true
  let i = pos
  while (i < doc.length && WORD.test(doc[i])) i++
  return i > pos && doc[i] === '*' && doc[i - 1] === '.'
}

/** What to send for a star at `pos`, or null when there is no statement there. */
export function starRequest(doc: string, pos: number): StarRequest | null {
  const at = statementAt(splitStatements(doc), pos)
  if (!at) return null
  return { sql: at.text, offset: Math.min(Math.max(pos - at.from, 0), at.text.length), from: at.from }
}

/** The editor change that puts an expansion in place of the star, leaving everything else alone. */
export function expansionChange(request: StarRequest, result: StarExpansion): { from: number; to: number; insert: string } {
  return { from: request.from + result.start, to: request.from + result.end, insert: result.text }
}
