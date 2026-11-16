// Spreadsheet-style selection for the results grid. Pure functions: no DOM, no AG Grid.
// Rows and columns are positions in what the grid shows right now (after sort, filter, hide and pin), not
// indexes into the result, so the caller maps them. Ranges are inclusive and always normalized (start <= end).

export interface Pos {
  row: number
  col: number
}

export interface Range {
  rowStart: number
  rowEnd: number
  colStart: number
  colEnd: number
}

/** How many rows and data columns the grid shows. */
export interface Dims {
  rows: number
  cols: number
}

/** What a mouse gesture selects: a cell rectangle, whole rows (gutter), or whole columns (header). */
export type Kind = 'cell' | 'row' | 'col'

/** How a click combines with what is selected: Shift extends, Cmd/Ctrl adds another range. */
export type Mode = 'replace' | 'extend' | 'add'

export interface Selection {
  /** In the order made. The last one is the one a drag or Shift+arrow reshapes. */
  ranges: Range[]
  /** The cell the current range grows from (Excel's active cell). */
  active: Pos | null
  /** The moving end of the current range, for Shift+arrow. */
  focus: Pos | null
}

export const EMPTY_SELECTION: Selection = { ranges: [], active: null, focus: null }

export type Direction = 'up' | 'down' | 'left' | 'right'

const clamp = (n: number, max: number) => Math.max(0, Math.min(n, Math.max(0, max)))

/** The rectangle between two cells, widened to whole rows or whole columns for those kinds. */
export function makeRange(kind: Kind, a: Pos, b: Pos, dims: Dims): Range {
  const rows = [clamp(a.row, dims.rows - 1), clamp(b.row, dims.rows - 1)]
  const cols = [clamp(a.col, dims.cols - 1), clamp(b.col, dims.cols - 1)]
  return {
    rowStart: kind === 'col' ? 0 : Math.min(...rows),
    rowEnd: kind === 'col' ? dims.rows - 1 : Math.max(...rows),
    colStart: kind === 'row' ? 0 : Math.min(...cols),
    colEnd: kind === 'row' ? dims.cols - 1 : Math.max(...cols),
  }
}

/** A click: replaces the selection, extends the last range from the active cell, or adds a range. */
export function beginSelection(sel: Selection, kind: Kind, pos: Pos, dims: Dims, mode: Mode): Selection {
  if (dims.rows === 0 || dims.cols === 0) return EMPTY_SELECTION
  if (mode === 'extend' && sel.active) {
    const range = makeRange(kind, sel.active, pos, dims)
    return { ranges: [...sel.ranges.slice(0, -1), range], active: sel.active, focus: pos }
  }
  const range = makeRange(kind, pos, pos, dims)
  const ranges = mode === 'add' ? [...sel.ranges, range] : [range]
  return { ranges, active: pos, focus: pos }
}

/** Mouse moved to another cell, row or column during a drag: the last range now runs from the active cell to it. */
export function dragSelection(sel: Selection, kind: Kind, pos: Pos, dims: Dims): Selection {
  if (!sel.active || sel.ranges.length === 0) return sel
  const range = makeRange(kind, sel.active, pos, dims)
  return { ranges: [...sel.ranges.slice(0, -1), range], active: sel.active, focus: pos }
}

/** Everything. The active cell is the top left one. */
export function selectAll(dims: Dims): Selection {
  if (dims.rows === 0 || dims.cols === 0) return EMPTY_SELECTION
  const range = { rowStart: 0, rowEnd: dims.rows - 1, colStart: 0, colEnd: dims.cols - 1 }
  return { ranges: [range], active: { row: 0, col: 0 }, focus: { row: dims.rows - 1, col: dims.cols - 1 } }
}

/**
 * An arrow key. Plain: the active cell moves and becomes the only selection. `extend` (Shift) moves the far
 * end of the last range instead. `edge` (Cmd/Ctrl) goes all the way to the edge of the grid.
 */
export function moveSelection(sel: Selection, dir: Direction, dims: Dims, opts: { extend: boolean; edge: boolean }): Selection {
  if (dims.rows === 0 || dims.cols === 0) return EMPTY_SELECTION
  if (!sel.active) {
    const first = { row: 0, col: 0 }
    return { ranges: [makeRange('cell', first, first, dims)], active: first, focus: first }
  }
  const from = opts.extend ? (sel.focus ?? sel.active) : sel.active
  const to = { ...from }
  if (dir === 'up') to.row = opts.edge ? 0 : from.row - 1
  if (dir === 'down') to.row = opts.edge ? dims.rows - 1 : from.row + 1
  if (dir === 'left') to.col = opts.edge ? 0 : from.col - 1
  if (dir === 'right') to.col = opts.edge ? dims.cols - 1 : from.col + 1
  to.row = clamp(to.row, dims.rows - 1)
  to.col = clamp(to.col, dims.cols - 1)
  if (opts.extend) {
    const range = makeRange('cell', sel.active, to, dims)
    return { ranges: [...sel.ranges.slice(0, -1), range], active: sel.active, focus: to }
  }
  return { ranges: [makeRange('cell', to, to, dims)], active: to, focus: to }
}

const covers = (outer: Range, inner: Range) =>
  outer.rowStart <= inner.rowStart && outer.rowEnd >= inner.rowEnd && outer.colStart <= inner.colStart && outer.colEnd >= inner.colEnd

/** The ranges without duplicates and without ranges lying wholly inside another one. Order is kept. */
export function normalizeRanges(ranges: Range[]): Range[] {
  return ranges.filter((r, i) => !ranges.some((o, j) => j !== i && covers(o, r) && (!covers(r, o) || j < i)))
}

/** True when the cell is in any range. */
export function isSelected(ranges: Range[], row: number, col: number): boolean {
  return ranges.some((r) => row >= r.rowStart && row <= r.rowEnd && col >= r.colStart && col <= r.colEnd)
}

export interface Edges {
  top: boolean
  bottom: boolean
  left: boolean
  right: boolean
}

/** Which sides of a selected cell face an unselected neighbor, so the outline follows the shape of the union. Null if not selected. */
export function cellEdges(ranges: Range[], row: number, col: number): Edges | null {
  if (!isSelected(ranges, row, col)) return null
  return {
    top: !isSelected(ranges, row - 1, col),
    bottom: !isSelected(ranges, row + 1, col),
    left: !isSelected(ranges, row, col - 1),
    right: !isSelected(ranges, row, col + 1),
  }
}

/** True when any cell of the row is selected (the row number is tinted). */
export function rowTouched(ranges: Range[], row: number): boolean {
  return ranges.some((r) => row >= r.rowStart && row <= r.rowEnd)
}

/** Positions of the columns with at least one selected cell. */
export function touchedColumns(ranges: Range[]): Set<number> {
  const out = new Set<number>()
  for (const r of ranges) for (let c = r.colStart; c <= r.colEnd; c++) out.add(c)
  return out
}

/** Visits every selected cell once, even where ranges overlap. */
export function forEachCell(ranges: Range[], visit: (row: number, col: number) => void): void {
  const rs = normalizeRanges(ranges)
  if (rs.length <= 1) {
    for (const r of rs) for (let i = r.rowStart; i <= r.rowEnd; i++) for (let c = r.colStart; c <= r.colEnd; c++) visit(i, c)
    return
  }
  const seen = new Set<number>()
  for (const r of rs) {
    for (let i = r.rowStart; i <= r.rowEnd; i++) {
      for (let c = r.colStart; c <= r.colEnd; c++) {
        const key = i * 65536 + c
        if (seen.has(key)) continue
        seen.add(key)
        visit(i, c)
      }
    }
  }
}

/** How many cells are selected. */
export function cellCount(ranges: Range[]): number {
  const rs = normalizeRanges(ranges)
  if (rs.length <= 1) return rs.reduce((n, r) => n + (r.rowEnd - r.rowStart + 1) * (r.colEnd - r.colStart + 1), 0)
  let n = 0
  forEachCell(rs, () => n++)
  return n
}

/** What a copy takes: the rows and columns to read (by position, ascending), and whether other ranges were left out. */
export interface CopyPlan {
  rows: number[]
  cols: number[]
  /** How many ranges the selection has. */
  ranges: number
  /** True when several unrelated rectangles were selected and only the last one is copied. */
  dropped: boolean
}

const span = (start: number, end: number) => Array.from({ length: end - start + 1 }, (_, i) => start + i)

function union(rs: Range[], axis: 'row' | 'col'): number[] {
  const set = new Set<number>()
  for (const r of rs) for (const i of axis === 'row' ? span(r.rowStart, r.rowEnd) : span(r.colStart, r.colEnd)) set.add(i)
  return [...set].sort((a, b) => a - b)
}

/**
 * The table a copy gives. One rectangle is itself. Whole rows and whole columns compose: rows alone give those
 * rows, columns alone those columns, both give rows x columns. Any other mix of ranges is several unrelated
 * rectangles, and the last one made is taken. Null when nothing is selected.
 */
export function copyPlan(ranges: Range[], dims: Dims): CopyPlan | null {
  const rs = normalizeRanges(ranges)
  if (rs.length === 0 || dims.rows === 0 || dims.cols === 0) return null
  const rect = (r: Range, dropped: boolean): CopyPlan => ({
    rows: span(r.rowStart, r.rowEnd),
    cols: span(r.colStart, r.colEnd),
    ranges: rs.length,
    dropped,
  })
  if (rs.length === 1) return rect(rs[0], false)
  const wholeRow = (r: Range) => r.colStart === 0 && r.colEnd === dims.cols - 1
  const wholeCol = (r: Range) => r.rowStart === 0 && r.rowEnd === dims.rows - 1
  const rowRs = rs.filter(wholeRow)
  const colRs = rs.filter((r) => !wholeRow(r) && wholeCol(r))
  if (rowRs.length + colRs.length === rs.length) {
    return {
      rows: rowRs.length ? union(rowRs, 'row') : span(0, dims.rows - 1),
      cols: colRs.length ? union(colRs, 'col') : span(0, dims.cols - 1),
      ranges: rs.length,
      dropped: false,
    }
  }
  return rect(rs[rs.length - 1], true)
}

/** "3 rows", "3 rows x 2 columns", "1 cell": what a plan covers, for messages and menu titles. */
export function describePlan(plan: CopyPlan, dims: Dims): string {
  const n = (k: number, one: string) => `${k} ${k === 1 ? one : `${one}s`}`
  if (plan.rows.length === 1 && plan.cols.length === 1) return '1 cell'
  if (plan.cols.length === dims.cols) return n(plan.rows.length, 'row')
  if (plan.rows.length === dims.rows) return n(plan.cols.length, 'column')
  return `${n(plan.rows.length, 'row')} × ${n(plan.cols.length, 'column')}`
}
