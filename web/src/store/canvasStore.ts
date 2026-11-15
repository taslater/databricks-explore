// Canvas state. `viewport` and `windows` are the serialized part and match
// contracts/canvas.schema.json field for field (plain JSON, no React objects).
// Selection lives in the sketch store (src/sketch), which also owns sketch nodes and connectors.
import { create } from 'zustand'
import type { CanvasPoint, CanvasWindow } from '../api/types'
import type { Geometry } from '../sketch/types'
import { renameInWindows } from '../canvas/linking/refs'
import { placeNew, revealOnCanvas } from '../canvas/placement'
import { useRunStore } from '../canvas/runState'

export interface CanvasViewport {
  x: number
  y: number
  zoom: number
}

export interface CanvasSize {
  w: number
  h: number
}

export const DEFAULT_VIEWPORT: CanvasViewport = { x: 0, y: 0, zoom: 1 }
/** Percent of a query window's body that the SQL editor takes when the window has no saved split. */
export const DEFAULT_EDITOR_SPLIT = 40
/** The split a newly added query window starts with, so the results get most of the space. */
export const NEW_WINDOW_EDITOR_SPLIT = 30
export const DEFAULT_QUERY_SIZE: CanvasSize = { w: 760, h: 520 }
export const DEFAULT_NOTE_SIZE: CanvasSize = { w: 320, h: 220 }
export const DEFAULT_TABLE_SIZE: CanvasSize = { w: 320, h: 300 }

interface CanvasState {
  viewport: CanvasViewport
  windows: CanvasWindow[]
  /** UI only. Not saved. The window shown filling the canvas, or null. */
  maximizedId: string | null
  setMaximized: (id: string | null) => void
  /**
   * Adds a query window with a new id and a unique query_N title. Returns the id. `position` is where it is
   * wanted: it is kept when free, and otherwise moved to free space (see canvas/placement.ts). The same goes
   * for the note and table versions.
   */
  addQueryWindow: (position: CanvasPoint) => string
  /** Adds a query window whose SQL is `sql`. Returns the id. */
  addQueryWindowWithSql: (position: CanvasPoint, sql: string) => string
  /** Adds a note window (Markdown text, empty to start). Returns the id. */
  addNoteWindow: (position: CanvasPoint) => string
  /** Adds a table card for the full name catalog.schema.table. Returns the id. */
  addTableWindow: (position: CanvasPoint, fullName: string) => string
  /**
   * Adds a table card for each entry at exactly the position given (no free-space search: the caller laid the block
   * out), with unique titles, and pans so the block is in view. Returns the new card ids by table name.
   */
  addTableWindowsAt: (cards: Array<{ table: string; position: CanvasPoint }>) => Record<string, string>
  /** Sets the Markdown body of a note window. */
  setText: (id: string, text: string) => void
  /** Trims and validates the title. Returns an error message, or null when saved. */
  renameWindow: (id: string, title: string) => string | null
  setSql: (id: string, sql: string) => void
  /** Sets the window's chart to { vega_lite: spec }, or removes `chart` when spec is null. */
  setChartSpec: (id: string, spec: Record<string, unknown> | null) => void
  setCollapsed: (id: string, collapsed: boolean) => void
  /** Saves the editor's percent of a query window's body (the splitter between editor and results). */
  setEditorSplit: (id: string, percent: number) => void
  moveWindow: (id: string, position: CanvasPoint) => void
  resizeWindow: (id: string, position: CanvasPoint, size: CanvasSize) => void
  removeWindow: (id: string) => void
  /** Writes position, size, stacking order or lock to several windows at once. Unknown ids are ignored. */
  patchGeometry: (patches: Record<string, Partial<Geometry> & { locked?: boolean }>) => void
  removeWindows: (ids: string[]) => void
  setViewport: (viewport: CanvasViewport) => void
  /** Name of the saved canvas this state belongs to. Null for a new canvas, which does not autosave. */
  canvasName: string | null
  setCanvasName: (name: string | null) => void
  /** Replaces the whole canvas (used by Open). Clears the selection. */
  loadState: (next: { canvasName: string | null; viewport: CanvasViewport; windows: CanvasWindow[] }) => void
}

/** Next free id of the form w<n>, one above the largest n already used. */
export function nextWindowId(windows: CanvasWindow[]): string {
  let max = 0
  for (const w of windows) {
    const m = /^w(\d+)$/.exec(w.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `w${max + 1}`
}

/** Lowest query_N not used as a title on the canvas. */
export function nextQueryTitle(windows: CanvasWindow[]): string {
  const taken = new Set(windows.map((w) => w.title))
  let n = 1
  while (taken.has(`query_${n}`)) n++
  return `query_${n}`
}

/** `base` if no window uses it, otherwise the first free `base_2`, `base_3`, ... */
export function nextFreeTitle(windows: CanvasWindow[], base: string): string {
  const taken = new Set(windows.map((w) => w.title))
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}_${n}`)) n++
  return `${base}_${n}`
}

/** Title for a table card: the table name without its schema, braces removed (titles cannot contain them). */
export function tableTitleBase(fullName: string): string {
  const name = fullName.split('.').pop()?.replace(/[{}]/g, '').trim() ?? ''
  return name || 'table'
}

/**
 * Returns an error message for a title, or null when it is valid.
 * `selfId` is excluded from the uniqueness check so a window can keep its own title.
 */
export function titleError(title: string, windows: CanvasWindow[], selfId: string | null): string | null {
  if (title.length === 0) return 'Title cannot be empty.'
  if (/[{}]/.test(title)) return 'Titles cannot contain { or }.'
  if (windows.some((w) => w.id !== selfId && w.title === title)) {
    return `Another window is already named "${title}".`
  }
  return null
}

/** The `windows` map sent with each query run: title to SQL, for every query window. */
export function queryWindowMap(windows: CanvasWindow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const w of windows) {
    if (w.type === 'query') out[w.title] = w.sql ?? ''
  }
  return out
}

function patch(windows: CanvasWindow[], id: string, change: Partial<CanvasWindow>): CanvasWindow[] {
  return windows.map((w) => (w.id === id ? { ...w, ...change } : w))
}

/** The state change that adds a window and, when it landed outside the view, pans so the person sees it. */
function withWindowInView(
  windows: CanvasWindow[],
  win: CanvasWindow,
  viewport: CanvasViewport,
): { windows: CanvasWindow[]; viewport?: CanvasViewport } {
  const next = revealOnCanvas({ x: win.position.x, y: win.position.y, w: win.size.w, h: win.size.h }, viewport)
  return next ? { windows, viewport: next } : { windows }
}

export const useCanvasStore = create<CanvasState>()((set, get) => ({
  viewport: DEFAULT_VIEWPORT,
  windows: [],
  maximizedId: null,
  setMaximized: (maximizedId) => set({ maximizedId }),

  addQueryWindow: (position) => {
    const { windows } = get()
    const id = nextWindowId(windows)
    const win: CanvasWindow = {
      id,
      type: 'query',
      title: nextQueryTitle(windows),
      position: placeNew(position, DEFAULT_QUERY_SIZE, windows, get().viewport),
      size: { ...DEFAULT_QUERY_SIZE },
      sql: '',
      collapsed: false,
      editor_split: NEW_WINDOW_EDITOR_SPLIT,
    }
    set(withWindowInView([...windows, win], win, get().viewport))
    return id
  },

  addQueryWindowWithSql: (position, sql) => {
    const id = get().addQueryWindow(position)
    set({ windows: patch(get().windows, id, { sql }) })
    return id
  },

  addNoteWindow: (position) => {
    const { windows } = get()
    const id = nextWindowId(windows)
    const win: CanvasWindow = {
      id,
      type: 'note',
      title: nextFreeTitle(windows, 'note'),
      position: placeNew(position, DEFAULT_NOTE_SIZE, windows, get().viewport),
      size: { ...DEFAULT_NOTE_SIZE },
      text: '',
      collapsed: false,
    }
    set(withWindowInView([...windows, win], win, get().viewport))
    return id
  },

  addTableWindow: (position, fullName) => {
    const { windows } = get()
    const id = nextWindowId(windows)
    const win: CanvasWindow = {
      id,
      type: 'table',
      title: nextFreeTitle(windows, tableTitleBase(fullName)),
      position: placeNew(position, DEFAULT_TABLE_SIZE, windows, get().viewport),
      size: { ...DEFAULT_TABLE_SIZE },
      table: fullName,
      collapsed: false,
    }
    set(withWindowInView([...windows, win], win, get().viewport))
    return id
  },

  addTableWindowsAt: (cards) => {
    let windows = get().windows
    const ids: Record<string, string> = {}
    const added: CanvasWindow[] = []
    for (const c of cards) {
      const win: CanvasWindow = {
        id: nextWindowId(windows),
        type: 'table',
        title: nextFreeTitle(windows, tableTitleBase(c.table)),
        position: { x: c.position.x, y: c.position.y },
        size: { ...DEFAULT_TABLE_SIZE },
        table: c.table,
        collapsed: false,
      }
      windows = [...windows, win]
      added.push(win)
      ids[c.table] = win.id
    }
    if (added.length === 0) return ids
    const left = Math.min(...added.map((w) => w.position.x))
    const top = Math.min(...added.map((w) => w.position.y))
    const right = Math.max(...added.map((w) => w.position.x + w.size.w))
    const bottom = Math.max(...added.map((w) => w.position.y + w.size.h))
    const view = revealOnCanvas({ x: left, y: top, w: right - left, h: bottom - top }, get().viewport)
    set(view ? { windows, viewport: view } : { windows })
    return ids
  },

  setText: (id, text) => set({ windows: patch(get().windows, id, { text }) }),

  renameWindow: (id, title) => {
    const trimmed = title.trim()
    const { windows } = get()
    const err = titleError(trimmed, windows, id)
    if (err) return err
    // One set: the title and every {{old}} reference in other windows change together.
    set({ windows: renameInWindows(windows, id, trimmed) })
    return null
  },

  setSql: (id, sql) => set({ windows: patch(get().windows, id, { sql }) }),

  setChartSpec: (id, spec) =>
    set({
      windows: get().windows.map((w) => {
        if (w.id !== id) return w
        if (spec === null) {
          // Drop the key rather than leave chart: undefined, so the saved file matches the loaded one.
          const { chart: _chart, ...rest } = w
          return rest
        }
        return { ...w, chart: { vega_lite: spec } }
      }),
    }),

  setCollapsed: (id, collapsed) => set({ windows: patch(get().windows, id, { collapsed }) }),

  setEditorSplit: (id, percent) => set({ windows: patch(get().windows, id, { editor_split: percent }) }),

  moveWindow: (id, position) =>
    set({ windows: patch(get().windows, id, { position: { x: position.x, y: position.y } }) }),

  resizeWindow: (id, position, size) =>
    set({
      windows: patch(get().windows, id, {
        position: { x: position.x, y: position.y },
        size: { w: size.w, h: size.h },
      }),
    }),

  removeWindow: (id) => get().removeWindows([id]),

  removeWindows: (ids) => {
    const { windows, maximizedId } = get()
    const dead = new Set(ids)
    useRunStore.getState().clearWindows(ids)
    set({
      windows: windows.filter((w) => !dead.has(w.id)),
      maximizedId: maximizedId !== null && dead.has(maximizedId) ? null : maximizedId,
    })
  },

  patchGeometry: (patches) =>
    set({
      windows: get().windows.map((w) => {
        const p = patches[w.id]
        if (!p) return w
        const next: CanvasWindow = { ...w }
        if (p.position) next.position = { x: p.position.x, y: p.position.y }
        if (p.size) next.size = { w: p.size.w, h: p.size.h }
        if ('z' in p) {
          if (p.z === undefined) delete next.z
          else next.z = p.z
        }
        if ('locked' in p) {
          // An unlocked window carries no `locked` key, so a file that never used locking stays as it was.
          if (p.locked) next.locked = true
          else delete next.locked
        }
        return next
      }),
    }),

  setViewport: (viewport) => set({ viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom } }),

  canvasName: null,
  setCanvasName: (canvasName) => set({ canvasName }),
  loadState: (next) => {
    // Run state belongs to the windows of one open canvas. A reload of the same saved canvas (a live sync)
    // keeps the runs of windows that are still there.
    const keep = next.canvasName !== null && next.canvasName === get().canvasName
    if (keep) useRunStore.getState().clearExcept(new Set(next.windows.map((w) => w.id)))
    else useRunStore.getState().clearAll()
    set({
      canvasName: next.canvasName,
      viewport: { x: next.viewport.x, y: next.viewport.y, zoom: next.viewport.zoom },
      windows: next.windows,
      maximizedId: null,
    })
  },
}))
