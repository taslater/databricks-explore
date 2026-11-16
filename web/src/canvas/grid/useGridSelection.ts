// The mouse and keyboard side of the results grid's selection. The model is in selection.ts; this file reads
// where the pointer is from the DOM AG Grid draws (Community has no cell ranges), keeps the selection in a ref
// so cell styles can read it, and asks the grid to repaint. Everything is attached to the grid's wrapper element.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { CellClassParams, CellClassRules, GridApi } from 'ag-grid-community'
import type { Row } from './columns'
import {
  EMPTY_SELECTION,
  beginSelection,
  cellEdges,
  dragSelection,
  isSelected,
  moveSelection,
  rowTouched,
  selectAll,
  touchedColumns,
  type Dims,
  type Direction,
  type Kind,
  type Pos,
  type Selection,
} from './selection'

/** Column id of the row-number gutter. */
export const GUTTER_ID = 'qw-gutter'
const DATA_COLUMN = /^c\d+$/

type Hit =
  | { kind: 'cell'; row: number; col: number }
  | { kind: 'gutter'; row: number }
  | { kind: 'header'; col: number }
  | { kind: 'corner' }

/** What the pointer is over: a data cell, a row number, a column header or the gutter's corner. Null for anything else. */
function hitTest(target: EventTarget | null, colPos: Map<string, number>): Hit | null {
  const el = target instanceof Element ? target : null
  if (!el) return null
  const header = el.closest('.ag-header-cell')
  if (header) {
    // Buttons, the filter and menu icons and the resize handle keep their own behavior.
    if (el.closest('button, input, .ag-header-cell-resize, .ag-header-cell-filter-button, .ag-header-cell-menu-button')) return null
    const id = header.getAttribute('col-id') ?? ''
    if (id === GUTTER_ID) return { kind: 'corner' }
    const col = colPos.get(id)
    return col === undefined ? null : { kind: 'header', col }
  }
  const cell = el.closest('.ag-cell')
  const rowEl = cell?.closest('.ag-row')
  if (!cell || !rowEl) return null
  const row = Number(rowEl.getAttribute('row-index'))
  if (!Number.isInteger(row)) return null
  const id = cell.getAttribute('col-id') ?? ''
  if (id === GUTTER_ID) return { kind: 'gutter', row }
  const col = colPos.get(id)
  return col === undefined ? null : { kind: 'cell', row, col }
}

const ARROWS: Record<string, Direction> = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }

/** Rows to move per tick while a drag is held outside the grid body, and how often. */
const SCROLL_TICK_MS = 60

export interface GridSelectionOptions {
  apiRef: RefObject<GridApi<Row> | null>
  wrapRef: RefObject<HTMLDivElement | null>
  /** Cmd/Ctrl+C in the grid. */
  onCopy: () => void
  /** Right-click on a column header. */
  onHeaderMenu: (colId: string, x: number, y: number) => void
  /** True while a menu or popover is open, so Esc and the arrow keys are left to it. */
  isBlocked: () => boolean
}

/** Selection state for the results grid, plus the cell style rules and the event wiring that go with it. */
export function useGridSelection(opts: GridSelectionOptions) {
  const optsRef = useRef(opts)
  useEffect(() => {
    optsRef.current = opts
  })

  const selRef = useRef<Selection>(EMPTY_SELECTION)
  const [selection, setSelectionState] = useState<Selection>(EMPTY_SELECTION)
  // Data column ids in the order shown, and the position of each. Positions are what a selection holds.
  const colIdsRef = useRef<string[]>([])
  const colPosRef = useRef<Map<string, number>>(new Map())
  const frame = useRef<number | undefined>(undefined)

  const repaint = useCallback(() => {
    if (frame.current !== undefined) return
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined
      // force: cell classes are rules over the selection, which the grid does not know changed.
      optsRef.current.apiRef.current?.refreshCells({ force: true })
    })
  }, [])
  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current)
    },
    [],
  )

  const apply = useCallback(
    (next: Selection) => {
      selRef.current = next
      setSelectionState(next)
      repaint()
    },
    [repaint],
  )

  const dims = useCallback((): Dims => {
    const api = optsRef.current.apiRef.current
    return { rows: api?.getDisplayedRowCount() ?? 0, cols: colIdsRef.current.length }
  }, [])

  /** Re-reads which data columns are shown. Positions changed, so the selection is cleared. */
  const syncColumns = useCallback(() => {
    const api = optsRef.current.apiRef.current
    const ids = (api?.getAllDisplayedColumns() ?? []).map((c) => c.getColId()).filter((id) => DATA_COLUMN.test(id))
    colIdsRef.current = ids
    colPosRef.current = new Map(ids.map((id, i) => [id, i]))
    apply(EMPTY_SELECTION)
  }, [apply])

  const reset = useCallback(() => apply(EMPTY_SELECTION), [apply])

  /** Right-click: a cell outside the selection becomes the selection, as in a spreadsheet. */
  const ensureCellSelected = useCallback(
    (row: number, col: number) => {
      if (isSelected(selRef.current.ranges, row, col)) return
      apply(beginSelection(EMPTY_SELECTION, 'cell', { row, col }, dims(), 'replace'))
    },
    [apply, dims],
  )

  // Cell and gutter styles, read from the ref every time the grid repaints. The objects are created once.
  const cellClassRules = useMemo<CellClassRules<Row>>(() => {
    const at = (p: CellClassParams<Row>): Pos | null => {
      const row = p.node.rowIndex
      const col = colPosRef.current.get(p.column.getColId())
      return row === null || col === undefined ? null : { row, col }
    }
    const edge = (side: 'top' | 'bottom' | 'left' | 'right') => (p: CellClassParams<Row>) => {
      const pos = at(p)
      return pos !== null && (cellEdges(selRef.current.ranges, pos.row, pos.col)?.[side] ?? false)
    }
    return {
      'qw-sel': (p) => {
        const pos = at(p)
        return pos !== null && isSelected(selRef.current.ranges, pos.row, pos.col)
      },
      'qw-sel-t': edge('top'),
      'qw-sel-b': edge('bottom'),
      'qw-sel-l': edge('left'),
      'qw-sel-r': edge('right'),
      'qw-active': (p) => {
        const pos = at(p)
        const a = selRef.current.active
        return pos !== null && a !== null && a.row === pos.row && a.col === pos.col && selRef.current.ranges.length > 0
      },
    }
  }, [])
  const gutterClassRules = useMemo<CellClassRules<Row>>(
    () => ({
      'qw-gutter-sel': (p) => p.node.rowIndex !== null && rowTouched(selRef.current.ranges, p.node.rowIndex),
    }),
    [],
  )

  // Ids of the columns with selected cells, for the headers.
  const selectedCols = useMemo(
    () => new Set([...touchedColumns(selection.ranges)].map((i) => colIdsRef.current[i]).filter((id) => id !== undefined)),
    [selection],
  )
  const uiValue = useMemo(() => ({ selectedCols }), [selectedCols])

  useEffect(() => {
    const wrap = opts.wrapRef.current
    if (!wrap) return
    const root: HTMLDivElement = wrap
    const current = () => optsRef.current

    let drag: { kind: Kind; last: Pos } | null = null
    let pointer = { x: 0, y: 0 }
    let timer: number | undefined

    /** Brings the moving end of the selection into view. */
    function reveal() {
      const api = current().apiRef.current
      const end = selRef.current.focus ?? selRef.current.active
      if (!api || !end) return
      api.ensureIndexVisible(end.row)
      const id = colIdsRef.current[end.col]
      if (id) api.ensureColumnVisible(id)
    }

    function stopDrag() {
      drag = null
      window.clearInterval(timer)
      timer = undefined
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', stopDrag)
    }

    function dragTo(pos: Pos) {
      if (!drag || (pos.row === drag.last.row && pos.col === drag.last.col)) return
      drag.last = pos
      apply(dragSelection(selRef.current, drag.kind, pos, dims()))
    }

    function onMove(e: MouseEvent) {
      pointer = { x: e.clientX, y: e.clientY }
      if (!drag) return
      if (e.buttons === 0) return stopDrag()
      const hit = hitTest(e.target, colPosRef.current)
      if (!hit) return
      const { kind } = drag
      if (kind === 'cell' && hit.kind === 'cell') dragTo({ row: hit.row, col: hit.col })
      else if (kind === 'row' && (hit.kind === 'cell' || hit.kind === 'gutter')) dragTo({ row: hit.row, col: 0 })
      else if (kind === 'col' && (hit.kind === 'cell' || hit.kind === 'header')) dragTo({ row: 0, col: hit.col })
    }

    // While the pointer is held outside the body, keep extending one row or column per tick.
    function autoScroll() {
      if (!drag) return
      const d = dims()
      const body = root.querySelector('.ag-body-viewport')?.getBoundingClientRect()
      const center = root.querySelector('.ag-center-cols-viewport')?.getBoundingClientRect()
      let { row, col } = drag.last
      if (drag.kind !== 'col' && body) {
        if (pointer.y > body.bottom) row = Math.min(d.rows - 1, row + 1)
        else if (pointer.y < body.top) row = Math.max(0, row - 1)
      }
      if (drag.kind !== 'row' && center) {
        if (pointer.x > center.right) col = Math.min(d.cols - 1, col + 1)
        else if (pointer.x < center.left) col = Math.max(0, col - 1)
      }
      if (row === drag.last.row && col === drag.last.col) return
      dragTo({ row, col })
      const api = current().apiRef.current
      if (api && drag.kind !== 'col') api.ensureIndexVisible(row)
      const id = colIdsRef.current[col]
      if (api && id && drag.kind !== 'row') api.ensureColumnVisible(id)
    }

    function onDown(e: MouseEvent) {
      if (e.button !== 0) return
      const hit = hitTest(e.target, colPosRef.current)
      if (!hit) return
      // No native focus or text selection: the grid is not text, and the wrapper takes the keyboard.
      e.preventDefault()
      root.focus({ preventScroll: true })
      const d = dims()
      if (hit.kind === 'corner') return apply(selectAll(d))
      const kind: Kind = hit.kind === 'cell' ? 'cell' : hit.kind === 'gutter' ? 'row' : 'col'
      const pos: Pos =
        hit.kind === 'cell' ? { row: hit.row, col: hit.col } : hit.kind === 'gutter' ? { row: hit.row, col: 0 } : { row: 0, col: hit.col }
      const mode = e.shiftKey ? 'extend' : e.metaKey || e.ctrlKey ? 'add' : 'replace'
      apply(beginSelection(selRef.current, kind, pos, d, mode))
      stopDrag()
      drag = { kind, last: pos }
      pointer = { x: e.clientX, y: e.clientY }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', stopDrag)
      timer = window.setInterval(autoScroll, SCROLL_TICK_MS)
    }

    // A click on a header selects the column, so the grid's own click (which would sort) must not see it.
    // The sort button, the filter and menu icons and the resize handle are not header hits and pass through.
    function onClickCapture(e: MouseEvent) {
      if (hitTest(e.target, colPosRef.current)?.kind === 'header' || hitTest(e.target, colPosRef.current)?.kind === 'corner') {
        e.stopPropagation()
      }
    }

    function onContextMenu(e: MouseEvent) {
      const hit = hitTest(e.target, colPosRef.current)
      if (hit?.kind === 'header') {
        e.preventDefault()
        current().onHeaderMenu(colIdsRef.current[hit.col], e.clientX, e.clientY)
      } else if (hit?.kind === 'gutter' || hit?.kind === 'corner') {
        e.preventDefault()
      }
    }

    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement
      if (target.closest('input, textarea, select, [contenteditable="true"], .ag-popup')) return
      if (current().isBlocked()) return
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      const take = () => {
        e.preventDefault()
        e.stopPropagation()
      }
      if (mod && !e.altKey && key === 'a') {
        take()
        apply(selectAll(dims()))
      } else if (mod && !e.altKey && !e.shiftKey && key === 'c') {
        if (selRef.current.ranges.length === 0) return
        take()
        current().onCopy()
      } else if (e.key === 'Escape') {
        if (selRef.current.ranges.length === 0) return
        take()
        apply(EMPTY_SELECTION)
      } else if (ARROWS[e.key] && !e.altKey) {
        take()
        apply(moveSelection(selRef.current, ARROWS[e.key], dims(), { extend: e.shiftKey, edge: mod }))
        reveal()
      }
    }

    root.addEventListener('mousedown', onDown)
    root.addEventListener('click', onClickCapture, true)
    root.addEventListener('contextmenu', onContextMenu)
    root.addEventListener('keydown', onKeyDown, true)
    return () => {
      stopDrag()
      root.removeEventListener('mousedown', onDown)
      root.removeEventListener('click', onClickCapture, true)
      root.removeEventListener('contextmenu', onContextMenu)
      root.removeEventListener('keydown', onKeyDown, true)
    }
    // The handlers read everything else from refs, so they are attached once per wrapper.
  }, [apply, dims, opts.wrapRef])

  return { selection, selRef, colIdsRef, uiValue, cellClassRules, gutterClassRules, syncColumns, reset, apply, dims, ensureCellSelected }
}
