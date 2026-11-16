// Name matching for the object picker's filter: ranked text, globs, regular expressions, highlights. Pure: no React.

/** A matched stretch of a name, as [start, end) character offsets. */
export type Range = [start: number, end: number]

/** 1: the name starts with the text. 2: a `_`-separated part does. 3: the text is somewhere else in the name. */
export type Rank = 1 | 2 | 3

export interface Match {
  rank: Rank
  ranges: Range[]
}

/** A filter text turned into something that can test names. */
export type Compiled =
  | { kind: 'none' }
  | { kind: 'text'; needle: string }
  | { kind: 'glob'; re: RegExp; literal: boolean[] }
  | { kind: 'regex'; re: RegExp }
  | { kind: 'invalid'; message: string }

const escapeRegex = (s: string) => s.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&')

/** True when the text holds `*` (any run of characters) or `?` (one character). */
export const hasGlob = (text: string) => /[*?]/.test(text)

/** The error message when `text` is not a valid regular expression, else null. */
export function regexError(text: string): string | null {
  if (!text) return null
  try {
    new RegExp(text, 'i')
    return null
  } catch (e) {
    return e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : 'invalid regular expression'
  }
}

/** Anchored regex for a glob, one capture group per piece so the literal pieces can be highlighted. */
function compileGlob(text: string): Compiled {
  const pieces: { src: string; literal: boolean }[] = []
  for (const ch of text) {
    if (ch === '*') pieces.push({ src: '.*', literal: false })
    else if (ch === '?') pieces.push({ src: '.', literal: false })
    else {
      const last = pieces[pieces.length - 1]
      if (last?.literal) last.src += escapeRegex(ch)
      else pieces.push({ src: escapeRegex(ch), literal: true })
    }
  }
  const re = new RegExp(`^${pieces.map((p) => `(${p.src})`).join('')}$`, 'is')
  return { kind: 'glob', re, literal: pieces.map((p) => p.literal) }
}

/**
 * Turns the filter text into a matcher. Blank text matches everything. Without `regex`, a text holding `*` or `?` is
 * a glob that must match the whole name and anything else is a plain, ranked substring. With `regex` the text is a
 * case-insensitive, unanchored regular expression; an invalid one is returned as `invalid` and matches everything.
 */
export function compileFilter(text: string, regex = false): Compiled {
  const t = text.trim()
  if (!t) return { kind: 'none' }
  if (regex) {
    const message = regexError(t)
    return message === null ? { kind: 'regex', re: new RegExp(t, 'i') } : { kind: 'invalid', message }
  }
  return hasGlob(t) ? compileGlob(t) : { kind: 'text', needle: t.toLowerCase() }
}

/** Rank of a match that starts at `index` in `name`. */
function rankAt(name: string, index: number): Rank {
  if (index === 0) return 1
  return name[index - 1] === '_' ? 2 : 3
}

/** How `name` matches the filter, or null when it does not. A blank or invalid filter matches every name at rank 1. */
export function matchName(c: Compiled, name: string): Match | null {
  switch (c.kind) {
    case 'none':
    case 'invalid':
      return { rank: 1, ranges: [] }
    case 'text': {
      const lower = name.toLowerCase()
      if (lower.startsWith(c.needle)) return { rank: 1, ranges: [[0, c.needle.length]] }
      for (let i = lower.indexOf('_'); i >= 0; i = lower.indexOf('_', i + 1)) {
        if (lower.startsWith(c.needle, i + 1)) return { rank: 2, ranges: [[i + 1, i + 1 + c.needle.length]] }
      }
      const at = lower.indexOf(c.needle)
      return at < 0 ? null : { rank: 3, ranges: [[at, at + c.needle.length]] }
    }
    case 'glob': {
      const m = c.re.exec(name)
      if (!m) return null
      const ranges: Range[] = []
      let pos = 0
      c.literal.forEach((lit, i) => {
        const len = (m[i + 1] ?? '').length
        if (lit && len > 0) ranges.push([pos, pos + len])
        pos += len
      })
      return { rank: 1, ranges }
    }
    case 'regex': {
      const m = c.re.exec(name)
      if (!m) return null
      return { rank: rankAt(name, m.index), ranges: m[0].length > 0 ? [[m.index, m.index + m[0].length]] : [] }
    }
  }
}

export interface Ranked<T> {
  item: T
  match: Match
}

const byName = (a: string, b: string) => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * Filters and orders `items` by name. `primary` holds ranks 1 and 2 (rank 1 first, each alphabetical); `rest` holds
 * rank 3. With a blank or invalid filter every item is primary, in the order given.
 */
export function rankItems<T>(
  items: T[],
  c: Compiled,
  nameOf: (item: T) => string,
): { primary: Ranked<T>[]; rest: Ranked<T>[] } {
  const all: Ranked<T>[] = []
  for (const item of items) {
    const match = matchName(c, nameOf(item))
    if (match) all.push({ item, match })
  }
  if (c.kind === 'none' || c.kind === 'invalid') return { primary: all, rest: [] }
  all.sort((a, b) => a.match.rank - b.match.rank || byName(nameOf(a.item), nameOf(b.item)))
  return { primary: all.filter((r) => r.match.rank < 3), rest: all.filter((r) => r.match.rank === 3) }
}

/** Splits `name` into pieces, marking the matched ones. Ranges must be in order and not overlap. */
export function highlightParts(name: string, ranges: Range[]): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = []
  let pos = 0
  for (const [s, e] of ranges) {
    if (s > pos) parts.push({ text: name.slice(pos, s), hit: false })
    if (e > s) parts.push({ text: name.slice(s, e), hit: true })
    pos = Math.max(pos, e)
  }
  if (pos < name.length) parts.push({ text: name.slice(pos), hit: false })
  return parts.length ? parts : [{ text: name, hit: false }]
}
