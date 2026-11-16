// Path typing for the picker's Drill-down filter: `dev.hr.emp` drills into catalog dev, schema hr, then filters. Pure: no React.

export interface SplitPath {
  /** Segments followed by a dot, backticks removed. */
  done: string[]
  /** The text after the last dot: the segment being typed. */
  last: string
  /** The raw text up to and including the last dot, kept so a completion can replace only `last`. */
  head: string
}

/** Splits on dots outside backticks: `` `my.cat`.sch.t `` gives done [my.cat, sch], last t. */
export function splitPath(text: string): SplitPath {
  const done: string[] = []
  let current = ''
  let quoted = false
  let head = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '`') quoted = !quoted
    else if (ch === '.' && !quoted) {
      done.push(current)
      current = ''
      head = i + 1
    } else current += ch
  }
  return { done, last: current, head: text.slice(0, head) }
}

/** A name as typed in a path: wrapped in backticks when it contains a dot. */
export const quoteSegment = (name: string) => (name.includes('.') ? `\`${name}\`` : name)

export interface DrillPos {
  catalog: string | null
  schema: string | null
}

/** The filter text that matches a drill position: `` (empty), `dev.` or `dev.hr.`. */
export function pathPrefix(pos: DrillPos): string {
  if (!pos.catalog) return ''
  return pos.schema ? `${quoteSegment(pos.catalog)}.${quoteSegment(pos.schema)}.` : `${quoteSegment(pos.catalog)}.`
}

/** `text` with its last segment replaced by `name`, and a dot after it when `name` is a catalog or schema. */
export function completeLast(text: string, name: string, container: boolean): string {
  return splitPath(text).head + quoteSegment(name) + (container ? '.' : '')
}

export interface Resolution {
  /** The catalog and schema the completed segments name (canonical spelling), or null. */
  catalog: string | null
  schema: string | null
  /** The text to filter the current level's list by. */
  filter: string
  /** Why a completed segment did not drill, e.g. "no catalog named foo". */
  problem: string | null
  /** True while the data needed to read the next segment is not loaded yet. */
  pending: boolean
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * Reads a filter as a path. A completed segment (one followed by a dot) must name a catalog, then a schema, exactly
 * and without regard to case; the segment after the last completed one filters that level's list. `schemasOf`
 * returns the schema names of a catalog, or null while they are not loaded. A segment that matches nothing does not
 * drill: it is returned as `filter` and described in `problem`.
 */
export function resolvePath(
  text: string,
  catalogs: string[] | null,
  schemasOf: (catalog: string) => string[] | null,
): Resolution {
  const { done, last } = splitPath(text)
  const segs = [...done, last]
  const res: Resolution = { catalog: null, schema: null, filter: segs[0], problem: null, pending: false }
  if (done.length === 0 || segs[0] === '') return res
  if (!catalogs) return { ...res, pending: true }
  const catalog = catalogs.find((c) => same(c, segs[0]))
  if (!catalog) return { ...res, problem: `no catalog named ${segs[0]}` }
  res.catalog = catalog
  res.filter = segs[1]
  if (done.length < 2 || segs[1] === '') return res
  const schemas = schemasOf(catalog)
  if (!schemas) return { ...res, pending: true }
  const schema = schemas.find((s) => same(s, segs[1]))
  if (!schema) return { ...res, problem: `no schema named ${segs[1]} in ${catalog}` }
  res.schema = schema
  res.filter = segs[2]
  return res
}
