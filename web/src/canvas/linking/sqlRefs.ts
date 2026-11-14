// A light reader for the SQL before the cursor: which tables the statement names in FROM and JOIN (with the
// aliases the user wrote), and whether the cursor sits where a join condition, a USING list or a joined table goes.
// Not a parser. It knows strings, comments, backticked names, parentheses and the join keywords, and it gives up
// quietly (a null context) on anything else. No React, no fetch.
import { splitStatements } from '../editor/statements'

export interface Token {
  type: 'word' | 'quoted' | 'punct' | 'string'
  /** A word as typed, a quoted name without its backticks, or one punctuation character. */
  text: string
  start: number
  end: number
}

/**
 * Splits SQL into words, backticked names, punctuation and strings. Comments are dropped.
 * `open` says the text ends inside a string, a comment or a backticked name, where nothing should be suggested.
 */
export function tokenize(sql: string): { tokens: Token[]; open: boolean } {
  const tokens: Token[] = []
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    if (/\s/.test(c)) {
      i++
    } else if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++
    } else if (c === '/' && sql[i + 1] === '*') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--
          i += 2
        } else i++
      }
      if (depth > 0) return { tokens, open: true }
    } else if (c === "'" || c === '"') {
      const start = i
      i++
      while (i < n && sql[i] !== c) i += sql[i] === '\\' ? 2 : 1
      if (i >= n) return { tokens, open: true }
      i++
      tokens.push({ type: 'string', text: sql.slice(start, i), start, end: i })
    } else if (c === '`') {
      const start = i
      let name = ''
      i++
      for (;;) {
        if (i >= n) return { tokens, open: true }
        if (sql[i] === '`') {
          if (sql[i + 1] === '`') {
            name += '`'
            i += 2
            continue
          }
          break
        }
        name += sql[i++]
      }
      i++
      tokens.push({ type: 'quoted', text: name, start, end: i })
    } else if (/[A-Za-z0-9_$]/.test(c)) {
      const start = i
      while (i < n && /[A-Za-z0-9_$]/.test(sql[i])) i++
      tokens.push({ type: 'word', text: sql.slice(start, i), start, end: i })
    } else {
      tokens.push({ type: 'punct', text: c, start: i, end: i + 1 })
      i++
    }
  }
  return { tokens, open: false }
}

/** One table (or derived table) in a FROM or JOIN list. */
export interface TableRef {
  /** The name's parts as written, unquoted: `['a','b','returns']`. Null for a derived table, `(SELECT ...) x`. */
  parts: string[] | null
  /** The name the statement uses for it: the alias if there is one, otherwise the table's last part. */
  alias: string
  hasAlias: boolean
}

export type JoinSpot = 'on' | 'using' | 'join'

export interface JoinContext {
  spot: JoinSpot
  /** The tables of the current SELECT before the cursor. For `on` and `using`, the last one is the table just joined. */
  refs: TableRef[]
  /** Where the text the user is typing starts, so a completion can replace it. */
  from: number
  /** In a `USING (` list, the cursor follows a comma rather than the opening bracket. */
  afterComma: boolean
  /** What the user has typed so far in the word (or dotted name) at the cursor. */
  typed: string
}

/** Words that can follow a table name without being its alias. */
const NOT_ALIAS = new Set([
  'ON', 'USING', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'OUTER', 'SEMI', 'ANTI', 'LATERAL',
  'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'QUALIFY', 'WINDOW', 'UNION', 'EXCEPT', 'INTERSECT', 'MINUS',
  'TABLESAMPLE', 'PIVOT', 'UNPIVOT', 'VERSION', 'TIMESTAMP', 'AS', 'SELECT', 'SET', 'WHEN', 'THEN', 'DISTRIBUTE',
  'SORT', 'CLUSTER', 'OFFSET', 'FETCH', 'WITH', 'FROM', 'INSERT', 'VALUES',
])
const CLAUSE = new Set([
  'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'QUALIFY', 'WINDOW', 'SELECT', 'SET', 'VALUES', 'DISTRIBUTE',
  'SORT', 'CLUSTER', 'OFFSET', 'FETCH',
])
const SET_OP = new Set(['UNION', 'EXCEPT', 'INTERSECT', 'MINUS'])

interface Level {
  refs: TableRef[]
  /** In a FROM list, where a comma starts another table. */
  inFrom: boolean
  expectRef: boolean
  mode: 'none' | 'on' | 'using'
  opener: 'root' | 'using' | 'derived' | 'other'
  /** After a derived table's `)`: the next word may be its alias. */
  aliasNext: boolean
}

const newLevel = (opener: Level['opener']): Level => ({
  refs: [],
  inFrom: false,
  expectRef: false,
  mode: 'none',
  opener,
  aliasNext: false,
})

const upper = (t: Token | undefined): string => (t && t.type === 'word' ? t.text.toUpperCase() : '')
const isName = (t: Token | undefined): t is Token => !!t && (t.type === 'word' || t.type === 'quoted')
const isAliasWord = (t: Token | undefined): t is Token =>
  isName(t) && (t.type === 'quoted' || !NOT_ALIAS.has(t.text.toUpperCase()))

/** The state of the SELECT being written, read from the tokens before the cursor. */
function walk(tokens: Token[]): Level[] {
  const levels: Level[] = [newLevel('root')]
  let usingNext = false
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    const level = levels[levels.length - 1]
    if (level.aliasNext) {
      level.aliasNext = false
      let alias = t
      if (upper(t) === 'AS') alias = tokens[++i]
      if (isAliasWord(alias)) level.refs.push({ parts: null, alias: alias.text, hasAlias: true })
      if (alias === t && !isAliasWord(t)) i-- // not an alias: read it again as itself
      continue
    }
    if (t.type === 'punct') {
      if (t.text === '(') {
        const opener = usingNext ? 'using' : level.expectRef ? 'derived' : 'other'
        if (level.expectRef) level.expectRef = false
        usingNext = false
        levels.push(newLevel(opener))
      } else if (t.text === ')') {
        if (levels.length > 1) {
          const done = levels.pop()!
          if (done.opener === 'derived') levels[levels.length - 1].aliasNext = true
          if (done.opener === 'using') levels[levels.length - 1].mode = 'none'
        }
      } else if (t.text === ',' && level.inFrom && level.mode === 'none' && !level.expectRef) {
        level.expectRef = true
      }
      continue
    }
    usingNext = false
    const kw = upper(t)
    if (kw === 'FROM') {
      level.inFrom = true
      level.expectRef = true
      level.mode = 'none'
    } else if (kw === 'JOIN') {
      level.inFrom = true
      level.expectRef = true
      level.mode = 'none'
    } else if (kw === 'ON') {
      level.mode = 'on'
      level.expectRef = false
      level.inFrom = false
    } else if (kw === 'USING') {
      level.mode = 'using'
      usingNext = true
    } else if (SET_OP.has(kw)) {
      level.refs = []
      level.inFrom = false
      level.expectRef = false
      level.mode = 'none'
    } else if (CLAUSE.has(kw)) {
      level.inFrom = false
      level.expectRef = false
      level.mode = 'none'
    } else if (level.expectRef && isName(t)) {
      if (kw === 'LATERAL' || kw === 'INNER' || kw === 'LEFT' || kw === 'RIGHT' || kw === 'FULL' || kw === 'CROSS') continue
      const parts = [t.text]
      while (tokens[i + 1]?.type === 'punct' && tokens[i + 1].text === '.' && isName(tokens[i + 2])) {
        parts.push(tokens[i + 2].text)
        i += 2
      }
      let hasAlias = false
      let alias = parts[parts.length - 1]
      const next = tokens[i + 1]
      if (upper(next) === 'AS' && isName(tokens[i + 2])) {
        alias = tokens[i + 2].text
        hasAlias = true
        i += 2
      } else if (isAliasWord(next)) {
        alias = next.text
        hasAlias = true
        i += 1
      }
      level.refs.push({ parts, alias, hasAlias })
      level.expectRef = false
    }
  }
  return levels
}

/**
 * Where the cursor is relative to a join, from the text of the statement up to the cursor. Returns null when it
 * is nowhere a join suggestion fits: not right after `ON`, not at the start of a `USING (` list, not where a
 * joined table goes, or with no table before it to join to.
 */
export function joinContext(statementBeforeCursor: string): JoinContext | null {
  const text = statementBeforeCursor
  const typed = /[\w.`$]*$/.exec(text)?.[0] ?? ''
  const from = text.length - typed.length
  const { tokens, open } = tokenize(text.slice(0, from))
  if (open || tokens.length === 0) return null
  const levels = walk(tokens)
  const level = levels[levels.length - 1]
  const last = tokens[tokens.length - 1]

  if (level.opener === 'using') {
    if (!(last.type === 'punct' && (last.text === '(' || last.text === ','))) return null
    const outer = levels[levels.length - 2]
    return outer.refs.length >= 2 ? { spot: 'using', refs: outer.refs, from, typed, afterComma: last.text === ',' } : null
  }
  if (level.mode === 'on' && upper(last) === 'ON') {
    return level.refs.length >= 2 ? { spot: 'on', refs: level.refs, from, typed, afterComma: false } : null
  }
  if (level.expectRef && level.refs.length >= 1 && !typed.includes('.')) {
    return { spot: 'join', refs: level.refs, from, typed, afterComma: false }
  }
  return null
}

/** The statement the cursor is in, up to the cursor: empty after a `;`. */
export function statementBeforeCursor(doc: string, pos: number): string {
  const before = doc.slice(0, pos)
  const all = splitStatements(before)
  const last = all[all.length - 1]
  if (!last) return ''
  return before.slice(last.to).includes(';') ? '' : before.slice(last.from)
}

/**
 * The full name for a table written in a statement. A three-part name is itself. A shorter one borrows the catalog
 * and schema of tables already written in full in the same statement, and is accepted when only one candidate exists
 * or when `known` (names already seen elsewhere, such as cached table lists) settles it. Case is taken from `known`.
 * Returns null when it cannot be told.
 */
export function resolveName(parts: string[], writtenInFull: readonly string[], known: readonly string[] = []): string | null {
  if (parts.length > 3 || parts.length === 0) return null
  const lowerKnown = new Map(known.map((k) => [k.toLowerCase(), k]))
  const canon = (name: string) => lowerKnown.get(name.toLowerCase()) ?? name
  if (parts.length === 3) return canon(parts.join('.'))
  const prefixes = new Set<string>()
  for (const full of writtenInFull) {
    const p = full.split('.')
    if (p.length !== 3) continue
    prefixes.add(parts.length === 2 ? p[0] : `${p[0]}.${p[1]}`)
  }
  const candidates = [...prefixes].map((p) => `${p}.${parts.join('.')}`)
  const seen = candidates.filter((c) => lowerKnown.has(c.toLowerCase()))
  if (seen.length >= 1) return lowerKnown.get(seen[0].toLowerCase())!
  return candidates.length === 1 ? candidates[0] : null
}

/** Quotes a name for SQL when it is not a plain identifier. Databricks uses backticks. */
export const quoteName = (name: string): string =>
  /^[A-Za-z_][A-Za-z_0-9]*$/.test(name) ? name : `\`${name.replace(/`/g, '``')}\``

export interface ResolvedRef extends TableRef {
  /** The full table name, or null for a derived table or a name that could not be resolved. */
  table: string | null
}

/** Resolves every table of a context to its full name. */
export function resolveRefs(refs: readonly TableRef[], known: readonly string[] = []): ResolvedRef[] {
  const full = refs.filter((r) => r.parts?.length === 3).map((r) => r.parts!.join('.'))
  return refs.map((r) => ({ ...r, table: r.parts ? resolveName(r.parts, full, known) : null }))
}
