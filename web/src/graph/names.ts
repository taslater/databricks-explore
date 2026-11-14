// The shortest name that still tells the tables of one list apart. Pure: no React, no fetch.

const lastParts = (full: string, count: number): string => full.split('.').slice(-count).join('.')

/**
 * A function giving each table the shortest unambiguous name among `tables`: `table` when no other table in the
 * list has that name, otherwise `schema.table`, otherwise `catalog.schema.table`. Names compare without regard to
 * case and a name listed twice counts once. A name that is not in the list is judged as if it were.
 */
export function shortestNames(tables: Iterable<string>): (full: string) => string {
  const known = new Set<string>()
  for (const t of tables) known.add(t.toLowerCase())
  const cache = new Map<string, string>()

  return (full) => {
    const cached = cache.get(full)
    if (cached !== undefined) return cached
    const all = known.has(full.toLowerCase()) ? known : new Set([...known, full.toLowerCase()])
    const depth = full.split('.').length
    let out = full
    for (let n = 1; n <= depth; n++) {
      const mine = lastParts(full, n).toLowerCase()
      let sharing = 0
      for (const other of all) if (lastParts(other, n) === mine) sharing++
      if (sharing === 1 || n === depth) {
        out = lastParts(full, n)
        break
      }
    }
    cache.set(full, out)
    return out
  }
}
