// Summary numbers for the cells selected in the results grid. Pure functions: no DOM, no AG Grid.
// Values are the strings the warehouse returned (null for NULL). Numbers are read with Number, so very long
// decimals lose digits in the sum; they are shown with a sensible precision rather than as exact text.
import type { Cell } from './columns'

export interface NumericStats {
  /** How many of the cells were numbers. */
  n: number
  sum: number
  avg: number
  min: number
  max: number
}

export interface SelectionStats {
  /** All selected cells, NULLs included. */
  count: number
  /** Different non-NULL values. */
  distinct: number
  nulls: number
  /** Only when every selected cell is in a numeric column and at least one holds a number. */
  numeric: NumericStats | null
}

const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** A warehouse value as a number, or null when it is not a plain finite number (no hex, no blanks, no NaN). */
export function parseNumber(v: Cell | undefined): number | null {
  if (v === null || v === undefined) return null
  const t = v.trim()
  if (!PLAIN_NUMBER.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

/** Count, distinct and NULL counts, plus sum, average, min and max when `numeric` and some cell is a number. */
export function computeStats(values: Iterable<Cell | undefined>, numeric: boolean): SelectionStats {
  const seen = new Set<string>()
  let count = 0
  let nulls = 0
  let n = 0
  let sum = 0
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    count++
    if (v === null || v === undefined) {
      nulls++
      continue
    }
    seen.add(v)
    if (!numeric) continue
    const x = parseNumber(v)
    if (x === null) continue
    n++
    sum += x
    if (x < min) min = x
    if (x > max) max = x
  }
  return {
    count,
    distinct: seen.size,
    nulls,
    numeric: numeric && n > 0 ? { n, sum, avg: sum / n, min, max } : null,
  }
}

/** A number for the status bar: about 12 significant digits, thousands separators, no float noise (0.1 + 0.2 is 0.3). */
export function formatStat(x: number): string {
  if (!Number.isFinite(x)) return String(x)
  if (x === 0) return '0'
  if (Math.abs(x) >= 1e15 || Math.abs(x) < 1e-9) return x.toExponential(6).replace(/\.?0+e/, 'e')
  const rounded = Number(x.toPrecision(12))
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 10 })
}
