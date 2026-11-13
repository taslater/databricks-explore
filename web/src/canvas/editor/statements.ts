// Client-side SQL statement splitting for the query editor. No SQL parser: a small scanner that knows
// where strings, quoted identifiers and comments are, so a `;` inside them does not end a statement.

export interface Statement {
  /** Offset of the first character (leading comments count as part of the statement). */
  from: number
  /** Offset just past the last character, not counting the `;`. */
  to: number
  /** Offset just past the terminating `;`, or the end of the text when there is none. */
  end: number
  /** The text from `from` to `to`. */
  text: string
}

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v'
const isIdentChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c)

/**
 * Splits SQL on top-level semicolons. Respects `'...'` and `"..."` strings (backslash escapes, `r'...'` raw
 * strings), `` `quoted` `` identifiers, `-- line` comments and nested slash-star block comments.
 * Segments with nothing but whitespace and comments are dropped, since there is nothing to run.
 */
export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = []
  let segStart = 0
  let sawCode = false
  let i = 0

  const flush = (terminatorAt: number | null) => {
    const end = terminatorAt === null ? sql.length : terminatorAt + 1
    if (sawCode) {
      let from = segStart
      let to = terminatorAt === null ? sql.length : terminatorAt
      while (from < to && isSpace(sql[from])) from++
      while (to > from && isSpace(sql[to - 1])) to--
      out.push({ from, to, end, text: sql.slice(from, to) })
    }
    segStart = end
    sawCode = false
  }

  while (i < sql.length) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++
    } else if (c === '/' && next === '*') {
      let depth = 1
      i += 2
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else i++
      }
    } else if (c === "'" || c === '"' || c === '`') {
      sawCode = true
      const raw = (c === "'" || c === '"') && /[rR]/.test(sql[i - 1] ?? '') && !isIdentChar(sql[i - 2])
      i++
      while (i < sql.length && sql[i] !== c) {
        i += sql[i] === '\\' && c !== '`' && !raw ? 2 : 1
      }
      i++ // the closing quote (or past the end when unterminated)
    } else if (c === ';') {
      flush(i)
      i++
    } else {
      if (!isSpace(c)) sawCode = true
      i++
    }
  }
  flush(null)
  return out
}

/**
 * The statement a cursor at `pos` belongs to: the one that contains it, counting its `;`. In a gap between
 * statements it is the previous statement, or the first when the cursor is before everything.
 */
export function statementAt(statements: Statement[], pos: number): Statement | null {
  if (statements.length === 0) return null
  const inside = statements.find((s) => pos >= s.from && pos <= s.end)
  if (inside) return inside
  const before = statements.filter((s) => s.end <= pos)
  return before.length > 0 ? before[before.length - 1] : statements[0]
}

export type RunMode = 'current' | 'all'

export interface RunPlan {
  /** SQL to run, in order, without terminating semicolons. */
  sqls: string[]
  /** Editor ranges to highlight as having run. */
  ranges: Array<{ from: number; to: number }>
}

/**
 * What a run does. `current`: the selection if there is one, otherwise the statement under the cursor.
 * `all`: every statement in order. A selection that holds several statements runs as a script.
 */
export function planRun(doc: string, selFrom: number, selTo: number, mode: RunMode): RunPlan {
  const empty: RunPlan = { sqls: [], ranges: [] }
  if (mode === 'all') {
    const all = splitStatements(doc)
    return { sqls: all.map((s) => s.text), ranges: all.map((s) => ({ from: s.from, to: s.to })) }
  }
  if (selFrom !== selTo) {
    const parts = splitStatements(doc.slice(selFrom, selTo))
    return {
      sqls: parts.map((s) => s.text),
      ranges: parts.map((s) => ({ from: selFrom + s.from, to: selFrom + s.to })),
    }
  }
  const at = statementAt(splitStatements(doc), selFrom)
  return at ? { sqls: [at.text], ranges: [{ from: at.from, to: at.to }] } : empty
}
