// Moving Genie's SQL and tables into the rest of the app, through the stores the other tabs already use.
import { useCanvasStore } from '../store/canvasStore'
import { useUiStore } from '../store/uiStore'

/** Gap between the right edge of the canvas contents and a new window. */
const GAP = 40

/** Adds a query window holding `sql` to the right of everything on the canvas, and shows the Canvas tab. Returns the window id. */
export function openSqlInCanvas(sql: string): string {
  const canvas = useCanvasStore.getState()
  const right = canvas.windows.length ? Math.max(...canvas.windows.map((w) => w.position.x + w.size.w)) + GAP : 0
  const id = canvas.addQueryWindowWithSql({ x: right, y: 0 }, sql)
  useUiStore.getState().setView('canvas')
  return id
}
