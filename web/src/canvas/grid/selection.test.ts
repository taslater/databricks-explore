import { describe, expect, it } from 'vitest'
import {
  EMPTY_SELECTION,
  beginSelection,
  cellCount,
  cellEdges,
  copyPlan,
  describePlan,
  dragSelection,
  forEachCell,
  isSelected,
  makeRange,
  moveSelection,
  normalizeRanges,
  rowTouched,
  selectAll,
  touchedColumns,
  type Dims,
  type Range,
} from './selection'

const dims: Dims = { rows: 10, cols: 5 }
const r = (rowStart: number, rowEnd: number, colStart: number, colEnd: number): Range => ({ rowStart, rowEnd, colStart, colEnd })

describe('makeRange', () => {
  it('normalizes corners given in any order', () => {
    expect(makeRange('cell', { row: 4, col: 3 }, { row: 1, col: 0 }, dims)).toEqual(r(1, 4, 0, 3))
  })
  it('widens to whole rows or columns', () => {
    expect(makeRange('row', { row: 2, col: 3 }, { row: 5, col: 1 }, dims)).toEqual(r(2, 5, 0, 4))
    expect(makeRange('col', { row: 2, col: 3 }, { row: 5, col: 1 }, dims)).toEqual(r(0, 9, 1, 3))
  })
  it('clamps to the grid', () => {
    expect(makeRange('cell', { row: -3, col: 2 }, { row: 99, col: 99 }, dims)).toEqual(r(0, 9, 2, 4))
  })
})

describe('beginSelection and dragSelection', () => {
  it('a click selects one cell and makes it active', () => {
    const s = beginSelection(EMPTY_SELECTION, 'cell', { row: 2, col: 1 }, dims, 'replace')
    expect(s.ranges).toEqual([r(2, 2, 1, 1)])
    expect(s.active).toEqual({ row: 2, col: 1 })
  })
  it('a drag grows a rectangle from the active cell', () => {
    let s = beginSelection(EMPTY_SELECTION, 'cell', { row: 2, col: 1 }, dims, 'replace')
    s = dragSelection(s, 'cell', { row: 4, col: 3 }, dims)
    s = dragSelection(s, 'cell', { row: 0, col: 0 }, dims)
    expect(s.ranges).toEqual([r(0, 2, 0, 1)])
    expect(s.active).toEqual({ row: 2, col: 1 })
  })
  it('shift extends from the active cell and replaces the last range', () => {
    let s = beginSelection(EMPTY_SELECTION, 'cell', { row: 2, col: 1 }, dims, 'replace')
    s = beginSelection(s, 'cell', { row: 5, col: 3 }, dims, 'extend')
    expect(s.ranges).toEqual([r(2, 5, 1, 3)])
    s = beginSelection(s, 'cell', { row: 3, col: 1 }, dims, 'extend')
    expect(s.ranges).toEqual([r(2, 3, 1, 1)])
  })
  it('shift with no active cell behaves like a click', () => {
    const s = beginSelection(EMPTY_SELECTION, 'cell', { row: 2, col: 1 }, dims, 'extend')
    expect(s.ranges).toEqual([r(2, 2, 1, 1)])
  })
  it('cmd adds another range and drags only reshape the new one', () => {
    let s = beginSelection(EMPTY_SELECTION, 'cell', { row: 0, col: 0 }, dims, 'replace')
    s = beginSelection(s, 'cell', { row: 5, col: 2 }, dims, 'add')
    s = dragSelection(s, 'cell', { row: 6, col: 3 }, dims)
    expect(s.ranges).toEqual([r(0, 0, 0, 0), r(5, 6, 2, 3)])
  })
  it('row and column gestures select whole lines', () => {
    let s = beginSelection(EMPTY_SELECTION, 'row', { row: 3, col: 0 }, dims, 'replace')
    s = dragSelection(s, 'row', { row: 5, col: 4 }, dims)
    expect(s.ranges).toEqual([r(3, 5, 0, 4)])
    s = beginSelection(EMPTY_SELECTION, 'col', { row: 0, col: 2 }, dims, 'replace')
    s = beginSelection(s, 'col', { row: 0, col: 4 }, dims, 'extend')
    expect(s.ranges).toEqual([r(0, 9, 2, 4)])
  })
  it('an empty grid selects nothing', () => {
    expect(beginSelection(EMPTY_SELECTION, 'cell', { row: 0, col: 0 }, { rows: 0, cols: 3 }, 'replace')).toEqual(EMPTY_SELECTION)
    expect(selectAll({ rows: 0, cols: 0 })).toEqual(EMPTY_SELECTION)
  })
})

describe('selectAll and moveSelection', () => {
  it('select all covers the grid', () => {
    expect(selectAll(dims).ranges).toEqual([r(0, 9, 0, 4)])
  })
  it('the first arrow key selects the top left cell', () => {
    expect(moveSelection(EMPTY_SELECTION, 'down', dims, { extend: false, edge: false }).ranges).toEqual([r(0, 0, 0, 0)])
  })
  it('arrows move the active cell and collapse the selection, stopping at the edges', () => {
    let s = beginSelection(EMPTY_SELECTION, 'cell', { row: 0, col: 0 }, dims, 'replace')
    s = dragSelection(s, 'cell', { row: 3, col: 3 }, dims)
    s = moveSelection(s, 'down', dims, { extend: false, edge: false })
    expect(s.ranges).toEqual([r(1, 1, 0, 0)])
    s = moveSelection(s, 'left', dims, { extend: false, edge: false })
    expect(s.active).toEqual({ row: 1, col: 0 })
    s = moveSelection(s, 'down', dims, { extend: false, edge: true })
    expect(s.active).toEqual({ row: 9, col: 0 })
    s = moveSelection(s, 'down', dims, { extend: false, edge: false })
    expect(s.active).toEqual({ row: 9, col: 0 })
  })
  it('shift+arrows move the far end and keep the anchor', () => {
    let s = beginSelection(EMPTY_SELECTION, 'cell', { row: 2, col: 2 }, dims, 'replace')
    s = moveSelection(s, 'down', dims, { extend: true, edge: false })
    s = moveSelection(s, 'right', dims, { extend: true, edge: false })
    expect(s.ranges).toEqual([r(2, 3, 2, 3)])
    s = moveSelection(s, 'up', dims, { extend: true, edge: false })
    s = moveSelection(s, 'up', dims, { extend: true, edge: false })
    expect(s.ranges).toEqual([r(1, 2, 2, 3)])
    expect(s.active).toEqual({ row: 2, col: 2 })
  })
  it('shift+edge extends to the edge of the grid', () => {
    let s = beginSelection(EMPTY_SELECTION, 'cell', { row: 2, col: 2 }, dims, 'replace')
    s = moveSelection(s, 'down', dims, { extend: true, edge: true })
    s = moveSelection(s, 'left', dims, { extend: true, edge: true })
    expect(s.ranges).toEqual([r(2, 9, 0, 2)])
  })
})

describe('queries', () => {
  const ranges = [r(1, 2, 1, 2)]
  it('isSelected, rowTouched and touchedColumns', () => {
    expect(isSelected(ranges, 1, 1)).toBe(true)
    expect(isSelected(ranges, 3, 1)).toBe(false)
    expect(rowTouched(ranges, 2)).toBe(true)
    expect(rowTouched(ranges, 0)).toBe(false)
    expect([...touchedColumns([r(0, 0, 1, 2), r(0, 0, 4, 4)])]).toEqual([1, 2, 4])
  })
  it('edges follow the outline of one range', () => {
    expect(cellEdges(ranges, 1, 1)).toEqual({ top: true, left: true, bottom: false, right: false })
    expect(cellEdges(ranges, 2, 2)).toEqual({ top: false, left: false, bottom: true, right: true })
    expect(cellEdges(ranges, 0, 0)).toBeNull()
  })
  it('edges follow the outline of a union, with no line where ranges meet', () => {
    const two = [r(0, 0, 0, 1), r(1, 1, 0, 1)]
    expect(cellEdges(two, 0, 0)).toEqual({ top: true, left: true, bottom: false, right: false })
    expect(cellEdges(two, 1, 1)).toEqual({ top: false, left: false, bottom: true, right: true })
  })
  it('normalizeRanges drops duplicates and contained ranges, keeping order', () => {
    expect(normalizeRanges([r(0, 5, 0, 3), r(1, 2, 1, 1), r(0, 5, 0, 3), r(8, 8, 0, 0)])).toEqual([r(0, 5, 0, 3), r(8, 8, 0, 0)])
  })
  it('counts overlapping cells once', () => {
    expect(cellCount([r(0, 1, 0, 1)])).toBe(4)
    expect(cellCount([r(0, 1, 0, 1), r(1, 2, 1, 2)])).toBe(7)
    const seen: string[] = []
    forEachCell([r(0, 1, 0, 1), r(1, 2, 1, 2)], (row, col) => seen.push(`${row},${col}`))
    expect(seen).toHaveLength(7)
    expect(new Set(seen).size).toBe(7)
  })
})

describe('copyPlan', () => {
  it('is null for nothing', () => {
    expect(copyPlan([], dims)).toBeNull()
  })
  it('one rectangle is itself', () => {
    const p = copyPlan([r(2, 3, 1, 2)], dims)
    expect(p).toEqual({ rows: [2, 3], cols: [1, 2], ranges: 1, dropped: false })
  })
  it('several whole rows give those rows with every column', () => {
    const p = copyPlan([r(1, 1, 0, 4), r(5, 6, 0, 4)], dims)
    expect(p?.rows).toEqual([1, 5, 6])
    expect(p?.cols).toEqual([0, 1, 2, 3, 4])
    expect(p?.dropped).toBe(false)
  })
  it('several whole columns give those columns with every row', () => {
    const p = copyPlan([r(0, 9, 1, 1), r(0, 9, 3, 3)], dims)
    expect(p?.rows).toHaveLength(10)
    expect(p?.cols).toEqual([1, 3])
  })
  it('rows and columns compose into rows x columns', () => {
    const p = copyPlan([r(2, 2, 0, 4), r(4, 4, 0, 4), r(0, 9, 1, 1), r(0, 9, 3, 3)], dims)
    expect(p?.rows).toEqual([2, 4])
    expect(p?.cols).toEqual([1, 3])
    expect(p?.dropped).toBe(false)
  })
  it('unrelated rectangles copy the last one and say so', () => {
    const p = copyPlan([r(0, 1, 0, 1), r(5, 6, 2, 3)], dims)
    expect(p).toEqual({ rows: [5, 6], cols: [2, 3], ranges: 2, dropped: true })
  })
  it('a rectangle mixed with a whole row is unrelated too', () => {
    const p = copyPlan([r(0, 0, 0, 4), r(5, 6, 2, 3)], dims)
    expect(p?.dropped).toBe(true)
    expect(p?.rows).toEqual([5, 6])
  })
  it('describes a plan', () => {
    expect(describePlan(copyPlan([r(2, 2, 1, 1)], dims)!, dims)).toBe('1 cell')
    expect(describePlan(copyPlan([r(2, 4, 0, 4)], dims)!, dims)).toBe('3 rows')
    expect(describePlan(copyPlan([r(0, 9, 2, 2)], dims)!, dims)).toBe('1 column')
    expect(describePlan(copyPlan([r(1, 2, 1, 3)], dims)!, dims)).toBe('2 rows × 3 columns')
  })
})
